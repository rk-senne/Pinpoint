// Route tests for the hardened guest feedback endpoint (Mission A7).
//
// Validates:
//   - X-Robots-Tag: noindex on every response.
//   - Identical 404 responses for a missing link and a feedback-disabled
//     link (enumeration-oracle kill).
//   - Canonical `{ error: { code, message, details } }` envelope on
//     validation failure (no bare-string error, no flat top-level issues).
//   - Guest submissions are flagged (isGuest / guestName / guestEmail).
//   - Per-link rate limit (burst window) returns 429 with Retry-After.
//   - Per-link daily quota enforced independently.
//   - Fail-CLOSED when the Redis backend errors.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { request } from '../../../__tests__/supertestClient.js';

import { createGuestFeedbackRoutes } from './guestFeedback.routes.js';
import { __resetWidgetRateLimitMemory, type WidgetRateLimitRedis } from '../../../middleware/widgetRateLimit.js';
import { FakeSharedLinkRepo } from '../../../__tests__/fakes/FakeSharedLinkRepo.js';
import { FakeClock } from '../../../__tests__/fakes/FakeClock.js';
import { buildGuestAnnotationSut } from '../../../__tests__/fakes/guestAnnotationSut.js';

interface Overrides {
  rateLimitRedis?: WidgetRateLimitRedis;
  dailyQuota?: number | null;
  windowMs?: number;
  max?: number;
}

