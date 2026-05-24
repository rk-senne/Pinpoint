import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { legacyApiCatchAll } from './legacyApi.js';

/**
 * Tests for Requirement 25.2: legacy `/api/*` catch-all returns 410.
 *
 * The middleware sits AFTER the real `/api/v1/*` routers, so we
 * simulate the same composition here: a fake v1 auth route, then the
 * catch-all mounted at `/api`.
 */
function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  // Stand-in for the real /api/v1/auth router.
  const v1Auth = express.Router();
  v1Auth.post('/login', (_req, res) => {
    res.json({ ok: true, route: 'v1-auth-login' });
  });
  app.use('/api/v1/auth', v1Auth);

  // Catch-all for legacy /api/* paths.
  app.use('/api', legacyApiCatchAll);

  return app;
}

describe('legacyApiCatchAll (Requirement 25.2)', () => {
  it('returns 410 with the documented JSON envelope for /api/whatever', async () => {
    const app = createApp();
    const res = await request(app).get('/api/whatever');

    expect(res.status).toBe(410);
    expect(res.body).toEqual({
      error: {
        code: 'API_VERSION_REMOVED',
        message: 'This endpoint moved to /api/v1.',
        newPath: '/api/v1/whatever',
      },
    });
  });

  it('rewrites nested legacy paths under the v1 prefix', async () => {
    const app = createApp();
    const res = await request(app).post('/api/projects/abc/annotations');

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('API_VERSION_REMOVED');
    expect(res.body.error.newPath).toBe('/api/v1/projects/abc/annotations');
  });

  it('does NOT intercept /api/v1/* requests', async () => {
    const app = createApp();
    const res = await request(app).post('/api/v1/auth/login').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, route: 'v1-auth-login' });
  });

  it('passes through unknown /api/v1/* paths so the default 404 fires (not a 410)', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/does-not-exist');

    // Unknown v1 path should NOT be reported as a removed legacy endpoint.
    expect(res.status).not.toBe(410);
    expect(res.status).toBe(404);
  });
});
