import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createClientPortalRoutes, type ClientPortalRouteDeps } from './clientPortal.routes.js';

/**
 * Route tests for the client portal endpoint. Validates the IDOR fix:
 * POST /api/v1/portals must verify that the supplied projectId belongs
 * to req.user.orgId before creating a portal.
 */

const ORG_ID = 'a0000000-0000-0000-0000-000000000001';
const OTHER_ORG_ID = 'a0000000-0000-0000-0000-000000000002';
const PROJECT_ID = 'b0000000-0000-0000-0000-000000000001';

function fakeAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  (req as any).user = { userId: 'u1', email: 'a@b.com', orgId: ORG_ID, role: 'admin' };
  next();
}

interface MockDbOpts {
  /** Simulated project row returned by `projects` query (undefined = not found) */
  project?: { id: string; org_id: string } | undefined;
  /** Simulated inserted portal row returned by `.returning('*')` */
  insertedPortal?: any;
}

function makeMockDb(opts: MockDbOpts = {}): any {
  const { project, insertedPortal } = opts;

  const db: any = vi.fn((table: string) => {
    if (table === 'projects') {
      const builder: any = {};
      const chain = () => builder;
      builder.where = vi.fn(chain);
      builder.first = vi.fn(() => Promise.resolve(project));
      return builder;
    }

    if (table === 'client_portals') {
      const builder: any = {};
      const chain = () => builder;
      builder.where = vi.fn(chain);
      builder.orderBy = vi.fn(chain);
      builder.insert = vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([insertedPortal ?? { id: 'portal-1', ...opts }])),
      }));
      builder.del = vi.fn(() => Promise.resolve(1));
      builder.first = vi.fn(() => Promise.resolve(undefined));
      // Support chaining from where() for GET/DELETE
      builder.where = vi.fn((..._args: any[]) => builder);
      return builder;
    }

    // Default fallback
    const builder: any = {};
    const chain = () => builder;
    builder.where = vi.fn(chain);
    builder.first = vi.fn(() => Promise.resolve(undefined));
    return builder;
  });

  return db;
}

function makeApp(deps: ClientPortalRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/portals', createClientPortalRoutes(deps));
  return app;
}

const VALID_BODY = {
  projectId: PROJECT_ID,
  title: 'Test Portal',
  slug: 'test-portal',
};

describe('clientPortal.routes — POST /api/v1/portals (IDOR fix)', () => {
  it('rejects creation when project does not belong to user org (cross-tenant IDOR)', async () => {
    // Project not found for this org → 404
    const db = makeMockDb({ project: undefined });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app)
      .post('/api/v1/portals')
      .send(VALID_BODY);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Project not found');

    // Verify the projects table was queried with the correct org scope
    expect(db).toHaveBeenCalledWith('projects');
    const projectsBuilder = db.mock.results.find(
      (r: any) => r.type === 'return' && db.mock.calls.some((c: any[]) => c[0] === 'projects'),
    );
    // The builder.where should have been called with both id and org_id
    const projectsCall = db.mock.calls.findIndex((c: any[]) => c[0] === 'projects');
    const projectsResult = db.mock.results[projectsCall].value;
    expect(projectsResult.where).toHaveBeenCalledWith({
      id: PROJECT_ID,
      org_id: ORG_ID,
    });
  });

  it('allows creation when project belongs to the authenticated user org', async () => {
    const ownedProject = { id: PROJECT_ID, org_id: ORG_ID };
    const insertedPortal = {
      id: 'portal-new',
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      slug: 'test-portal',
      title: 'Test Portal',
    };
    const db = makeMockDb({ project: ownedProject, insertedPortal });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app)
      .post('/api/v1/portals')
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.portal).toBeDefined();
    expect(res.body.portal.id).toBe('portal-new');
  });

  it('rejects invalid body (missing title)', async () => {
    const db = makeMockDb({ project: { id: PROJECT_ID, org_id: ORG_ID } });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app)
      .post('/api/v1/portals')
      .send({ projectId: PROJECT_ID, slug: 'ok-slug' }); // missing title

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('rejects invalid projectId format (not uuid)', async () => {
    const db = makeMockDb({});
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app)
      .post('/api/v1/portals')
      .send({ projectId: 'not-a-uuid', title: 'Title', slug: 'my-slug' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });
});
