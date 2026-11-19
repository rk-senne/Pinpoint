import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import express from 'express';
import { request } from '../../../__tests__/supertestClient.js';

import { createWidgetRoutes, WIDGET_DESCRIPTION_MAX } from './widget.routes.js';
import { FakeApiKeyRepo } from '../../../__tests__/fakes/FakeApiKeyRepo.js';
import { FakeAnnotationRepo } from '../../../__tests__/fakes/FakeAnnotationRepo.js';
import { buildGuestAnnotationSut } from '../../../__tests__/fakes/guestAnnotationSut.js';
import type { CreateGuestAnnotation } from '../../../domain/annotation/usecases/createAnnotation.js';
import { __resetWidgetRateLimitMemory } from '../../../middleware/widgetRateLimit.js';
import type { ApiKey } from '../../../domain/org/ports/ApiKeyRepo.js';

const ORG_ID = 'a0000000-0000-4000-8000-000000000001';
// Set per test to the project seeded by buildGuestAnnotationSut().
let PROJECT_ID = '';
let createGuestAnnotation: CreateGuestAnnotation;
const WIDGET_RAW = 'pk_widget_deadbeef';
const WIDGET_HASH = createHash('sha256').update(WIDGET_RAW).digest('hex');

function widgetKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'k0000000-0000-0000-0000-000000000001',
    orgId: ORG_ID,
    name: 'Site widget',
    keyPrefix: 'pk_widget_',
    scopes: ['widget'],
    createdBy: 'u0000000-0000-0000-0000-000000000001',
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    keyType: 'widget',
    projectId: PROJECT_ID,
    allowedOrigins: [],
    dailyQuota: null,
    ...overrides,
  };
}

function makeApp(apiKeyRepo: FakeApiKeyRepo, _annotationRepo: FakeAnnotationRepo) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/widget', createWidgetRoutes({ apiKeyRepo, createGuestAnnotation }));
  return app;
}

const VALID_BODY = {
  description: 'Something is broken',
  severity: 'major',
  pageUrl: 'https://example.com/pricing',
  viewport: { width: 1280, height: 800 },
  userAgent: 'Mozilla/5.0',
};

