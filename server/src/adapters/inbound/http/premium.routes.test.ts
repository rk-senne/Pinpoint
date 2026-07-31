import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPremiumRoutes, type PremiumRouteDeps } from './premium.routes.js';

function makeApp(deps: PremiumRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  const router = createPremiumRoutes(deps);
  app.use('/api/v1', router);
  return app;
}

function mockAuthMiddleware(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  (req as any).user = { userId: 'u1', orgId: 'org1', role: 'admin', email: 'a@b.com' };
  next();
}

function fakeDb() {
  const rows: Record<string, any[]> = {};
  const db: any = (table: string) => {
    const q: any = {
      _table: table,
      _wheres: {},
      where: (cond: any) => { Object.assign(q._wheres, cond); return q; },
      whereNotNull: () => q,
      whereNull: () => q,
      insert: (data: any) => ({ returning: () => [{ id: 'new-1', ...data }], onConflict: () => ({ ignore: () => Promise.resolve() }) }),
      returning: () => [{ id: 'new-1' }],
      first: () => {
        if (q._table === 'feedback_boards') return { id: 'b1', title: 'Board', allow_submissions: true };
        if (q._table === 'approval_workflows') return { id: 'w1', steps: '[{"approver":"u1"}]' };
        if (q._table === 'approval_instances') return { id: 'i1', workflow_id: 'w1', current_step: 0, step_history: '[]' };
        if (q._table === 'annotations') return { id: 'a1', author_id: 'u2', assignee_id: 'u3' };
        if (q._table === 'satisfaction_scores') return null;
        return null;
      },
      orderBy: () => q,
      limit: () => [],
      select: () => [{ avg_score: 4.2, total_ratings: 10 }],
      increment: () => Promise.resolve(),
      update: () => 1,
    };
    return q;
  };
  db.raw = () => Promise.resolve();
  return db;
}

describe('premium.routes — Zod validation', () => {
  let app: express.Express;

  beforeEach(() => {
    app = makeApp({
      authMiddleware: mockAuthMiddleware,
      db: fakeDb(),
    });
  });

  describe('POST /api/v1/boards', () => {
    it('rejects missing projectId', async () => {
      const res = await request(app)
        .post('/api/v1/boards')
        .send({ title: 'Test', slug: 'test' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('rejects invalid slug (uppercase)', async () => {
      const res = await request(app)
        .post('/api/v1/boards')
        .send({ projectId: '00000000-0000-0000-0000-000000000001', title: 'T', slug: 'INVALID' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('rejects non-UUID projectId', async () => {
      const res = await request(app)
        .post('/api/v1/boards')
        .send({ projectId: 'not-a-uuid', title: 'T', slug: 'valid-slug' });
      expect(res.status).toBe(400);
    });

    it('accepts valid board creation', async () => {
      const res = await request(app)
        .post('/api/v1/boards')
        .send({
          projectId: '00000000-0000-0000-0000-000000000001',
          title: 'Feature Requests',
          slug: 'feature-requests',
        });
      expect(res.status).toBe(201);
      expect(res.body.board).toBeDefined();
    });
  });

  describe('POST /api/v1/csat/request', () => {
    it('rejects missing annotationId', async () => {
      const res = await request(app)
        .post('/api/v1/csat/request')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('rejects non-UUID annotationId', async () => {
      const res = await request(app)
        .post('/api/v1/csat/request')
        .send({ annotationId: 'abc' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/v1/csat/rate/:token', () => {
    it('rejects score out of range', async () => {
      const res = await request(app)
        .post('/api/v1/csat/rate/sometoken')
        .send({ score: 6 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('rejects non-integer score', async () => {
      const res = await request(app)
        .post('/api/v1/csat/rate/sometoken')
        .send({ score: 3.5 });
      expect(res.status).toBe(400);
    });

    it('rejects missing score', async () => {
      const res = await request(app)
        .post('/api/v1/csat/rate/sometoken')
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/v1/approvals/workflows', () => {
    it('rejects missing name', async () => {
      const res = await request(app)
        .post('/api/v1/approvals/workflows')
        .send({ steps: [{ approver: 'u1' }] });
      expect(res.status).toBe(400);
    });

    it('rejects empty steps', async () => {
      const res = await request(app)
        .post('/api/v1/approvals/workflows')
        .send({ name: 'Review', steps: [] });
      expect(res.status).toBe(400);
    });

    it('rejects steps without approver field', async () => {
      const res = await request(app)
        .post('/api/v1/approvals/workflows')
        .send({ name: 'Review', steps: [{}] });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/v1/approvals/start', () => {
    it('rejects non-UUID workflowId', async () => {
      const res = await request(app)
        .post('/api/v1/approvals/start')
        .send({ workflowId: 'bad', annotationId: '00000000-0000-0000-0000-000000000001' });
      expect(res.status).toBe(400);
    });

    it('rejects missing annotationId', async () => {
      const res = await request(app)
        .post('/api/v1/approvals/start')
        .send({ workflowId: '00000000-0000-0000-0000-000000000001' });
      expect(res.status).toBe(400);
    });
  });
});
