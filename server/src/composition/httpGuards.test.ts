import { describe, it, expect } from 'vitest';
import express from 'express';
import { request } from '../__tests__/supertestClient.js';
import { createErrorHandler, uuidPathGuard } from './httpGuards.js';
import { StorageUnavailableError } from '../domain/annotation/ports/ScreenshotStore.js';

const UUID = '0b7c1f2e-1111-4222-8333-444455556666';

function appWith(opts: { nodeEnv: string; exposed: boolean }) {
  const app = express();
  app.get('/boom', () => {
    throw Object.assign(new Error('relation "users" does not exist; SELECT * FROM users'), { code: '42P01' });
  });
  app.use(createErrorHandler(opts));
  return app;
}

describe('global error handler (F-14)', () => {
  it.each([
    { nodeEnv: 'production', exposed: true },
    { nodeEnv: 'development', exposed: true }, // dev build exposed on a network
    { nodeEnv: 'test', exposed: false },
  ])('never leaks err.message / pg code / stack: %o', async (o) => {
    const res = await request(appWith(o)).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(res.text).not.toContain('SELECT');
    expect(res.text).not.toContain('42P01');
  });

  it('includes the stack only for NODE_ENV=development on a non-exposed deployment', async () => {
    const res = await request(appWith({ nodeEnv: 'development', exposed: false })).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('Internal server error');
    expect(typeof res.body.error.details.stack).toBe('string');
  });

  it('keeps 4xx body-parser errors as safe client errors', async () => {
    const app = express();
    app.use(express.json());
    app.post('/x', (_q, r) => r.json({}));
    app.use(createErrorHandler({ nodeEnv: 'production', exposed: true }));
    const res = await request(app).post('/x').set('content-type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('global error handler — storage outage', () => {
  it('maps StorageUnavailableError to 503 UNAVAILABLE without leaking the cause', async () => {
    const app = express();
    app.get('/s', () => {
      throw new StorageUnavailableError('x', new Error('connect ECONNREFUSED 10.0.0.5:9000'));
    });
    app.use(createErrorHandler({ nodeEnv: 'production', exposed: true }));
    const res = await request(app).get('/s');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('UNAVAILABLE');
    expect(res.text).not.toContain('10.0.0.5');
  });
});

describe('uuidPathGuard (F-14)', () => {
  const app = express();
  app.use('/api/v1', uuidPathGuard);
  app.use((_req, res) => res.status(200).json({ reached: true }));

  it.each([
    '/api/v1/projects/not-a-uuid',
    '/api/v1/projects/1;DROP TABLE x',
    '/api/v1/annotations/123',
    '/api/v1/teams/abc/members',
    '/api/v1/webhooks/zzz',
    '/api/v1/api-keys/%E0%A4%A',
  ])('400s malformed id: %s', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ID');
  });

  it.each([
    `/api/v1/projects/${UUID}`,
    `/api/v1/projects/${UUID.toUpperCase()}/annotations`,
    `/api/v1/annotations/${UUID}/comments`,
    `/api/v1/teams/${UUID}/members/${UUID}`,
    `/api/v1/webhooks/${UUID}/deliveries`,
    `/api/v1/api-keys/${UUID}`,
    '/api/v1/projects',
    '/api/v1/projects/by-url?url=https%3A%2F%2Fa.test',
    '/api/v1/webhooks/events',
    '/api/v1/annotations',
  ])('lets %s through', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
  });

  it('does not touch non-UUID shared-link / review-link ids or other areas', async () => {
    for (const path of [
      '/api/v1/shared/abc-DEF_123/feedback',
      '/api/v1/shared/xyz',
      '/api/v1/auth/login',
      '/api/v1/users/me',
      '/api/v1/org/members',
    ]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(200);
    }
  });
});
