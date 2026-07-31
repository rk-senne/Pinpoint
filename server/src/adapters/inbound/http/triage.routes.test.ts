import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createTriageRoutes, type TriageRouteDeps } from './triage.routes.js';

/**
 * Route tests for the AI triage endpoint. The Knex handle is mocked with a
 * chainable builder: intermediate methods return the builder, `.select()`
 * resolves the duplicate-scan rows, and `.first()` resolves the assignee
 * lookups (keyed by table so the annotations vs users queries differ).
 */

function noopAuth(_req: express.Request, _res: express.Response, next: express.NextFunction) {
  (_req as any).user = { userId: 'u1', email: 'a@b.com', orgId: ORG_ID, role: 'admin' };
  next();
}

const ORG_ID = 'a0000000-0000-0000-0000-000000000001';
const OTHER_ORG_ID = 'a0000000-0000-0000-0000-000000000002';

interface MockDbOpts {
  candidates?: Array<{ id: string; body: string; pin_number: number }>;
  topResolver?: { assignee_id: string } | undefined;
  user?: { id: string; email: string } | undefined;
  /** Whether the project ownership check should pass (default: true) */
  projectOwned?: boolean;
}

function makeDb(opts: MockDbOpts = {}): any {
  const { candidates = [], topResolver, user, projectOwned = true } = opts;
  return vi.fn((table: string) => {
    if (table === 'projects') {
      const builder: any = {};
      const chain = () => builder;
      builder.where = vi.fn(chain);
      builder.first = vi.fn(() => Promise.resolve(projectOwned ? { id: 'proj-1', org_id: ORG_ID } : undefined));
      return builder;
    }
    const builder: any = {};
    const chain = () => builder;
    builder.where = vi.fn(chain);
    builder.whereRaw = vi.fn(chain);
    builder.whereNotNull = vi.fn(chain);
    builder.orderBy = vi.fn(chain);
    builder.orderByRaw = vi.fn(chain);
    builder.groupBy = vi.fn(chain);
    builder.limit = vi.fn(chain);
    builder.select = vi.fn(() => Promise.resolve(candidates));
    builder.first = vi.fn(() => Promise.resolve(table === 'users' ? user : topResolver));
    return builder;
  });
}

function makeApp(deps: TriageRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/projects', createTriageRoutes(deps));
  return app;
}

const PROJECT = 'p0000000-0000-0000-0000-000000000001';

describe('triage.routes — POST /api/v1/projects/:id/annotations/triage', () => {
  it('rejects an empty body', async () => {
    const app = makeApp({ authMiddleware: noopAuth, db: makeDb() });
    const res = await request(app)
      .post(`/api/v1/projects/${PROJECT}/annotations/triage`)
      .send({ body: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('rejects a missing body', async () => {
    const app = makeApp({ authMiddleware: noopAuth, db: makeDb() });
    const res = await request(app)
      .post(`/api/v1/projects/${PROJECT}/annotations/triage`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('rejects a non-uuid excludeId', async () => {
    const app = makeApp({ authMiddleware: noopAuth, db: makeDb() });
    const res = await request(app)
      .post(`/api/v1/projects/${PROJECT}/annotations/triage`)
      .send({ body: 'something broke', excludeId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('suggests severity and tags, and detects a duplicate', async () => {
    const db = makeDb({
      candidates: [
        { id: 'a0000000-0000-0000-0000-000000000001', body: 'the mobile menu is broken', pin_number: 7 },
        { id: 'a0000000-0000-0000-0000-000000000002', body: 'please add a dark theme', pin_number: 8 },
      ],
    });
    const app = makeApp({ authMiddleware: noopAuth, db });

    const res = await request(app)
      .post(`/api/v1/projects/${PROJECT}/annotations/triage`)
      .send({ body: 'the mobile menu is broken' });

    expect(res.status).toBe(200);
    expect(res.body.suggestedSeverity).toBe('critical'); // "broken"
    expect(res.body.suggestedTags).toContain('mobile');
    // The identical candidate is a duplicate; the unrelated one is not.
    expect(res.body.duplicates).toHaveLength(1);
    expect(res.body.duplicates[0].id).toBe('a0000000-0000-0000-0000-000000000001');
    expect(res.body.duplicates[0].pinNumber).toBe(7);
    expect(res.body.duplicates[0].similarity).toBeGreaterThan(0.6);
    expect(res.body.suggestedAssignee).toBeNull(); // no cssSelector provided
  });

  it('suggests an assignee when a cssSelector with resolution history is provided', async () => {
    const db = makeDb({
      candidates: [],
      topResolver: { assignee_id: 'u0000000-0000-0000-0000-000000000009' },
      user: { id: 'u0000000-0000-0000-0000-000000000009', email: 'dev@example.com' },
    });
    const app = makeApp({ authMiddleware: noopAuth, db });

    const res = await request(app)
      .post(`/api/v1/projects/${PROJECT}/annotations/triage`)
      .send({ body: 'button colour is off', target: { cssSelector: '.btn-primary' } });

    expect(res.status).toBe(200);
    expect(res.body.suggestedAssignee).toEqual({
      userId: 'u0000000-0000-0000-0000-000000000009',
      email: 'dev@example.com',
      reason: 'Resolved similar issues on this element before',
    });
    expect(res.body.duplicates).toEqual([]);
  });

  it('returns informational severity and no tags for neutral praise', async () => {
    const app = makeApp({ authMiddleware: noopAuth, db: makeDb({ candidates: [] }) });
    const res = await request(app)
      .post(`/api/v1/projects/${PROJECT}/annotations/triage`)
      .send({ body: 'Really enjoying the new homepage hero' });

    expect(res.status).toBe(200);
    expect(res.body.suggestedSeverity).toBe('informational');
    expect(res.body.suggestedTags).toEqual([]);
    expect(res.body.duplicates).toEqual([]);
  });

  it('rejects cross-tenant access with 404 when project does not belong to user org', async () => {
    const db = makeDb({ candidates: [], projectOwned: false });
    const app = makeApp({ authMiddleware: noopAuth, db });

    const res = await request(app)
      .post(`/api/v1/projects/${PROJECT}/annotations/triage`)
      .send({ body: 'something broke' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
