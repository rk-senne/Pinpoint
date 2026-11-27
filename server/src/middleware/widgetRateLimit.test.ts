import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../__tests__/supertestClient.js';

import {
  createWidgetRateLimit,
  __resetWidgetRateLimitMemory,
  type WidgetRateLimitRedis,
} from './widgetRateLimit.js';
import type { ApiKey } from '../domain/org/ports/ApiKeyRepo.js';

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'k1',
    orgId: 'o1',
    name: 'widget',
    keyPrefix: 'pk_widget_',
    scopes: ['widget'],
    createdBy: 'u1',
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    keyType: 'widget',
    projectId: 'p1',
    allowedOrigins: [],
    dailyQuota: null,
    ...overrides,
  };
}

/** In-memory Redis fake implementing INCR + EXPIRE. */
function fakeRedis(): WidgetRateLimitRedis & { fail: boolean; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    fail: false,
    counts,
    async incr(k: string) {
      if (this.fail) throw new Error('redis down');
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return n;
    },
    async expire() {
      if (this.fail) throw new Error('redis down');
    },
  };
}

function makeApp(apiKey: ApiKey, mw: express.RequestHandler) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).apiKey = apiKey;
    next();
  });
  app.use(mw);
  app.post('/f', (_req, res) => res.status(201).json({ ok: true }));
  return app;
}

describe('widgetRateLimit (A3)', () => {
  beforeEach(() => __resetWidgetRateLimitMemory());

  it('allows up to `max` per window then 429 with Retry-After (in-memory)', async () => {
    const mw = createWidgetRateLimit(
      { getApiKey: (req) => (req as any).apiKey },
      { store: 'memory', max: 2, windowMs: 60_000 },
    );
    const app = makeApp(key(), mw);

    expect((await request(app).post('/f')).status).toBe(201);
    expect((await request(app).post('/f')).status).toBe(201);
    const res = await request(app).post('/f');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('enforces the per-key daily quota independently of the window', async () => {
    const mw = createWidgetRateLimit(
      { getApiKey: (req) => (req as any).apiKey },
      { store: 'memory', max: 100, windowMs: 60_000 },
    );
    const app = makeApp(key({ dailyQuota: 2 }), mw);

    expect((await request(app).post('/f')).status).toBe(201);
    expect((await request(app).post('/f')).status).toBe(201);
    const res = await request(app).post('/f');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('is fail-CLOSED when Redis errors (default)', async () => {
    const redis = fakeRedis();
    redis.fail = true;
    const mw = createWidgetRateLimit(
      { getApiKey: (req) => (req as any).apiKey },
      { store: 'redis', redis, max: 5 },
    );
    const app = makeApp(key(), mw);
    const res = await request(app).post('/f');
    expect(res.status).toBe(429);
  });

  it('can fail-open when explicitly configured', async () => {
    const redis = fakeRedis();
    redis.fail = true;
    const mw = createWidgetRateLimit(
      { getApiKey: (req) => (req as any).apiKey },
      { store: 'redis', redis, max: 5, failMode: 'open' },
    );
    const app = makeApp(key(), mw);
    const res = await request(app).post('/f');
    expect(res.status).toBe(201);
  });

  it('counts per key via Redis INCR and 429s past max', async () => {
    const redis = fakeRedis();
    const mw = createWidgetRateLimit(
      { getApiKey: (req) => (req as any).apiKey },
      { store: 'redis', redis, max: 1, windowMs: 60_000 },
    );
    const app = makeApp(key(), mw);
    expect((await request(app).post('/f')).status).toBe(201);
    expect((await request(app).post('/f')).status).toBe(429);
  });

  // --- Mission A7: pluggable identity resolver + key prefix ---------------

  it('supports a generic getIdentity resolver (keyed by an arbitrary id)', async () => {
    const mw = createWidgetRateLimit(
      { getIdentity: () => ({ id: 'link-xyz', dailyQuota: null }) },
      { store: 'memory', max: 1, windowMs: 60_000, keyPrefix: 'grl' },
    );
    const app = express();
    app.use(mw);
    app.post('/f', (_req, res) => res.status(201).json({ ok: true }));
    expect((await request(app).post('/f')).status).toBe(201);
    expect((await request(app).post('/f')).status).toBe(429);
  });

  it('enforces a per-identity daily quota via getIdentity', async () => {
    const mw = createWidgetRateLimit(
      { getIdentity: () => ({ id: 'link-q', dailyQuota: 2 }) },
      { store: 'memory', max: 100, windowMs: 60_000, keyPrefix: 'grl' },
    );
    const app = express();
    app.use(mw);
    app.post('/f', (_req, res) => res.status(201).json({ ok: true }));
    expect((await request(app).post('/f')).status).toBe(201);
    expect((await request(app).post('/f')).status).toBe(201);
    expect((await request(app).post('/f')).status).toBe(429);
  });

  it('keyPrefix namespaces counters so distinct surfaces never collide', async () => {
    // Same identity id under two prefixes must count independently.
    const widgetMw = createWidgetRateLimit(
      { getIdentity: () => ({ id: 'shared-id', dailyQuota: null }) },
      { store: 'memory', max: 1, windowMs: 60_000, keyPrefix: 'wrl' },
    );
    const guestMw = createWidgetRateLimit(
      { getIdentity: () => ({ id: 'shared-id', dailyQuota: null }) },
      { store: 'memory', max: 1, windowMs: 60_000, keyPrefix: 'grl' },
    );
    const app = express();
    app.post('/w', widgetMw, (_req, res) => res.status(201).json({ ok: true }));
    app.post('/g', guestMw, (_req, res) => res.status(201).json({ ok: true }));

    expect((await request(app).post('/w')).status).toBe(201);
    // Guest surface has its own counter despite the identical id.
    expect((await request(app).post('/g')).status).toBe(201);
    // Each surface is now at its own cap.
    expect((await request(app).post('/w')).status).toBe(429);
    expect((await request(app).post('/g')).status).toBe(429);
  });

  it('skips counting when getIdentity returns undefined', async () => {
    const mw = createWidgetRateLimit(
      { getIdentity: () => undefined },
      { store: 'memory', max: 1, windowMs: 60_000, keyPrefix: 'grl' },
    );
    const app = express();
    app.use(mw);
    app.post('/f', (_req, res) => res.status(201).json({ ok: true }));
    expect((await request(app).post('/f')).status).toBe(201);
    expect((await request(app).post('/f')).status).toBe(201);
  });
});
