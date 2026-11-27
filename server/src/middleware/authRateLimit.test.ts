import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../__tests__/supertestClient.js';
import { createAuthRateLimiter } from './authRateLimit.js';

/**
 * Tests for the strict auth rate limiter (Req 19.1-19.3, F-09). Uses the real
 * `createAuthRateLimiter` factory (fresh in-memory stores per call) so these
 * tests exercise production code, not a copy of its options.
 */
function createApp() {
  const app = express();
  // Determinism: under heavy parallel test load, supertest's ephemeral
  // servers can surface the loopback client as IPv4 (`127.0.0.1`) for some
  // requests and IPv6 (`::ffff:127.0.0.1` / `::1`) for others within the same
  // test. Because the limiter keys on `ipKeyGenerator(req.ip)`, that split
  // the (IP, email) bucket and made the "6th request is 429" assertions
  // flaky. Trust a forwarded header and pin a single client IP so every
  // request in a test shares one bucket — matching how the limiter behaves
  // behind a real proxy, and keeping the per-email/per-endpoint intent intact.
  app.set('trust proxy', true);
  app.use((req, _res, next) => {
    req.headers['x-forwarded-for'] = '198.51.100.10';
    next();
  });
  app.use(express.json());
  const limiter = createAuthRateLimiter();
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


describe('authRateLimiter — F-09 anti-lockout + per-IP limits', () => {
  function appWithIp(getIp: (n: number) => string, opts = {}) {
    const app = express();
    app.set('trust proxy', true);
    let n = 0;
    app.use((req, _res, next) => {
      req.headers['x-forwarded-for'] = getIp(n++);
      next();
    });
    app.use(express.json());
    app.post('/auth/login', createAuthRateLimiter(opts), (req, res) =>
      res.status(req.body.password === 'good' ? 200 : 401).json({ ok: true }),
    );
    return app;
  }

  it('a third party on a different IP cannot lock the victim: victim keeps their own (IP,email) budget', async () => {
    // Attacker (IP A) hammers the victim's email until blocked.
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.post('/auth/login', createAuthRateLimiter({ emailLimit: 30 }), (_req, res) => res.status(401).json({}));
    const attacker = '203.0.113.9';
    const victim = '198.51.100.77';
    let last = 0;
    for (let i = 0; i < 8; i++) {
      last = (await request(app).post('/auth/login').set('X-Forwarded-For', attacker)
        .send({ email: 'victim@example.com', password: 'x' })).status;
    }
    expect(last).toBe(429); // attacker is throttled themselves at 5/min

    const res = await request(app).post('/auth/login').set('X-Forwarded-For', victim)
      .send({ email: 'victim@example.com', password: 'right' });
    expect(res.status).toBe(401); // reaches the handler (not 429)
  });

  it('enforces an independent per-IP ceiling across different emails (20/min default)', async () => {
    const app = appWithIp(() => '203.0.113.50');
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      statuses.push((await request(app).post('/auth/login').send({ email: `u${i}@example.com`, password: 'x' })).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect(statuses[21]).toBe(429);
  });

  it('per-email ceiling applies across many IPs (distributed guessing) but with a higher ceiling', async () => {
    const app = appWithIp((n) => `203.0.113.${n + 1}`, { emailLimit: 30 });
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      statuses.push((await request(app).post('/auth/login').send({ email: 'target@example.com', password: 'x' })).status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('login variant: successful sign-ins do not consume the per-email budget', async () => {
    const app = appWithIp((n) => `203.0.113.${n + 1}`, { emailLimit: 3, skipSuccessfulForEmail: true });
    for (let i = 0; i < 6; i++) {
      const ok = await request(app).post('/auth/login').send({ email: 'owner@example.com', password: 'good' });
      expect(ok.status).toBe(200);
    }
    const bad = await request(app).post('/auth/login').send({ email: 'owner@example.com', password: 'x' });
    expect(bad.status).toBe(401);
  });
});
