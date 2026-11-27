import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { request } from '../__tests__/supertestClient.js';
import { mfaRateLimiter } from './authRateLimit.js';

describe('mfaRateLimiter', () => {
  const prev = process.env.MFA_RATE_LIMIT_MAX;
  afterEach(() => {
    if (prev === undefined) delete process.env.MFA_RATE_LIMIT_MAX;
    else process.env.MFA_RATE_LIMIT_MAX = prev;
  });

  it('throttles one IP to MFA_RATE_LIMIT_MAX requests/min with a Retry-After and the AUTH_RATE_LIMIT envelope', async () => {
    process.env.MFA_RATE_LIMIT_MAX = '3';
    const app = express();
    app.use(express.json());
    app.post('/login/mfa', mfaRateLimiter, (_q, r) => { r.json({ ok: true }); });
    for (let i = 0; i < 3; i++) expect((await request(app).post('/login/mfa').send({})).status).toBe(200);
    const blocked = await request(app).post('/login/mfa').send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('AUTH_RATE_LIMIT');
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});
