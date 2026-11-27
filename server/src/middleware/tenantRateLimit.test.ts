import { describe, it, expect } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { request } from '../__tests__/supertestClient.js';
import { orgIdFromVerifiedToken, tenantRateLimit, type RedisRateLimitClient } from './tenantRateLimit.js';

// Fake verifier: "org-a.<anything>" → org-a; anything else is invalid.
const verifier = {
  verify(token: string) {
    const m = /^(org-[a-z0-9]+)\.ok$/.exec(token);
    if (!m) throw new Error('bad token');
    return { orgId: m[1] };
  },
};

/** Mounted exactly like the container: app-wide, BEFORE any auth middleware. */
function makeApp(max: number, redis?: RedisRateLimitClient) {
  const app = express();
  app.use(cookieParser());
  app.use(
    '/api/v1',
    tenantRateLimit({ maxTokens: max, refillRate: max / 3_600_000 }, redis, orgIdFromVerifiedToken(verifier)),
  );
  app.get('/api/v1/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('tenantRateLimit (F-22) — runs before auth, identifies tenant from the verified token', () => {
  it('decrements for an authenticated org (Bearer) and 429s once the bucket is empty', async () => {
    const app = makeApp(3);
    const auth = { Authorization: 'Bearer org-a.ok' };

    const r1 = await request(app).get('/api/v1/ping').set(auth);
    const r2 = await request(app).get('/api/v1/ping').set(auth);
    expect(r1.status).toBe(200);
    expect(Number(r1.headers['x-ratelimit-remaining'])).toBe(2);
    expect(Number(r2.headers['x-ratelimit-remaining'])).toBe(1);

    expect((await request(app).get('/api/v1/ping').set(auth)).status).toBe(200);
    const blocked = await request(app).get('/api/v1/ping').set(auth);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TENANT_RATE_LIMIT');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('identifies the org from the fl_session cookie too', async () => {
    const app = makeApp(1);
    const cookie = 'fl_session=org-b.ok';
    expect((await request(app).get('/api/v1/ping').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get('/api/v1/ping').set('Cookie', cookie)).status).toBe(429);
  });

  it('buckets are per organisation: exhausting org-a does not affect org-b', async () => {
    const app = makeApp(1);
    await request(app).get('/api/v1/ping').set('Authorization', 'Bearer org-a.ok');
    expect((await request(app).get('/api/v1/ping').set('Authorization', 'Bearer org-a.ok')).status).toBe(429);
    expect((await request(app).get('/api/v1/ping').set('Authorization', 'Bearer org-b.ok')).status).toBe(200);
  });

  it('forged / invalid tokens are not attributed to a tenant (cannot drain another org) and pass through', async () => {
    const app = makeApp(1);
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/v1/ping').set('Authorization', 'Bearer org-a.forged');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
    }
    // org-a's real budget is untouched.
    expect((await request(app).get('/api/v1/ping').set('Authorization', 'Bearer org-a.ok')).status).toBe(200);
  });

  it('unauthenticated requests pass through', async () => {
    const res = await request(makeApp(1)).get('/api/v1/ping');
    expect(res.status).toBe(200);
  });

  it('redis path: counts per org and rejects over the ceiling', async () => {
    const counts = new Map<string, number>();
    const redis: RedisRateLimitClient = {
      async incr(k) { const n = (counts.get(k) ?? 0) + 1; counts.set(k, n); return n; },
      async expire() { /* noop */ },
    };
    const app = makeApp(2, redis);
    const auth = { Authorization: 'Bearer org-a.ok' };
    expect((await request(app).get('/api/v1/ping').set(auth)).status).toBe(200);
    expect((await request(app).get('/api/v1/ping').set(auth)).status).toBe(200);
    expect((await request(app).get('/api/v1/ping').set(auth)).status).toBe(429);
    expect(counts.get('rl:org-a')).toBe(3);
  });
});
