import express from 'express';
import { describe, expect, it } from 'vitest';
import { request } from '../__tests__/supertestClient.js';
import helmet from 'helmet';
import { securityHeaders, buildHelmetOptions, API_DEFAULT_CSP } from './securityHeaders.js';

describe('securityHeaders middleware', () => {
  const app = express();
  app.use((req, _res, next) => { if (req.headers['x-test-id']) (req as unknown as { id: string }).id = String(req.headers['x-test-id']); next(); });
  app.use(securityHeaders);
  app.get('/', (_q, r) => { r.json({}); });

  it('sets framing, referrer and permissions policies', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['permissions-policy']).toContain('payment=()');
    expect(res.headers['permissions-policy']).toContain('usb=()');
  });

  it('sends a deny-everything CSP on API responses (document routes override it later)', async () => {
    const res = await request(app).get('/');
    expect(res.headers['content-security-policy']).toBe(API_DEFAULT_CSP);
    expect(API_DEFAULT_CSP).toContain("default-src 'none'");
    expect(API_DEFAULT_CSP).toContain("frame-ancestors 'none'");
    expect(API_DEFAULT_CSP).toContain("base-uri 'none'");
    expect(API_DEFAULT_CSP).toContain("form-action 'none'");
  });

  it('a route-level CSP replaces the default (review proxy / screenshots)', async () => {
    const a = express();
    a.use(securityHeaders);
    a.get('/doc', (_q, r) => { r.setHeader('Content-Security-Policy', 'sandbox'); r.send('x'); });
    expect((await request(a).get('/doc')).headers['content-security-policy']).toBe('sandbox');
  });

  it('HSTS is preload-ready on HTTPS deployments and absent on the plain-http local stack', async () => {
    const mk = (insecure: boolean) => {
      const a = express();
      a.use(helmet(buildHelmetOptions(insecure)));
      a.get('/', (_q, r) => { r.json({}); });
      return a;
    };
    const secure = (await request(mk(false)).get('/')).headers['strict-transport-security'];
    expect(secure).toBe('max-age=63072000; includeSubDomains; preload');
    expect((await request(mk(true)).get('/')).headers['strict-transport-security']).toBeUndefined();
  });

  it('echoes the request id when present, otherwise mints a UUID', async () => {
    expect((await request(app).get('/').set('x-test-id', 'req-123')).headers['x-request-id']).toBe('req-123');
    expect((await request(app).get('/')).headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
