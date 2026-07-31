import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createTagRoutes, type TagRouteDeps } from './tags.routes.js';

/**
 * Unit tests for tag routes — tests schema validation and route behaviour
 * using mock knex objects. The auth middleware is a passthrough.
 */

function noopAuth(_req: express.Request, _res: express.Response, next: express.NextFunction) {
  (_req as any).user = { userId: 'u1', email: 'a@b.com', orgId: ORG_ID, role: 'admin' };
  next();
}

const ORG_ID = 'a0000000-0000-0000-0000-000000000001';

function makeApp(deps: TagRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createTagRoutes(deps));
  return app;
}

describe('tags.routes', () => {
  let mockDb: any;

  beforeEach(() => {
    mockDb = vi.fn();
  });

  describe('GET /api/v1/projects/:id/tags', () => {
    it('returns empty array initially', async () => {
      const orderBy = vi.fn().mockResolvedValue([]);
      const whereTags = vi.fn().mockReturnValue({ orderBy });
      mockDb = vi.fn().mockImplementation((table: string) => {
        if (table === 'projects') {
          const b: any = {};
          b.where = vi.fn().mockReturnValue(b);
          b.first = vi.fn().mockResolvedValue({ id: 'proj-1', org_id: ORG_ID });
          return b;
        }
        return { where: whereTags };
      });

      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app).get('/api/v1/projects/proj-1/tags');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tags: [] });
      expect(whereTags).toHaveBeenCalledWith('project_id', 'proj-1');
      expect(orderBy).toHaveBeenCalledWith('name', 'asc');
    });

    it('rejects cross-tenant access with 404 when project does not belong to user org', async () => {
      mockDb = vi.fn().mockImplementation((table: string) => {
        if (table === 'projects') {
          const b: any = {};
          b.where = vi.fn().mockReturnValue(b);
          b.first = vi.fn().mockResolvedValue(undefined);
          return b;
        }
        return {};
      });

      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app).get('/api/v1/projects/proj-1/tags');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/v1/projects/:id/tags', () => {
    it('creates a tag with name and color', async () => {
      const tagRow = {
        id: 'tag-uuid',
        project_id: 'proj-1',
        name: 'Bug',
        color: '#ff0000',
        created_at: '2026-07-14T00:00:00Z',
      };
      const returning = vi.fn().mockResolvedValue([tagRow]);
      const insert = vi.fn().mockReturnValue({ returning });
      mockDb = vi.fn().mockImplementation((table: string) => {
        if (table === 'projects') {
          const b: any = {};
          b.where = vi.fn().mockReturnValue(b);
          b.first = vi.fn().mockResolvedValue({ id: 'proj-1', org_id: ORG_ID });
          return b;
        }
        return { insert };
      });

      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app)
        .post('/api/v1/projects/proj-1/tags')
        .send({ name: 'Bug', color: '#ff0000' });

      expect(res.status).toBe(201);
      expect(res.body.tag).toEqual({
        id: 'tag-uuid',
        projectId: 'proj-1',
        name: 'Bug',
        color: '#ff0000',
        createdAt: '2026-07-14T00:00:00Z',
      });
      expect(insert).toHaveBeenCalledWith({
        project_id: 'proj-1',
        name: 'Bug',
        color: '#ff0000',
      });
    });

    it('rejects invalid color format', async () => {
      mockDb = vi.fn().mockReturnValue({});
      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app)
        .post('/api/v1/projects/proj-1/tags')
        .send({ name: 'Bug', color: 'red' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('rejects missing name', async () => {
      mockDb = vi.fn().mockReturnValue({});
      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app)
        .post('/api/v1/projects/proj-1/tags')
        .send({ color: '#ff0000' });

      expect(res.status).toBe(400);
    });

    it('returns 409 on duplicate name (PG unique violation)', async () => {
      const pgError = new Error('unique_violation') as any;
      pgError.code = '23505';
      const returning = vi.fn().mockRejectedValue(pgError);
      const insert = vi.fn().mockReturnValue({ returning });
      mockDb = vi.fn().mockImplementation((table: string) => {
        if (table === 'projects') {
          const b: any = {};
          b.where = vi.fn().mockReturnValue(b);
          b.first = vi.fn().mockResolvedValue({ id: 'proj-1', org_id: ORG_ID });
          return b;
        }
        return { insert };
      });

      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app)
        .post('/api/v1/projects/proj-1/tags')
        .send({ name: 'Bug', color: '#ff0000' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE');
    });

    it('rejects cross-tenant access with 404 when project does not belong to user org', async () => {
      mockDb = vi.fn().mockImplementation((table: string) => {
        if (table === 'projects') {
          const b: any = {};
          b.where = vi.fn().mockReturnValue(b);
          b.first = vi.fn().mockResolvedValue(undefined);
          return b;
        }
        return {};
      });

      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app)
        .post('/api/v1/projects/proj-1/tags')
        .send({ name: 'Bug', color: '#ff0000' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('DELETE /api/v1/projects/:id/tags/:tagId', () => {
    it('returns 204 when tag is deleted', async () => {
      const del = vi.fn().mockResolvedValue(1);
      const whereTags = vi.fn().mockReturnValue({ del });
      mockDb = vi.fn().mockImplementation((table: string) => {
        if (table === 'projects') {
          const b: any = {};
          b.where = vi.fn().mockReturnValue(b);
          b.first = vi.fn().mockResolvedValue({ id: 'proj-1', org_id: ORG_ID });
          return b;
        }
        return { where: whereTags };
      });

      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app).delete('/api/v1/projects/proj-1/tags/tag-1');
      expect(res.status).toBe(204);
      expect(whereTags).toHaveBeenCalledWith({ id: 'tag-1', project_id: 'proj-1' });
    });

    it('returns 404 when tag does not exist', async () => {
      const del = vi.fn().mockResolvedValue(0);
      const whereTags = vi.fn().mockReturnValue({ del });
      mockDb = vi.fn().mockImplementation((table: string) => {
        if (table === 'projects') {
          const b: any = {};
          b.where = vi.fn().mockReturnValue(b);
          b.first = vi.fn().mockResolvedValue({ id: 'proj-1', org_id: ORG_ID });
          return b;
        }
        return { where: whereTags };
      });

      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app).delete('/api/v1/projects/proj-1/tags/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('rejects cross-tenant access with 404 when project does not belong to user org', async () => {
      mockDb = vi.fn().mockImplementation((table: string) => {
        if (table === 'projects') {
          const b: any = {};
          b.where = vi.fn().mockReturnValue(b);
          b.first = vi.fn().mockResolvedValue(undefined);
          return b;
        }
        return {};
      });

      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app).delete('/api/v1/projects/proj-1/tags/tag-1');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('PUT /api/v1/annotations/:annotationId/tags', () => {
    it('sets tags on an annotation', async () => {
      const tagRows = [
        { id: 'tag-1', project_id: 'proj-1', name: 'Bug', color: '#ff0000', created_at: '2026-07-14T00:00:00Z' },
      ];

      // Mock for the transaction
      const trxDel = vi.fn().mockResolvedValue(1);
      const trxWhere = vi.fn().mockReturnValue({ del: trxDel });
      const trxInsert = vi.fn().mockResolvedValue(undefined);
      const trxTable = vi.fn().mockImplementation(() => ({
        where: trxWhere,
        insert: trxInsert,
      }));

      const selectFn = vi.fn().mockResolvedValue(tagRows);
      const joinWhere = vi.fn().mockReturnValue({ select: selectFn });
      const joinFn = vi.fn().mockReturnValue({ where: joinWhere });

      // Build the mock db
      const transactionFn = vi.fn().mockImplementation(async (cb: (trx: any) => Promise<void>) => {
        await cb(trxTable);
      });

      mockDb = vi.fn().mockImplementation((tableName: string) => {
        if (tableName === 'annotations') {
          const b: any = {};
          b.where = vi.fn().mockReturnValue(b);
          b.first = vi.fn().mockResolvedValue({ id: 'ann-1', org_id: ORG_ID });
          return b;
        }
        if (tableName === 'tags') {
          return { join: joinFn };
        }
        return {};
      });
      mockDb.transaction = transactionFn;

      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app)
        .put('/api/v1/annotations/ann-1/tags')
        .send({ tagIds: ['a0000000-0000-0000-0000-000000000001'] });

      expect(res.status).toBe(200);
      expect(res.body.tags).toHaveLength(1);
      expect(res.body.tags[0].name).toBe('Bug');
    });

    it('rejects invalid tagIds (non-uuid)', async () => {
      mockDb = vi.fn().mockReturnValue({});
      mockDb.transaction = vi.fn();

      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app)
        .put('/api/v1/annotations/ann-1/tags')
        .send({ tagIds: ['not-a-uuid'] });

      expect(res.status).toBe(400);
    });

    it('rejects cross-tenant access with 404 when annotation does not belong to user org', async () => {
      mockDb = vi.fn().mockImplementation((tableName: string) => {
        if (tableName === 'annotations') {
          const b: any = {};
          b.where = vi.fn().mockReturnValue(b);
          b.first = vi.fn().mockResolvedValue(undefined);
          return b;
        }
        return {};
      });
      mockDb.transaction = vi.fn();

      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app)
        .put('/api/v1/annotations/ann-1/tags')
        .send({ tagIds: ['a0000000-0000-0000-0000-000000000001'] });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/v1/annotations/:annotationId/tags', () => {
    it('rejects cross-tenant access with 404 when annotation does not belong to user org', async () => {
      mockDb = vi.fn().mockImplementation((tableName: string) => {
        if (tableName === 'annotations') {
          const b: any = {};
          b.where = vi.fn().mockReturnValue(b);
          b.first = vi.fn().mockResolvedValue(undefined);
          return b;
        }
        return {};
      });

      const app = makeApp({ authMiddleware: noopAuth, db: mockDb as any });

      const res = await request(app).get('/api/v1/annotations/ann-1/tags');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
