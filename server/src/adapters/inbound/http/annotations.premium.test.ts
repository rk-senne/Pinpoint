import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createAnnotationRoutes, type AnnotationRouteDeps } from './annotations.routes.js';

/**
 * Cross-tenant IDOR tests for the premium annotation endpoints:
 * GET /:id/suggestions and POST /:id/check-regression.
 * 
 * These tests verify that annotations belonging to a different org
 * are rejected with 404.
 */

const ORG_ID = 'a0000000-0000-0000-0000-000000000001';
const ANNOTATION_ID = 'c0000000-0000-0000-0000-000000000001';

function fakeAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  (req as any).user = { userId: 'u1', email: 'a@b.com', orgId: ORG_ID, role: 'admin' };
  next();
}

function makeMockAnnotationRepo(opts: { findResult?: any } = {}): any {
  const { findResult = null } = opts;
  return {
    findById: vi.fn().mockResolvedValue(findResult),
    listByProject: vi.fn().mockResolvedValue([]),
    countByProject: vi.fn().mockResolvedValue(0),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    setScreenshotKey: vi.fn(),
    findByClientRequestId: vi.fn().mockResolvedValue(null),
  };
}

function makeMockDb(opts: { annotationOwned?: boolean } = {}): any {
  const { annotationOwned = true } = opts;
  const db: any = vi.fn((table: string) => {
    if (table === 'annotations') {
      const b: any = {};
      b.where = vi.fn().mockReturnValue(b);
      b.first = vi.fn().mockImplementation((...args: any[]) => {
        // If called with a single column name (e.g., 'screenshot_object_key'), return a row
        if (typeof args[0] === 'string' && !args[0].includes('=')) {
          return Promise.resolve({ screenshot_object_key: 'test-key' });
        }
        // If called with object arg (org check), check if owned
        return Promise.resolve(annotationOwned ? { id: ANNOTATION_ID, org_id: ORG_ID } : undefined);
      });
      return b;
    }
    return {};
  });
  return db;
}

function makeDeps(opts: { annotationOwned?: boolean; annotationExists?: boolean } = {}): AnnotationRouteDeps {
  const { annotationOwned = true, annotationExists = true } = opts;
  return {
    createAnnotation: { execute: vi.fn() } as any,
    updateAnnotation: { execute: vi.fn() } as any,
    changeAnnotationStatus: { execute: vi.fn() } as any,
    deleteAnnotation: { execute: vi.fn() } as any,
    attachScreenshot: { execute: vi.fn() } as any,
    annotationRepo: makeMockAnnotationRepo({
      findResult: annotationExists
        ? { id: ANNOTATION_ID, projectId: 'proj-1', body: 'test', target: { cssSelector: 'div' }, orgId: ORG_ID }
        : null,
    }),
    resolvePageUrls: vi.fn().mockResolvedValue(new Map()),
    buildScreenshotUrl: vi.fn().mockReturnValue('http://example.com/screenshot.png'),
    fetchScreenshotBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
    authMiddleware: fakeAuth,
    db: makeMockDb({ annotationOwned }),
  };
}

function makeApp(deps: AnnotationRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  const { annotationRouter } = createAnnotationRoutes(deps);
  app.use('/api/v1/annotations', annotationRouter);
  return app;
}

describe('annotations.routes — premium endpoints cross-tenant IDOR protection', () => {
  describe('GET /api/v1/annotations/:id/suggestions', () => {
    it('returns 404 when annotation does not belong to user org (cross-tenant IDOR)', async () => {
      const deps = makeDeps({ annotationOwned: false, annotationExists: true });
      const app = makeApp(deps);

      const res = await request(app).get(`/api/v1/annotations/${ANNOTATION_ID}/suggestions`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 when annotation does not exist', async () => {
      const deps = makeDeps({ annotationOwned: false, annotationExists: false });
      const app = makeApp(deps);

      const res = await request(app).get(`/api/v1/annotations/${ANNOTATION_ID}/suggestions`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/v1/annotations/:id/check-regression', () => {
    it('returns 404 when annotation does not belong to user org (cross-tenant IDOR)', async () => {
      const deps = makeDeps({ annotationOwned: false, annotationExists: true });
      const app = makeApp(deps);

      const res = await request(app)
        .post(`/api/v1/annotations/${ANNOTATION_ID}/check-regression`)
        .send({ screenshot: Buffer.from('fake-png').toString('base64') });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 when annotation does not exist', async () => {
      const deps = makeDeps({ annotationOwned: false, annotationExists: false });
      const app = makeApp(deps);

      const res = await request(app)
        .post(`/api/v1/annotations/${ANNOTATION_ID}/check-regression`)
        .send({ screenshot: Buffer.from('fake-png').toString('base64') });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
