// Integration test for safeFetch against a REAL local HTTP server (F-08).
//
// A fake public hostname is mapped to 127.0.0.1 through the injected `lookup`
// and the test-only `allowPrivateForTests` flag (honoured only under
// NODE_ENV=test, never wired from config). This exercises the real undici
// Agent + pinned `lookup` on the running Node version — the path that threw
// ERR_INVALID_IP_ADDRESS on Node 26 when the lookup ignored `opts.all`.
//
// IP-literal redirect targets (127.0.0.1, 169.254.169.254) are always checked,
// even with the flag on.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EgressBlockedError, safeFetch, type EgressGuardOptions } from './egressGuard.js';

let server: http.Server;
let port = 0;
const seen: Array<{ url: string; host: string | undefined; auth: string | undefined }> = [];

const FAKE_HOST = 'public-looking.test';
const OTHER_HOST = 'other-public.test';

function opts(): EgressGuardOptions {
  return {
    allowHttp: true,
    allowPrivateForTests: true,
    lookup: async (host) => {
      if (host === FAKE_HOST || host === OTHER_HOST) return [{ address: '127.0.0.1', family: 4 }];
      throw new Error('ENOTFOUND');
    },
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', host: req.headers.host, auth: req.headers.authorization });
    const u = req.url ?? '';
    if (u === '/ok') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello from origin');
    } else if (u === '/to-imds') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    } else if (u === '/to-loopback') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/ok` });
      res.end();
    } else if (u === '/to-ok') {
      res.writeHead(302, { location: '/ok' });
      res.end();
    } else if (u === '/to-other-host') {
      res.writeHead(302, { location: `http://${OTHER_HOST}:${port}/ok` });
      res.end();
    } else if (u.startsWith('/loop')) {
      res.writeHead(302, { location: `/loop${Math.random().toString(36).slice(2)}` });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('safeFetch — real server (Node ' + process.version + ')', () => {
  it('(a) completes a real fetch end to end through the pinned lookup', async () => {
    const res = await safeFetch(`http://${FAKE_HOST}:${port}/ok`, {}, opts());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello from origin');
    // The Host header is the logical hostname, the socket went to 127.0.0.1.
    expect(seen.at(-1)?.host).toBe(`${FAKE_HOST}:${port}`);
  });

  it('follows a same-host relative redirect manually', async () => {
    const res = await safeFetch(`http://${FAKE_HOST}:${port}/to-ok`, {}, opts());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello from origin');
  });

  it('re-validates + re-pins a redirect to another (public-looking) hostname and strips Authorization cross-origin', async () => {
    const res = await safeFetch(
      `http://${FAKE_HOST}:${port}/to-other-host`,
      { headers: { Authorization: 'Bearer secret' } },
      opts(),
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(seen.at(-1)?.host).toBe(`${OTHER_HOST}:${port}`);
    expect(seen.at(-1)?.auth).toBeUndefined();
  });

  it('(b) blocks a 302 to the cloud metadata IP', async () => {
    const before = seen.length;
    await expect(safeFetch(`http://${FAKE_HOST}:${port}/to-imds`, {}, opts())).rejects.toThrow(
      EgressBlockedError,
    );
    // Only the first hop reached the server; nothing connected to IMDS.
    expect(seen.length).toBe(before + 1);
  });

  it('(b) blocks a 302 to a loopback IP literal even with the test flag on', async () => {
    const before = seen.length;
    await expect(safeFetch(`http://${FAKE_HOST}:${port}/to-loopback`, {}, opts())).rejects.toThrow(
      /Blocked IP address/,
    );
    expect(seen.length).toBe(before + 1);
  });

  it('caps redirects at 3', async () => {
    await expect(safeFetch(`http://${FAKE_HOST}:${port}/loop`, {}, opts())).rejects.toThrow(
      /Too many redirects/,
    );
  });

  it("redirect: 'manual' returns the 3xx to the caller untouched (review proxy contract)", async () => {
    const res = await safeFetch(`http://${FAKE_HOST}:${port}/to-imds`, { redirect: 'manual' }, opts());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://169.254.169.254/latest/meta-data/');
  });

  it("redirect: 'error' rejects on any redirect", async () => {
    await expect(
      safeFetch(`http://${FAKE_HOST}:${port}/to-ok`, { redirect: 'error' }, opts()),
    ).rejects.toThrow(EgressBlockedError);
  });

  it('still refuses a private hostname resolution without the test flag', async () => {
    const { allowPrivateForTests: _drop, ...noFlag } = opts();
    await expect(safeFetch(`http://${FAKE_HOST}:${port}/ok`, {}, noFlag)).rejects.toThrow(
      /Blocked resolved address/,
    );
  });

  it('refuses allowPrivateForTests outside NODE_ENV=test', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(safeFetch(`http://${FAKE_HOST}:${port}/ok`, {}, opts())).rejects.toThrow(
        /only honoured when NODE_ENV=test/,
      );
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
