import { describe, it, expect } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { csrfMiddleware } from './csrf.js';

/**
 * Tests for Task 7.2 / Requirements 18.4, 18.5, 18.6, 18.7.
 *
 * The middleware enforces double-submit (`X-CSRF-Token` header == `fl_csrf`
 * cookie) on `POST/PUT/PATCH/DELETE` requests that carry a Dashboard
 * `fl_session` cookie. Bearer-only requests (Extension) and pre-session
 * requests (login/register) are exempt.
 */
function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(csrfMiddleware);

  // A handler for every method we exercise, so a successful pass-through
  // produces a 200 we can assert on.
  const ok = (_req: express.Request, res: express.Response): void => {
    res.json({ ok: true });
  };
  app.get('/echo', ok);
  app.post('/echo', ok);
  app.put('/echo', ok);
  app.patch('/echo', ok);
  app.delete('/echo', ok);
  return app;
}

describe('csrfMiddleware', () => {
  describe('exempt: non-mutating methods', () => {
    it('GET passes through without any token (Req 18.4 — only POST/PUT/PATCH/DELETE)', async () => {
      const res = await request(createApp()).get('/echo');
      expect(res.status).toBe(200);
    });
  });

  describe('exempt: Bearer-only requests (Extension, Req 18.6, 18.7)', () => {
    it('POST with Bearer and no fl_session cookie passes through', async () => {
      const res = await request(createApp())
        .post('/echo')
        .set('Authorization', 'Bearer some.jwt.value')
        .send({});
      expect(res.status).toBe(200);
    });

    it('DELETE with Bearer and no fl_session cookie passes through', async () => {
      const res = await request(createApp())
        .delete('/echo')
        .set('Authorization', 'Bearer some.jwt.value');
      expect(res.status).toBe(200);
    });

    it('PUT with no auth at all (pre-session) passes through', async () => {
      // login/register/refresh/reset-password are exercised before any
      // session cookie exists. The middleware MUST NOT block them.
      const res = await request(createApp()).put('/echo').send({});
      expect(res.status).toBe(200);
    });
  });

  describe('enforced: cookie-session requests (Req 18.5)', () => {
    it('POST with fl_session and matching X-CSRF-Token == fl_csrf passes', async () => {
      const csrf = 'matching-csrf-value';
      const res = await request(createApp())
        .post('/echo')
        .set('Cookie', `fl_session=session.jwt; fl_csrf=${csrf}`)
        .set('X-CSRF-Token', csrf)
        .send({});
      expect(res.status).toBe(200);
    });

    it('POST with fl_session and missing X-CSRF-Token rejects with 403 CSRF_INVALID', async () => {
      const res = await request(createApp())
        .post('/echo')
        .set('Cookie', 'fl_session=session.jwt; fl_csrf=cookie-value')
        .send({});
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: { code: 'CSRF_INVALID', message: 'CSRF token mismatch.' },
      });
    });

    it('POST with fl_session and mismatched X-CSRF-Token rejects with 403', async () => {
      const res = await request(createApp())
        .post('/echo')
        .set('Cookie', 'fl_session=session.jwt; fl_csrf=cookie-value')
        .set('X-CSRF-Token', 'header-value-different')
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_INVALID');
    });

    it('POST with fl_session and X-CSRF-Token but no fl_csrf cookie rejects with 403', async () => {
      const res = await request(createApp())
        .post('/echo')
        .set('Cookie', 'fl_session=session.jwt')
        .set('X-CSRF-Token', 'orphan-header')
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_INVALID');
    });

    it('PATCH and DELETE with matching tokens pass; mismatched are rejected', async () => {
      const app = createApp();
      const csrf = 'csrf-abc';
      const cookie = `fl_session=jwt; fl_csrf=${csrf}`;

      const okPatch = await request(app)
        .patch('/echo')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrf)
        .send({});
      expect(okPatch.status).toBe(200);

      const badDelete = await request(app)
        .delete('/echo')
        .set('Cookie', cookie)
        .set('X-CSRF-Token', 'wrong');
      expect(badDelete.status).toBe(403);
    });
  });
});
