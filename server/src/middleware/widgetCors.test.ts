import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { request } from '../__tests__/supertestClient.js';

import { createWidgetCors } from './widgetCors.js';
import { FakeApiKeyRepo } from '../__tests__/fakes/FakeApiKeyRepo.js';
import type { ApiKey } from '../domain/org/ports/ApiKeyRepo.js';

const ORG_ID = 'a0000000-0000-4000-8000-000000000001';
const PROJECT_ID = 'b0000000-0000-4000-8000-000000000001';
const WIDGET_RAW = 'pk_widget_deadbeef';
const WIDGET_HASH = createHash('sha256').update(WIDGET_RAW).digest('hex');

function widgetKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'k0000000-0000-0000-0000-000000000001',
    orgId: ORG_ID,
    name: 'widget',
    keyPrefix: 'pk_widget_',
    scopes: ['widget'],
    createdBy: 'u0000000-0000-0000-0000-000000000001',
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    keyType: 'widget',
    projectId: PROJECT_ID,
    allowedOrigins: [],
    dailyQuota: null,
    ...overrides,
  };
}

/** App mirroring container ordering: widget CORS ahead of a strict global CORS. */
function makeApp(apiKeyRepo: FakeApiKeyRepo) {
  const app = express();
  app.use('/api/v1/widget', createWidgetCors({ apiKeyRepo }));
  // Global strict credentialed CORS locked to the dashboard origin — but it
  // must skip the widget surface (mirrors composition/container.ts).
  const globalCors = cors({ origin: 'https://dashboard.pinpoint.app', credentials: true });
  app.use((req, res, next) => {
    if (req.path === '/api/v1/widget' || req.path.startsWith('/api/v1/widget/')) { next(); return; }
    globalCors(req, res, next);
  });
  app.use(express.json());
  app.post('/api/v1/widget/feedback', (_req, res) => res.status(201).json({ ok: true }));
  app.get('/api/v1/users/me', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('widgetCors (A2)', () => {
  let apiKeyRepo: FakeApiKeyRepo;

  beforeEach(() => {
    apiKeyRepo = new FakeApiKeyRepo();
  });

  it('reflects the Origin on a matching allow-list and never sends credentials', async () => {
    apiKeyRepo.seed(WIDGET_HASH, widgetKey({ allowedOrigins: ['https://customer.example'] }));
    const app = makeApp(apiKeyRepo);
    const res = await request(app)
      .post('/api/v1/widget/feedback')
      .set('Origin', 'https://customer.example')
      .set('X-Project-Key', WIDGET_RAW)
      .send({});
    expect(res.headers['access-control-allow-origin']).toBe('https://customer.example');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('reflects any Origin when the allow-list is empty (still credential-free)', async () => {
    apiKeyRepo.seed(WIDGET_HASH, widgetKey({ allowedOrigins: [] }));
    const app = makeApp(apiKeyRepo);
    const res = await request(app)
      .post('/api/v1/widget/feedback')
      .set('Origin', 'https://anywhere.test')
      .set('X-Project-Key', WIDGET_RAW)
      .send({});
    expect(res.headers['access-control-allow-origin']).toBe('https://anywhere.test');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does NOT reflect an Origin that is not on a non-empty allow-list', async () => {
    apiKeyRepo.seed(WIDGET_HASH, widgetKey({ allowedOrigins: ['https://customer.example'] }));
    const app = makeApp(apiKeyRepo);
    const res = await request(app)
      .post('/api/v1/widget/feedback')
      .set('Origin', 'https://evil.test')
      .set('X-Project-Key', WIDGET_RAW)
      .send({});
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // Browser-accurate preflights: a real preflight carries only the header
  // NAMES (Access-Control-Request-Headers), never the X-Project-Key VALUE.
  // The previous tests set X-Project-Key on OPTIONS, which no browser does —
  // that hid a bug where every real cross-origin preflight got 403.
  it('preflight without X-Project-Key (as browsers send it) is approved, credential-free', async () => {
    apiKeyRepo.seed(WIDGET_HASH, widgetKey({ allowedOrigins: ['https://customer.example'] }));
    const app = makeApp(apiKeyRepo);
    const res = await request(app)
      .options('/api/v1/widget/feedback')
      .set('Origin', 'https://customer.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-project-key');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://customer.example');
    expect(res.headers['access-control-allow-headers']).toMatch(/X-Project-Key/i);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('the actual POST from a disallowed origin gets no ACAO and is flagged for the route', async () => {
    apiKeyRepo.seed(WIDGET_HASH, widgetKey({ allowedOrigins: ['https://customer.example'] }));
    const app = express();
    app.use('/api/v1/widget', createWidgetCors({ apiKeyRepo }));
    app.post('/api/v1/widget/feedback', (req, res) =>
      res.json({ allowed: (req as express.Request & { widgetOriginAllowed?: boolean }).widgetOriginAllowed }));
    const res = await request(app)
      .post('/api/v1/widget/feedback')
      .set('Origin', 'https://evil.test')
      .set('X-Project-Key', WIDGET_RAW)
      .send({});
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.body.allowed).toBe(false);
  });

  it('leaves /api/v1/users/me under the strict global CORS (foreign origin not reflected)', async () => {
    apiKeyRepo.seed(WIDGET_HASH, widgetKey());
    const app = makeApp(apiKeyRepo);
    const res = await request(app)
      .get('/api/v1/users/me')
      .set('Origin', 'https://evil.test');
    // Global cors only reflects the dashboard origin; a foreign origin gets
    // no ACAO for the authenticated surface.
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.test');
  });
});
