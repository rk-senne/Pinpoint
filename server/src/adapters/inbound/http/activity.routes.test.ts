import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createActivityRoutes, type ActivityRouteDeps } from './activity.routes.js';

/**
 * Unit tests for activity feed routes — validates pagination parameter
 * parsing and default values against mock db queries.
 */

function noopAuth(_req: express.Request, _res: express.Response, next: express.NextFunction) {
  next();
}

function makeMockDb(rows: any[] = [], total = 0) {
  // Build a chain that mimics knex query builder
  const offset = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn().mockReturnValue({ offset });
  const orderBy = vi.fn().mockReturnValue({ limit });
  const select = vi.fn().mockReturnValue({ orderBy });
  const whereJoin = vi.fn().mockReturnValue({ select });
  const leftJoin = vi.fn().mockReturnValue({ where: whereJoin });

  // For count query
  const count = vi.fn().mockResolvedValue([{ count: total }]);
  const whereCount = vi.fn().mockReturnValue({ count });

  let callCount = 0;
  const db: any = vi.fn().mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // count query
      return { where: whereCount };
    }
    // data query
    return { leftJoin };
  });

  return { db, offset, limit };
}

function makeApp(deps: ActivityRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  // Activity routes are mounted at /api/v1/projects/:id/activity
  app.use('/api/v1/projects/:id/activity', createActivityRoutes(deps));
  return app;
}

describe('activity.routes', () => {
  describe('GET /api/v1/projects/:id/activity', () => {
    it('uses default pagination values (page=1, pageSize=25)', async () => {
      const { db, offset, limit } = makeMockDb([], 0);
      const app = makeApp({ authMiddleware: noopAuth, db });

      const res = await request(app).get('/api/v1/projects/proj-1/activity');

      expect(res.status).toBe(200);
      expect(res.body.pagination).toEqual({
        page: 1,
        pageSize: 25,
        total: 0,
        totalPages: 0,
      });
      // Default page=1 → offset=(1-1)*25=0
      expect(offset).toHaveBeenCalledWith(0);
      expect(limit).toHaveBeenCalledWith(25);
    });

    it('parses custom pagination params', async () => {
      const { db, offset, limit } = makeMockDb([], 50);
      const app = makeApp({ authMiddleware: noopAuth, db });

      const res = await request(app).get('/api/v1/projects/proj-1/activity?page=3&pageSize=10');

      expect(res.status).toBe(200);
      expect(res.body.pagination).toEqual({
        page: 3,
        pageSize: 10,
        total: 50,
        totalPages: 5,
      });
      // page=3, pageSize=10 → offset=(3-1)*10=20
      expect(offset).toHaveBeenCalledWith(20);
      expect(limit).toHaveBeenCalledWith(10);
    });

    it('returns event data mapped correctly', async () => {
      const rows = [
        {
          id: 'evt-1',
          project_id: 'proj-1',
          actor_id: 'user-1',
          actor_name: 'Alice',
          action: 'created',
          resource_type: 'annotation',
          resource_id: 'ann-1',
          metadata: { pin: 1 },
          created_at: '2026-07-14T10:00:00Z',
        },
      ];
      const { db } = makeMockDb(rows, 1);
      const app = makeApp({ authMiddleware: noopAuth, db });

      const res = await request(app).get('/api/v1/projects/proj-1/activity');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toEqual({
        id: 'evt-1',
        projectId: 'proj-1',
        actorId: 'user-1',
        actorName: 'Alice',
        action: 'created',
        resourceType: 'annotation',
        resourceId: 'ann-1',
        metadata: { pin: 1 },
        createdAt: '2026-07-14T10:00:00Z',
      });
    });

    it('falls back to defaults when invalid pagination params provided', async () => {
      const { db, offset, limit } = makeMockDb([], 0);
      const app = makeApp({ authMiddleware: noopAuth, db });

      const res = await request(app).get('/api/v1/projects/proj-1/activity?page=abc&pageSize=-1');

      expect(res.status).toBe(200);
      // Invalid params should fall back to defaults
      expect(offset).toHaveBeenCalledWith(0);
      expect(limit).toHaveBeenCalledWith(25);
    });
  });
});
