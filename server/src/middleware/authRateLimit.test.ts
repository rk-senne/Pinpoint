import { describe, it, expect, beforeEach } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

/**
 * Tests for the strict auth rate limiter (Task 8.2 / Requirements 19.1, 19.2, 19.3).
 *
 * The middleware exported from `./authRateLimit.ts` is a singleton with
 * an in-process `MemoryStore`, so importing it here would leak counters
 * between tests. To get full isolation we re-construct an equivalent
 * limiter from the same options in each test (the construction logic
 * itself is what we want to verify).
 *
 * The handler/keyGenerator/limit values below MUST stay in lock-step
 * with `authRateLimit.ts`; if you change one, change the other.
 */
function makeLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request): string => {
      const rawEmail =
        typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      const ipKey = ipKeyGenerator(req.ip ?? '');
      return `${ipKey}:${rawEmail}`;
    },
    handler: (_req: Request, res: Response): void => {
      res.status(429).json({
        error: {
          code: 'AUTH_RATE_LIMIT',
          message: 'Too many authentication attempts. Please wait and try again.',
        },
      });
    },
  });
}

function createApp() {
  const app = express();
  app.use(express.json());
  const limiter = makeLimiter();
  app.post('/auth/login', limiter, (_req, res) => res.status(200).json({ ok: true }));
  app.post('/auth/register', limiter, (_req, res) => res.status(201).json({ ok: true }));
  app.post('/shared/:linkId/verify', limiter, (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('authRateLimiter', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
  });

  it('allows up to 5 requests per (IP, email) pair within the 1-minute window (Req 19.1)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'user@example.com', password: 'pw' });
      expect(res.status).toBe(200);
    }
  });

  it('rejects the 6th request with 429 + Retry-After + AUTH_RATE_LIMIT envelope (Req 19.1, 19.2)', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/auth/login')
        .send({ email: 'user@example.com', password: 'pw' });
    }

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'user@example.com', password: 'pw' });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('AUTH_RATE_LIMIT');
    // The library sets `Retry-After: <seconds>` automatically when the
    // limit is exceeded (because `standardHeaders: true`). Req 19.2
    // requires the header to indicate the seconds until the window
    // resets — express-rate-limit emits exactly that.
    expect(res.headers['retry-after']).toBeDefined();
    const retryAfter = Number(res.headers['retry-after']);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it('keeps separate buckets per email from the same IP (an attacker grinding many accounts is throttled per-account)', async () => {
    // Burn 5 attempts on user-a. user-b on the same IP should still
    // get its own fresh budget.
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/auth/login')
        .send({ email: 'user-a@example.com', password: 'pw' });
    }

    const blocked = await request(app)
      .post('/auth/login')
      .send({ email: 'user-a@example.com', password: 'pw' });
    expect(blocked.status).toBe(429);

    const fresh = await request(app)
      .post('/auth/login')
      .send({ email: 'user-b@example.com', password: 'pw' });
    expect(fresh.status).toBe(200);
  });

  it('treats email casing as the same bucket (user@x.com == USER@X.com)', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/auth/login')
        .send({ email: 'mixed@example.com', password: 'pw' });
    }

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'MIXED@EXAMPLE.COM', password: 'pw' });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('AUTH_RATE_LIMIT');
  });

  it('shares the bucket across endpoints when (IP, email) match (an attacker can\'t reset the budget by switching endpoint)', async () => {
    // 5 hits on /auth/login then a /auth/register hit with the same
    // IP+email is the 6th request to the limiter and must be 429.
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/auth/login')
        .send({ email: 'shared-bucket@example.com', password: 'pw' });
    }

    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'shared-bucket@example.com', password: 'pw', name: 'X' });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('AUTH_RATE_LIMIT');
  });

  it('falls back to pure-IP keying when the request has no email (e.g. /shared/:linkId/verify)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/shared/some-link/verify')
        .send({ password: 'guess' });
      expect(res.status).toBe(200);
    }

    const blocked = await request(app)
      .post('/shared/some-link/verify')
      .send({ password: 'guess' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('AUTH_RATE_LIMIT');
  });
});
