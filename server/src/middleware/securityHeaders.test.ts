import express from 'express';
import { describe, expect, it } from 'vitest';
import { request } from '../__tests__/supertestClient.js';
import { securityHeaders } from './securityHeaders.js';

describe('securityHeaders middleware', () => {
  const app = express();
  app.use((req, _res, next) => { if (req.headers['x-test-id']) (req as unknown as { id: string }).id = String(req.headers['x-test-id']); next(); });
  app.use(securityHeaders);
  app.get('/', (_q, r) => { r.json({}); });

  it('sets framing, referrer and permissions policies', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('echoes the request id when present, otherwise mints a UUID', async () => {
    expect((await request(app).get('/').set('x-test-id', 'req-123')).headers['x-request-id']).toBe('req-123');
    expect((await request(app).get('/')).headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
