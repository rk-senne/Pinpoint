import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createBulkRoutes, type BulkRouteDeps } from './bulk.routes.js';

/**
 * Unit tests for bulk action routes — validates request-body schema
 * enforcement and routing logic against mock db queries.
 */

function noopAuth(_req: express.Request, _res: express.Response, next: express.NextFunction) {
  next();
}

function makeApp(deps: BulkRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  // The bulk route is mounted at /api/v1/projects in the composition,
  // registering /:id/annotations/bulk.
  app.use('/api/v1/projects', createBulkRoutes(deps));
  return app;
}

describe('bulk.routes', () => {
  let mockDb: any;

  beforeEach(() => {
    mockDb = vi.fn();
  });

  describe('POST /api/v1/projects/:id/annotations/bulk', () => {
    it('rejects empty ids array', async () => {
      mockDb = vi.fn().mockReturnValue({});
      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app)
        .post('/api/v1/projects/proj-1/annotations/bulk')
        .send({ ids: [], action: 'resolve' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('rejects invalid action', async () => {
      mockDb = vi.fn().mockReturnValue({});
      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app)
        .post('/api/v1/projects/proj-1/annotations/bulk')
        .send({
          ids: ['a0000000-0000-0000-0000-000000000001'],
          action: 'invalid_action',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('rejects assign action without assigneeId', async () => {
      // Mock: whereIn → andWhere chain returns matching annotations
      const update = vi.fn().mockResolvedValue(1);
      const whereIn = vi.fn().mockReturnValue({
        andWhere: vi.fn().mockResolvedValue([{ id: 'a0000000-0000-0000-0000-000000000001', project_id: 'proj-1' }]),
        update,
      });
      mockDb = vi.fn().mockReturnValue({ whereIn });

      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app)
        .post('/api/v1/projects/proj-1/annotations/bulk')
        .send({
          ids: ['a0000000-0000-0000-0000-000000000001'],
          action: 'assign',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('accepts valid bulk resolve request', async () => {
      const annotationId = 'a0000000-0000-0000-0000-000000000001';
      const annotations = [{ id: annotationId, project_id: 'proj-1' }];

      const update = vi.fn().mockResolvedValue(1);
      const whereInForUpdate = vi.fn().mockReturnValue({ update });
      const andWhere = vi.fn().mockResolvedValue(annotations);
      const whereInForCheck = vi.fn().mockReturnValue({ andWhere });

      // First call is for checking annotations, second for updating
      let callCount = 0;
      mockDb = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return { whereIn: whereInForCheck };
        return { whereIn: whereInForUpdate };
      });
      mockDb.fn = { now: vi.fn().mockReturnValue('NOW()') };

      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app)
        .post('/api/v1/projects/proj-1/annotations/bulk')
        .send({ ids: [annotationId], action: 'resolve' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ affected: 1, action: 'resolve' });
    });

    it('rejects non-uuid ids', async () => {
      mockDb = vi.fn().mockReturnValue({});
      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app)
        .post('/api/v1/projects/proj-1/annotations/bulk')
        .send({ ids: ['not-a-uuid'], action: 'resolve' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('rejects more than 100 ids', async () => {
      mockDb = vi.fn().mockReturnValue({});
      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const ids = Array.from({ length: 101 }, (_, i) =>
        `a0000000-0000-0000-0000-${String(i).padStart(12, '0')}`
      );

      const res = await request(app)
        .post('/api/v1/projects/proj-1/annotations/bulk')
        .send({ ids, action: 'resolve' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });
  });
});
