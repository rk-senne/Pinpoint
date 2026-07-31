import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createFeedbackRoutes, type FeedbackRouteDeps } from './feedback.routes.js';

const ORG_ID = 'a0000000-0000-0000-0000-000000000001';
const OTHER_ORG_ID = 'a0000000-0000-0000-0000-000000000002';
const PROJECT_ID = 'b0000000-0000-0000-0000-000000000001';
const ANNOTATION_ID = 'c0000000-0000-0000-0000-000000000001';

function fakeAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  (req as any).user = { userId: 'u1', email: 'a@b.com', orgId: ORG_ID, role: 'admin' };
  next();
}

function makeMockDb(opts: { projectOwned?: boolean; annotationOwned?: boolean } = {}): any {
  const { projectOwned = true, annotationOwned = true } = opts;
  const db: any = vi.fn((table: string) => {
    if (table === 'projects') {
      const b: any = {};
      b.where = vi.fn().mockReturnValue(b);
      b.first = vi.fn().mockResolvedValue(projectOwned ? { id: PROJECT_ID, org_id: ORG_ID } : undefined);
      return b;
    }
    if (table === 'annotations') {
      const b: any = {};
      b.where = vi.fn().mockReturnValue(b);
      b.first = vi.fn().mockResolvedValue(annotationOwned ? { id: ANNOTATION_ID, org_id: ORG_ID } : undefined);
      return b;
    }
    return {};
  });
  return db;
}

function makeMockAnnotationRepo(opts: { annotations?: any[]; count?: number; findResult?: any } = {}): any {
  const { annotations = [], count = 0, findResult = null } = opts;
  return {
    listByProject: vi.fn().mockResolvedValue(annotations),
    countByProject: vi.fn().mockResolvedValue(count),
    findById: vi.fn().mockResolvedValue(findResult),
    insert: vi.fn().mockResolvedValue({ id: ANNOTATION_ID, projectId: PROJECT_ID }),
    update: vi.fn().mockResolvedValue({ id: ANNOTATION_ID, body: 'updated' }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function makeApp(deps: FeedbackRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/feedback', createFeedbackRoutes(deps));
  return app;
}

describe('feedback.routes — cross-tenant IDOR protection', () => {
  describe('GET /api/v1/feedback', () => {
    it('returns data when project belongs to user org', async () => {
      const db = makeMockDb({ projectOwned: true });
      const annotationRepo = makeMockAnnotationRepo({ annotations: [], count: 0 });
      const app = makeApp({ authMiddleware: fakeAuth, annotationRepo, db });

      const res = await request(app).get(`/api/v1/feedback?projectId=${PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('rejects cross-tenant access with 404 when project does not belong to user org', async () => {
      const db = makeMockDb({ projectOwned: false });
      const annotationRepo = makeMockAnnotationRepo();
      const app = makeApp({ authMiddleware: fakeAuth, annotationRepo, db });

      const res = await request(app).get(`/api/v1/feedback?projectId=${PROJECT_ID}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/v1/feedback', () => {
    const validBody = {
      projectId: PROJECT_ID,
      body: 'test feedback',
      target: { cssSelector: 'div', xpath: '/div', pageX: 100, pageY: 200, tagName: 'div', textSnippet: '' },
      environment: { browserFamily: 'Chrome', browserVersion: '126', osFamily: 'macOS', osVersion: '14', deviceType: 'desktop', userAgentRaw: 'Mozilla/5.0' },
    };

    it('creates feedback when project belongs to user org', async () => {
      const db = makeMockDb({ projectOwned: true });
      const annotationRepo = makeMockAnnotationRepo();
      const app = makeApp({ authMiddleware: fakeAuth, annotationRepo, db });

      const res = await request(app).post('/api/v1/feedback').send(validBody);
      expect(res.status).toBe(201);
    });

    it('rejects cross-tenant access with 404 when project does not belong to user org', async () => {
      const db = makeMockDb({ projectOwned: false });
      const annotationRepo = makeMockAnnotationRepo();
      const app = makeApp({ authMiddleware: fakeAuth, annotationRepo, db });

      const res = await request(app).post('/api/v1/feedback').send(validBody);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('PATCH /api/v1/feedback/:id', () => {
    it('updates feedback when annotation belongs to user org', async () => {
      const db = makeMockDb({ annotationOwned: true });
      const annotationRepo = makeMockAnnotationRepo({ findResult: { id: ANNOTATION_ID, orgId: ORG_ID } });
      const app = makeApp({ authMiddleware: fakeAuth, annotationRepo, db });

      const res = await request(app).patch(`/api/v1/feedback/${ANNOTATION_ID}`).send({ body: 'updated' });
      expect(res.status).toBe(200);
    });

    it('rejects cross-tenant access with 404 when annotation does not belong to user org', async () => {
      const db = makeMockDb({ annotationOwned: false });
      const annotationRepo = makeMockAnnotationRepo({ findResult: { id: ANNOTATION_ID, orgId: OTHER_ORG_ID } });
      const app = makeApp({ authMiddleware: fakeAuth, annotationRepo, db });

      const res = await request(app).patch(`/api/v1/feedback/${ANNOTATION_ID}`).send({ body: 'hacked' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 when annotation does not exist at all', async () => {
      const db = makeMockDb();
      const annotationRepo = makeMockAnnotationRepo({ findResult: null });
      const app = makeApp({ authMiddleware: fakeAuth, annotationRepo, db });

      const res = await request(app).patch(`/api/v1/feedback/${ANNOTATION_ID}`).send({ body: 'test' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('DELETE /api/v1/feedback/:id', () => {
    it('deletes feedback when annotation belongs to user org', async () => {
      const db = makeMockDb({ annotationOwned: true });
      const annotationRepo = makeMockAnnotationRepo({ findResult: { id: ANNOTATION_ID, orgId: ORG_ID } });
      const app = makeApp({ authMiddleware: fakeAuth, annotationRepo, db });

      const res = await request(app).delete(`/api/v1/feedback/${ANNOTATION_ID}`);
      expect(res.status).toBe(204);
    });

    it('rejects cross-tenant access with 404 when annotation does not belong to user org', async () => {
      const db = makeMockDb({ annotationOwned: false });
      const annotationRepo = makeMockAnnotationRepo({ findResult: { id: ANNOTATION_ID, orgId: OTHER_ORG_ID } });
      const app = makeApp({ authMiddleware: fakeAuth, annotationRepo, db });

      const res = await request(app).delete(`/api/v1/feedback/${ANNOTATION_ID}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