async function buildApp(opts: Overrides = {}) {
  const clock = new FakeClock(new Date('2026-11-13T00:00:00Z'));
  const sut = await buildGuestAnnotationSut();
  const { annotationRepo, pageRepo, createGuestAnnotation, projectId } = sut;
  const sharedLinkRepo = new FakeSharedLinkRepo(clock);

  const openLink = await sharedLinkRepo.insert({
    id: 'feedback-on-link',
    projectId,
    passwordHash: null,
    allowFeedback: true,
  });
  const disabledLink = await sharedLinkRepo.insert({
    id: 'feedback-off-link',
    projectId,
    passwordHash: null,
    allowFeedback: false,
  });

  const router = createGuestFeedbackRoutes({
    createGuestAnnotation,
    sharedLinkRepo,
    pageRepo,
    ...(opts.rateLimitRedis ? { rateLimitRedis: opts.rateLimitRedis } : {}),
    ...(opts.dailyQuota !== undefined ? { dailyQuota: opts.dailyQuota } : {}),
    ...(opts.windowMs !== undefined ? { windowMs: opts.windowMs } : {}),
    ...(opts.max !== undefined ? { max: opts.max } : {}),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/shared', router);
  return { app, annotationRepo, openLink, disabledLink };
}

const validBody = {
  name: 'Guesty',
  email: 'guest@example.com',
  description: 'Button overlaps the footer on mobile.',
  severity: 'minor' as const,
  pageUrl: 'https://example.com/page',
};

describe('guestFeedback.routes (A7)', () => {
  beforeEach(() => __resetWidgetRateLimitMemory());
  afterEach(() => __resetWidgetRateLimitMemory());

  it('accepts a valid guest submission and flags it as guest-authored', async () => {
    const { app, annotationRepo } = await buildApp();
    const res = await request(app)
      .post('/api/v1/shared/feedback-on-link/feedback')
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.data.isGuest).toBe(true);
    expect(res.body.data.guestName).toBe('Guesty');
    expect(res.headers['x-robots-tag']).toBe('noindex');

    const stored = [...annotationRepo.annotations.values()][0];
    expect(stored.isGuest).toBe(true);
    expect(stored.guestName).toBe('Guesty');
    expect(stored.guestEmail).toBe('guest@example.com');
  });

  it('sets X-Robots-Tag: noindex on every response', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/v1/shared/does-not-exist/feedback')
      .send(validBody);
    expect(res.headers['x-robots-tag']).toBe('noindex');
  });

  it('returns IDENTICAL responses for a missing link and a feedback-disabled link', async () => {
    const { app } = await buildApp();

    const missing = await request(app)
      .post('/api/v1/shared/no-such-link/feedback')
      .send(validBody);
    const disabled = await request(app)
      .post('/api/v1/shared/feedback-off-link/feedback')
      .send(validBody);

    expect(missing.status).toBe(404);
    expect(disabled.status).toBe(404);
    expect(missing.status).toBe(disabled.status);
    expect(missing.body).toEqual(disabled.body);
    expect(missing.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Shared link not found.', details: {} },
    });
  });

  it('rejects an invalid payload with the canonical envelope (no bare string, no flat issues)', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/v1/shared/feedback-on-link/feedback')
      .send({ description: '' }); // missing name, bad description, no pageUrl

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('VALIDATION');
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body.error.details).toBeDefined();
    expect(res.body.error.details.issues).toBeDefined();
    // No bare-string error and no flat top-level issues (GAP 7 / A7.7).
    expect(typeof res.body.error).not.toBe('string');
    expect(res.body.issues).toBeUndefined();
  });

  it('enforces the per-link burst window and returns 429 + Retry-After', async () => {
    const { app } = await buildApp({ max: 2, windowMs: 60_000 });
    const url = '/api/v1/shared/feedback-on-link/feedback';
    expect((await request(app).post(url).send(validBody)).status).toBe(201);
    expect((await request(app).post(url).send(validBody)).status).toBe(201);
    const limited = await request(app).post(url).send(validBody);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('enforces the per-link daily quota independently of the burst window', async () => {
    const { app } = await buildApp({ max: 100, windowMs: 60_000, dailyQuota: 2 });
    const url = '/api/v1/shared/feedback-on-link/feedback';
    expect((await request(app).post(url).send(validBody)).status).toBe(201);
    expect((await request(app).post(url).send(validBody)).status).toBe(201);
    const limited = await request(app).post(url).send(validBody);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('keys the quota per link — a different link has an independent counter', async () => {
    // Both links are open; only `feedback-on-link` exists as open, so add a
    // second open link to assert independence.
    const clock = new FakeClock(new Date('2026-11-13T00:00:00Z'));
    const { createGuestAnnotation, projectId } = await buildGuestAnnotationSut();
    const sharedLinkRepo = new FakeSharedLinkRepo(clock);
    await sharedLinkRepo.insert({ id: 'link-a', projectId, allowFeedback: true });
    await sharedLinkRepo.insert({ id: 'link-b', projectId, allowFeedback: true });
    const router = createGuestFeedbackRoutes({
      createGuestAnnotation,
      sharedLinkRepo,
      max: 1,
      windowMs: 60_000,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/shared', router);

    expect(
      (await request(app).post('/api/v1/shared/link-a/feedback').send(validBody)).status,
    ).toBe(201);
    // link-a is now at its window cap, but link-b is independent.
    expect(
      (await request(app).post('/api/v1/shared/link-a/feedback').send(validBody)).status,
    ).toBe(429);
    expect(
      (await request(app).post('/api/v1/shared/link-b/feedback').send(validBody)).status,
    ).toBe(201);
  });

  it('is fail-CLOSED when the Redis backend errors', async () => {
    const failingRedis: WidgetRateLimitRedis = {
      async incr() {
        throw new Error('redis down');
      },
      async expire() {
        throw new Error('redis down');
      },
    };
    const { app } = await buildApp({ rateLimitRedis: failingRedis });
    const res = await request(app)
      .post('/api/v1/shared/feedback-on-link/feedback')
      .send(validBody);
    expect(res.status).toBe(429);
  });
});

describe('guestFeedback.routes — guest rows are schema-valid (author_id NULL)', () => {
  beforeEach(() => __resetWidgetRateLimitMemory());

  it('stores author_id NULL + guest identity, a real page, and an allocated pin', async () => {
    const { app, annotationRepo } = await buildApp({ max: 10 });
    for (let i = 0; i < 2; i++) {
      const res = await request(app).post('/api/v1/shared/feedback-on-link/feedback').send(validBody);
      expect(res.status).toBe(201);
    }
    const rows = Array.from(annotationRepo.annotations.values());
    expect(rows).toHaveLength(2);
    for (const a of rows) {
      // Regression: previously authorId 'guest' → invalid uuid / FK violation in Postgres.
      expect(a.authorId).toBeNull();
      expect(a.isGuest).toBe(true);
      expect(a.guestName).toBe(validBody.name);
    }
    // Pins allocated atomically and distinct (was hard-coded 0 for every guest row).
    expect(rows.map((a) => a.pinNumber).sort()).toEqual([1, 2]);
  });
});

describe('guestFeedback.routes — pageUrl scheme (F-23)', () => {
  beforeEach(() => __resetWidgetRateLimitMemory());
  afterEach(() => __resetWidgetRateLimitMemory());

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd'])(
    'rejects %s with 400 and writes nothing',
    async (pageUrl) => {
      const { app, annotationRepo } = await buildApp();
      const res = await request(app)
        .post('/api/v1/shared/feedback-on-link/feedback')
        .send({ ...validBody, pageUrl });
      expect(res.status).toBe(400);
      expect(annotationRepo.annotations.size).toBe(0);
    },
  );
});