describe('widget.routes — key isolation (A1)', () => {
  let apiKeyRepo: FakeApiKeyRepo;
  let annotationRepo: FakeAnnotationRepo;

  beforeEach(async () => {
    __resetWidgetRateLimitMemory();
    apiKeyRepo = new FakeApiKeyRepo();
    const sut = await buildGuestAnnotationSut();
    annotationRepo = sut.annotationRepo;
    createGuestAnnotation = sut.createGuestAnnotation;
    PROJECT_ID = sut.projectId;
  });

  it('401 when X-Project-Key header is missing', async () => {
    const app = makeApp(apiKeyRepo, annotationRepo);
    const res = await request(app).post('/api/v1/widget/feedback').send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('401 when the key is unknown', async () => {
    const app = makeApp(apiKeyRepo, annotationRepo);
    const res = await request(app)
      .post('/api/v1/widget/feedback')
      .set('X-Project-Key', 'pk_widget_unknown')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('401 when a standard (non-widget) key is presented', async () => {
    apiKeyRepo.seed(WIDGET_HASH, widgetKey({ keyType: 'standard', scopes: ['feedback:write'] }));
    const app = makeApp(apiKeyRepo, annotationRepo);
    const res = await request(app)
      .post('/api/v1/widget/feedback')
      .set('X-Project-Key', WIDGET_RAW)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('writes the annotation to the key\u2019s bound project (no org-first target)', async () => {
    apiKeyRepo.seed(WIDGET_HASH, widgetKey());
    const app = makeApp(apiKeyRepo, annotationRepo);
    const res = await request(app)
      .post('/api/v1/widget/feedback')
      .set('X-Project-Key', WIDGET_RAW)
      .send(VALID_BODY);
    expect(res.status).toBe(201);
    const created = Array.from(annotationRepo.annotations.values());
    expect(created).toHaveLength(1);
    expect(created[0]!.projectId).toBe(PROJECT_ID);
    expect(apiKeyRepo.updatedLastUsed).toContain(widgetKey().id);
  });

  it('stores a real guest row: no fake author, a real page for pageUrl, an allocated pin', async () => {
    apiKeyRepo.seed(WIDGET_HASH, widgetKey());
    const app = makeApp(apiKeyRepo, annotationRepo);
    const send = () =>
      request(app).post('/api/v1/widget/feedback').set('X-Project-Key', WIDGET_RAW).send(VALID_BODY);
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);

    const rows = Array.from(annotationRepo.annotations.values());
    expect(rows).toHaveLength(2);
    for (const a of rows) {
      // Regression: previously authorId 'guest' (not a uuid → FK error) and
      // pageId = projectId (not a pages.id → FK error) on real Postgres.
      expect(a.authorId).toBeNull();
      expect(a.isGuest).toBe(true);
      expect(a.pageId).not.toBe(PROJECT_ID);
    }
    // Same pageUrl → same page; pins allocated, distinct (was hard-coded 0).
    expect(new Set(rows.map((a) => a.pageId)).size).toBe(1);
    expect(rows.map((a) => a.pinNumber).sort()).toEqual([1, 2]);
  });

  it('403 when a widget key has no project binding', async () => {
    apiKeyRepo.seed(WIDGET_HASH, widgetKey({ projectId: null }));
    const app = makeApp(apiKeyRepo, annotationRepo);
    const res = await request(app)
      .post('/api/v1/widget/feedback')
      .set('X-Project-Key', WIDGET_RAW)
      .send(VALID_BODY);
    expect(res.status).toBe(403);
  });
});

describe('widget.routes — server-side body cap (B2)', () => {
  let apiKeyRepo: FakeApiKeyRepo;
  let annotationRepo: FakeAnnotationRepo;

  beforeEach(async () => {
    __resetWidgetRateLimitMemory();
    apiKeyRepo = new FakeApiKeyRepo();
    const sut = await buildGuestAnnotationSut();
    annotationRepo = sut.annotationRepo;
    createGuestAnnotation = sut.createGuestAnnotation;
    PROJECT_ID = sut.projectId;
    apiKeyRepo.seed(WIDGET_HASH, widgetKey());
  });

  it(`rejects a description longer than ${WIDGET_DESCRIPTION_MAX} chars`, async () => {
    const app = makeApp(apiKeyRepo, annotationRepo);
    const res = await request(app)
      .post('/api/v1/widget/feedback')
      .set('X-Project-Key', WIDGET_RAW)
      .send({ ...VALID_BODY, description: 'x'.repeat(WIDGET_DESCRIPTION_MAX + 1) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(annotationRepo.annotations.size).toBe(0);
  });

  it('accepts a description exactly at the cap', async () => {
    const app = makeApp(apiKeyRepo, annotationRepo);
    const res = await request(app)
      .post('/api/v1/widget/feedback')
      .set('X-Project-Key', WIDGET_RAW)
      .send({ ...VALID_BODY, description: 'x'.repeat(WIDGET_DESCRIPTION_MAX) });
    expect(res.status).toBe(201);
  });

  it('rejects an empty description', async () => {
    const app = makeApp(apiKeyRepo, annotationRepo);
    const res = await request(app)
      .post('/api/v1/widget/feedback')
      .set('X-Project-Key', WIDGET_RAW)
      .send({ ...VALID_BODY, description: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('widget.routes — server-side origin allow-list', () => {
  beforeEach(async () => {
    __resetWidgetRateLimitMemory();
    const sut = await buildGuestAnnotationSut();
    createGuestAnnotation = sut.createGuestAnnotation;
    PROJECT_ID = sut.projectId;
  });

  it('403s a browser POST from an origin outside allowedOrigins (no write)', async () => {
    const apiKeyRepo = new FakeApiKeyRepo();
    const sut = await buildGuestAnnotationSut();
    createGuestAnnotation = sut.createGuestAnnotation;
    PROJECT_ID = sut.projectId;
    apiKeyRepo.seed(WIDGET_HASH, widgetKey({ allowedOrigins: ['https://customer.example'] }));
    const app = makeApp(apiKeyRepo, sut.annotationRepo);
    const res = await request(app)
      .post('/api/v1/widget/feedback')
      .set('Origin', 'https://evil.test')
      .set('X-Project-Key', WIDGET_RAW)
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(sut.annotationRepo.annotations.size).toBe(0);
  });

  it('accepts the listed origin', async () => {
    const apiKeyRepo = new FakeApiKeyRepo();
    apiKeyRepo.seed(WIDGET_HASH, widgetKey({ allowedOrigins: ['https://customer.example'] }));
    const sut = await buildGuestAnnotationSut();
    createGuestAnnotation = sut.createGuestAnnotation;
    PROJECT_ID = sut.projectId;
    apiKeyRepo.seed(WIDGET_HASH, widgetKey({ allowedOrigins: ['https://customer.example'] }));
    const res = await request(makeApp(apiKeyRepo, sut.annotationRepo))
      .post('/api/v1/widget/feedback')
      .set('Origin', 'https://customer.example')
      .set('X-Project-Key', WIDGET_RAW)
      .send(VALID_BODY);
    expect(res.status).toBe(201);
  });
});

describe('widget.routes — origin check precedes the rate limiter (F-20)', () => {
  it('disallowed-origin traffic never consumes the key quota', async () => {
    __resetWidgetRateLimitMemory();
    const sut = await buildGuestAnnotationSut();
    createGuestAnnotation = sut.createGuestAnnotation;
    PROJECT_ID = sut.projectId;
    const apiKeyRepo = new FakeApiKeyRepo();
    apiKeyRepo.seed(WIDGET_HASH, widgetKey({ allowedOrigins: ['https://customer.example'] }));
    const app = makeApp(apiKeyRepo, sut.annotationRepo);

    // Far more than the default burst ceiling (5) from a hostile origin.
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .post('/api/v1/widget/feedback')
        .set('Origin', 'https://evil.test')
        .set('X-Project-Key', WIDGET_RAW)
        .send(VALID_BODY);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    }

    // The legitimate origin still has its full budget.
    const ok = await request(app)
      .post('/api/v1/widget/feedback')
      .set('Origin', 'https://customer.example')
      .set('X-Project-Key', WIDGET_RAW)
      .send(VALID_BODY);
    expect(ok.status).toBe(201);
  });
});

describe('widget.routes — pageUrl scheme (F-23)', () => {
  it.each(['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'not a url'])(
    'rejects %s',
    async (pageUrl) => {
      __resetWidgetRateLimitMemory();
      const sut = await buildGuestAnnotationSut();
      createGuestAnnotation = sut.createGuestAnnotation;
      PROJECT_ID = sut.projectId;
      const apiKeyRepo = new FakeApiKeyRepo();
      apiKeyRepo.seed(WIDGET_HASH, widgetKey());
      const res = await request(makeApp(apiKeyRepo, sut.annotationRepo))
        .post('/api/v1/widget/feedback')
        .set('X-Project-Key', WIDGET_RAW)
        .send({ ...VALID_BODY, pageUrl });
      expect(res.status).toBe(400);
      expect(sut.annotationRepo.annotations.size).toBe(0);
    },
  );
});
