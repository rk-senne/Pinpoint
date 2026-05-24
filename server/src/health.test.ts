import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { legacyApiCatchAll } from './middleware/legacyApi.js';

/**
 * Health-endpoint tests for the heartbeat consumed by the Extension's
 * `connectionMonitor` (task 36.8 / Req 44.1).
 *
 * The test rebuilds a minimal app mirroring `server/src/index.ts`'s
 * route ordering — the `/api/v1/health` route is registered BEFORE the
 * legacy `/api/*` 410 catch-all so it survives the sweep, and inside the
 * `/api/v1` namespace so the Extension only has to know `API_BASE`. Mounting
 * the full app would pull in the database / mailer config; this slim
 * harness keeps the test hermetic.
 */
function makeApp(): express.Express {
  const app = express();

  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Legacy catch-all comes after the v1 health route so any other
  // /api/* request still returns 410.
  app.use('/api', legacyApiCatchAll);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}

describe('/api/v1/health (heartbeat — Req 44.1, task 36.8)', () => {
  it('responds 200 with `{status:"ok"}` on GET', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('responds 200 on HEAD (Express auto-derives HEAD from GET)', async () => {
    const app = makeApp();
    const res = await request(app).head('/api/v1/health');
    expect(res.status).toBe(200);
    // HEAD responses carry no body — supertest exposes an empty body.
    expect(res.body).toEqual({});
  });

  it('does NOT fall through to the legacy 410 catch-all', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/v1/health');
    expect(res.status).not.toBe(410);
    expect(res.body?.error?.code).toBeUndefined();
  });

  it('preserves the legacy /health probe alongside the versioned one', async () => {
    const app = makeApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
