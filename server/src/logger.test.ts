import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';

// Mirror the redaction config from logger.ts and assert sensitive keys are
// censored. We build a fresh logger writing into an in-memory stream so we can
// inspect the emitted JSON without touching the process-wide logger instance.

const REDACT_KEYS = [
  'authorization',
  'cookie',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'client_secret',
  'clientSecret',
  'password',
  'token',
];
const REDACT_PARENTS = ['', '*', 'headers', 'req.headers', 'res.headers', 'body', 'config', 'data', 'integration'];
const REDACT_PATHS = REDACT_PARENTS.flatMap((parent) =>
  REDACT_KEYS.map((key) => (parent === '' ? key : `${parent}.${key}`)),
);

function captureLog(obj: Record<string, unknown>): Record<string, unknown> {
  let captured = '';
  const sink = new Writable({
    write(chunk, _enc, cb) {
      captured += chunk.toString();
      cb();
    },
  });
  const log = pino({ redact: { paths: REDACT_PATHS, censor: '[Redacted]' } }, sink);
  log.info(obj, 'test');
  return JSON.parse(captured.trim());
}

describe('logger redaction', () => {
  it('redacts top-level sensitive keys', () => {
    const out = captureLog({
      authorization: 'Bearer abc',
      cookie: 'fl_session=xyz',
      access_token: 'at',
      accessToken: 'at2',
      refresh_token: 'rt',
      refreshToken: 'rt2',
      client_secret: 'cs',
      clientSecret: 'cs2',
      password: 'p',
      token: 't',
      safe: 'keep-me',
    });
    for (const key of REDACT_KEYS) {
      expect(out[key], `key ${key} should be redacted`).toBe('[Redacted]');
    }
    expect(out.safe).toBe('keep-me');
  });

  it('redacts nested integration/config/body/headers secrets', () => {
    const out = captureLog({
      integration: { access_token: 'secret', refresh_token: 'secret2' },
      config: { clientSecret: 'cs' },
      body: { password: 'p' },
      headers: { authorization: 'Bearer x', cookie: 'c' },
    });
    expect((out.integration as any).access_token).toBe('[Redacted]');
    expect((out.integration as any).refresh_token).toBe('[Redacted]');
    expect((out.config as any).clientSecret).toBe('[Redacted]');
    expect((out.body as any).password).toBe('[Redacted]');
    expect((out.headers as any).authorization).toBe('[Redacted]');
    expect((out.headers as any).cookie).toBe('[Redacted]');
  });

  it('redacts a secret under any top-level parent via wildcard', () => {
    const out = captureLog({ anything: { token: 'leak' } });
    expect((out.anything as any).token).toBe('[Redacted]');
  });
});

// ---------------------------------------------------------------------------
// F-04: the REAL production config (buildPinoOptions) driving pino-http — the
// exact wiring composition/container.ts uses — must not write credentials into
// access-log lines.
// ---------------------------------------------------------------------------
import express from 'express';
import pinoHttp from 'pino-http';
import { buildPinoOptions } from './logger.js';
import { request } from './__tests__/supertestClient.js';

describe('pino-http access log redaction (F-04)', () => {
  async function captureAccessLog(): Promise<string> {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const base = pino(buildPinoOptions('info'), sink);
    const app = express();
    app.use(pinoHttp({ logger: base }));
    app.use(express.json());
    app.post('/login', (req, res) => {
      // An errant log of the parsed body / headers must be redacted too.
      req.log.info({ body: req.body, req: { headers: req.headers } }, 'handler context');
      res.setHeader('Set-Cookie', ['fl_session=SESSION-SECRET; HttpOnly', 'fl_csrf=CSRF-SECRET']);
      res.json({ ok: true });
    });
    await request(app)
      .post('/login')
      .set('Authorization', 'Bearer BEARER-SECRET')
      .set('Cookie', 'fl_session=COOKIE-SECRET')
      .set('X-CSRF-Token', 'CSRF-HEADER-SECRET')
      .set('X-Project-Key', 'pk_widget_PROJECT-KEY-SECRET')
      .send({ email: 'a@b.test', password: 'PW-SECRET', token: 'TOKEN-SECRET', rawKey: 'RAW-SECRET', secret: 'S-SECRET', clientSecret: 'CS-SECRET' });
    // pino-http logs on 'finish'; give the event loop a tick.
    await new Promise((r) => setTimeout(r, 20));
    return lines.join('');
  }

  it('redacts authorization, cookie, x-csrf-token, x-project-key and set-cookie', async () => {
    const out = await captureAccessLog();
    expect(out).toContain('"responseTime"'); // the access-log line exists
    for (const secret of [
      'BEARER-SECRET',
      'COOKIE-SECRET',
      'CSRF-HEADER-SECRET',
      'PROJECT-KEY-SECRET',
      'SESSION-SECRET',
      'CSRF-SECRET',
    ]) {
      expect(out, `${secret} leaked into logs`).not.toContain(secret);
    }
    expect(out).toContain('[Redacted]');
  });

  it('redacts credential body fields (password/token/rawKey/secret/clientSecret)', async () => {
    const out = await captureAccessLog();
    for (const secret of ['PW-SECRET', 'TOKEN-SECRET', 'RAW-SECRET', 'S-SECRET', 'CS-SECRET']) {
      expect(out, `${secret} leaked into logs`).not.toContain(secret);
    }
    expect(out).toContain('a@b.test'); // non-sensitive fields are preserved
  });
});
