/**
 * Flow: register a webhook for `annotation.created` → create an annotation →
 * the durable delivery worker POSTs a Standard-Webhooks-signed request to a
 * local receiver → verify the signature (HMAC-SHA256 over `id.timestamp.body`,
 * key = base64-decoded secret after the `whsec_` prefix) and the payload.
 *
 * The dashboard has no webhook-management UI (nothing under dashboard/src
 * calls /api/v1/webhooks), so the endpoint is registered through the API.
 *
 * The API's SSRF egress guard (server/src/services/egressGuard.ts) blocks
 * loopback/private targets by design — also in development. A receiver on
 * 127.0.0.1 is therefore rejected at registration; the spec skips with that
 * reason. To run it for real, bind the receiver to an address the guard
 * treats as public that is still reachable from this machine, e.g.
 *   sudo ifconfig lo0 alias 198.51.100.7
 *   FL_WEBHOOK_RECEIVER_HOST=198.51.100.7 npx playwright test …
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';

import { type ApiClient, type CreatedProject, createAnnotation, createProject, deleteProject, makeApiClient, uniqueSuffix } from '../browser/helpers.js';

const RECEIVER_HOST = process.env.FL_WEBHOOK_RECEIVER_HOST ?? '127.0.0.1';

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

/** Independent re-implementation of the Standard Webhooks check. */
function signatureValid(secret: string, headers: IncomingHttpHeaders, body: string): boolean {
  const id = String(headers['webhook-id'] ?? '');
  const ts = String(headers['webhook-timestamp'] ?? '');
  const sigHeader = String(headers['webhook-signature'] ?? '');
  if (!id || !ts || !secret.startsWith('whsec_')) return false;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest();
  return sigHeader.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

test.describe('webhook delivery', () => {
  let api: ApiClient | null;
  let project: CreatedProject | null = null;
  let server: Server | null = null;
  let webhookId: string | null = null;
  const received: Received[] = [];

  test.beforeAll(async () => {
    api = await makeApiClient();
    if (!api) return;
    project = await createProject(api, { name: `wh-flow-${uniqueSuffix()}`, urls: ['https://example.com/'] });
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, RECEIVER_HOST, resolve); // random free port
    });
  });

  test.afterAll(async () => {
    if (api && webhookId) await api.ctx.delete(`/api/v1/webhooks/${webhookId}`).catch(() => {});
    if (api && project) await deleteProject(api, project).catch(() => {});
    await api?.dispose();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  test('annotation.created → signed POST with the annotation id', async () => {
    test.skip(!api || !project || !server, 'Seed session unavailable.');
    test.setTimeout(60_000);
    const { port } = server!.address() as AddressInfo;
    const url = `http://${RECEIVER_HOST}:${port}/hook`;

    const reg = await api!.ctx.post('/api/v1/webhooks', { data: { url, events: ['annotation.created'] } });
    const regText = await reg.text();
    test.skip(
      reg.status() === 400 && /Blocked/.test(regText),
      `SSRF egress guard rejects the local receiver (${RECEIVER_HOST}): ${regText}. Set FL_WEBHOOK_RECEIVER_HOST to a guard-public, locally reachable address.`,
    );
    expect(reg.status(), regText).toBe(201);
    const endpoint = (JSON.parse(regText) as { webhook: { id: string; secret: string } }).webhook;
    webhookId = endpoint.id;
    // The signing secret is shown exactly once, here.
    expect(endpoint.secret).toMatch(/^whsec_[A-Za-z0-9+/=]{40,}$/);
    const list = await api!.ctx.get('/api/v1/webhooks');
    expect(await list.text()).not.toContain(endpoint.secret);

    const annotation = await createAnnotation(api!, project!.id, 'https://example.com/', {
      body: `webhook flow ${uniqueSuffix()}`,
    });

    // The delivery worker polls (default 5 s) → allow up to ~30 s.
    await expect
      .poll(() => received.some((r) => r.body.includes(annotation.id)), { timeout: 30_000, intervals: [500, 1000, 2000] })
      .toBe(true);
    const hit = received.find((r) => r.body.includes(annotation.id))!;

    expect(hit.headers['webhook-id']).toBeTruthy();
    expect(Number(hit.headers['webhook-timestamp'])).toBeGreaterThan(Date.now() / 1000 - 300);
    expect(String(hit.headers['webhook-signature'])).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect(signatureValid(endpoint.secret, hit.headers, hit.body)).toBe(true);
    // A tampered body must not verify.
    expect(signatureValid(endpoint.secret, hit.headers, `${hit.body} `)).toBe(false);

    const payload = JSON.parse(hit.body) as Record<string, unknown>;
    expect(JSON.stringify(payload)).toContain(annotation.id);
  });
});
