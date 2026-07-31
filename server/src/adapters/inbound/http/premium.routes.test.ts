import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createPremiumRoutes, type PremiumRouteDeps } from './premium.routes.js';

/**
 * Route tests for the premium endpoints. Validates IDOR fixes:
 * - POST /boards must verify projectId belongs to req.user.orgId
 * - POST /approvals/workflows must verify projectId (when provided) belongs to req.user.orgId
 * - POST /approvals/start must verify annotationId belongs to req.user.orgId
 * - POST /approvals/:instanceId/advance must verify instance belongs to caller's org via workflow join
 */

const ORG_ID = 'a0000000-0000-0000-0000-000000000001';
const OTHER_ORG_ID = 'a0000000-0000-0000-0000-000000000002';
const PROJECT_ID = 'b0000000-0000-0000-0000-000000000001';
const ANNOTATION_ID = 'c0000000-0000-0000-0000-000000000001';
const WORKFLOW_ID = 'd0000000-0000-0000-0000-000000000001';
const INSTANCE_ID = 'e0000000-0000-0000-0000-000000000001';

function fakeAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  (req as any).user = { userId: 'u1', email: 'a@b.com', orgId: ORG_ID, role: 'admin' };
  next();
}

/**
 * Builds a chainable mock builder that records calls and resolves the given value.
 */
function chainableBuilder(resolveValue: any = undefined) {
  const builder: any = {};
  const chain = () => builder;
  builder.where = vi.fn(chain);
  builder.join = vi.fn(chain);
  builder.select = vi.fn(chain);
  builder.first = vi.fn(() => Promise.resolve(resolveValue));
  builder.insert = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([resolveValue])) }));
  builder.update = vi.fn(() => Promise.resolve(1));
  builder.increment = vi.fn(() => Promise.resolve(1));
  builder.orderBy = vi.fn(chain);
  builder.limit = vi.fn(chain);
  return builder;
}

interface MockDbConfig {
  /** Row returned by projects query (undefined = not found) */
  project?: { id: string; org_id: string } | undefined;
  /** Row returned by annotations query (undefined = not found) */
  annotation?: { id: string; org_id: string } | undefined;
  /** Row returned by approval_workflows query */
  workflow?: any;
  /** Row returned by approval_instances (join) query */
  instance?: any;
  /** Row returned by feedback_boards insert */
  insertedBoard?: any;
  /** Row returned by approval_workflows insert */
  insertedWorkflow?: any;
  /** Row returned by approval_instances insert */
  insertedInstance?: any;
}

function makeMockDb(config: MockDbConfig = {}): any {
  const db: any = vi.fn((table: string) => {
    if (table === 'projects') {
      return chainableBuilder(config.project);
    }
    if (table === 'annotations') {
      return chainableBuilder(config.annotation);
    }
    if (table === 'feedback_boards') {
      const builder = chainableBuilder(config.insertedBoard ?? { id: 'board-1' });
      builder.insert = vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([config.insertedBoard ?? { id: 'board-1' }])),
      }));
      return builder;
    }
    if (table === 'approval_workflows') {
      return chainableBuilder(config.workflow);
    }
    if (table === 'approval_instances') {
      const builder = chainableBuilder(config.instance);
      builder.insert = vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([config.insertedInstance ?? { id: INSTANCE_ID }])),
      }));
      builder.update = vi.fn(() => Promise.resolve(1));
      return builder;
    }
    return chainableBuilder(undefined);
  });
  return db;
}

function makeApp(deps: PremiumRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createPremiumRoutes(deps));
  return app;
}

// =============================================================================
// Bug #1 — POST /boards: projectId must belong to caller's org
// =============================================================================
describe('premium.routes — POST /api/v1/boards (IDOR fix #1)', () => {
  const VALID_BODY = {
    projectId: PROJECT_ID,
    title: 'My Board',
    slug: 'my-board',
    description: 'A test board',
  };

  it('rejects creation when project does not belong to user org (cross-tenant IDOR)', async () => {
    const db = makeMockDb({ project: undefined }); // project not found for this org
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app)
      .post('/api/v1/boards')
      .send(VALID_BODY);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('Project not in your organization');

    // Verify projects table was queried with org scope
    expect(db).toHaveBeenCalledWith('projects');
    const projectsCallIdx = db.mock.calls.findIndex((c: any[]) => c[0] === 'projects');
    const projectsBuilder = db.mock.results[projectsCallIdx].value;
    expect(projectsBuilder.where).toHaveBeenCalledWith({ id: PROJECT_ID, org_id: ORG_ID });
  });

  it('allows creation when project belongs to caller org', async () => {
    const ownedProject = { id: PROJECT_ID, org_id: ORG_ID };
    const insertedBoard = { id: 'board-new', org_id: ORG_ID, project_id: PROJECT_ID, slug: 'my-board', title: 'My Board' };
    const db = makeMockDb({ project: ownedProject, insertedBoard });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app)
      .post('/api/v1/boards')
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.board).toBeDefined();
    expect(res.body.board.id).toBe('board-new');
  });
});

// =============================================================================
// Bug #2 — POST /approvals/workflows: projectId (optional) must belong to org
// =============================================================================
describe('premium.routes — POST /api/v1/approvals/workflows (IDOR fix #2)', () => {
  const VALID_BODY = {
    name: 'Review workflow',
    projectId: PROJECT_ID,
    steps: [{ approver: 'user-1', role: 'reviewer' }],
  };

  it('rejects creation when projectId does not belong to user org', async () => {
    const db = makeMockDb({ project: undefined }); // project not in caller's org
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app)
      .post('/api/v1/approvals/workflows')
      .send(VALID_BODY);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('Project not in your organization');
  });

  it('allows creation when projectId belongs to caller org', async () => {
    const ownedProject = { id: PROJECT_ID, org_id: ORG_ID };
    const insertedWorkflow = { id: 'wf-new', org_id: ORG_ID, project_id: PROJECT_ID, name: 'Review workflow' };
    const db = makeMockDb({ project: ownedProject, insertedWorkflow });
    // Override approval_workflows to return inserted row
    const origFn = db;
    const patchedDb: any = vi.fn((table: string) => {
      if (table === 'projects') return chainableBuilder(ownedProject);
      if (table === 'approval_workflows') {
        const builder = chainableBuilder(undefined);
        builder.insert = vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([insertedWorkflow])),
        }));
        return builder;
      }
      return chainableBuilder(undefined);
    });
    const app = makeApp({ authMiddleware: fakeAuth, db: patchedDb });

    const res = await request(app)
      .post('/api/v1/approvals/workflows')
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.workflow).toBeDefined();
    expect(res.body.workflow.id).toBe('wf-new');
  });

  it('allows creation without projectId (no ownership check needed)', async () => {
    const insertedWorkflow = { id: 'wf-new', org_id: ORG_ID, name: 'Global workflow' };
    const patchedDb: any = vi.fn((table: string) => {
      if (table === 'approval_workflows') {
        const builder = chainableBuilder(undefined);
        builder.insert = vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([insertedWorkflow])),
        }));
        return builder;
      }
      return chainableBuilder(undefined);
    });
    const app = makeApp({ authMiddleware: fakeAuth, db: patchedDb });

    const res = await request(app)
      .post('/api/v1/approvals/workflows')
      .send({ name: 'Global workflow', steps: [{ approver: 'user-1' }] });

    expect(res.status).toBe(201);
    expect(res.body.workflow.id).toBe('wf-new');
    // projects table should NOT have been queried
    expect(patchedDb).not.toHaveBeenCalledWith('projects');
  });
});

// =============================================================================
// Bug #3 — POST /approvals/start: annotationId must belong to caller's org
// =============================================================================
describe('premium.routes — POST /api/v1/approvals/start (IDOR fix #3)', () => {
  const VALID_BODY = {
    workflowId: WORKFLOW_ID,
    annotationId: ANNOTATION_ID,
  };

  it('rejects when annotation does not belong to user org (cross-tenant IDOR)', async () => {
    const workflow = { id: WORKFLOW_ID, org_id: ORG_ID, steps: JSON.stringify([{ approver: 'u1' }]) };
    // Workflow is found but annotation is not in caller's org
    const patchedDb: any = vi.fn((table: string) => {
      if (table === 'approval_workflows') return chainableBuilder(workflow);
      if (table === 'annotations') return chainableBuilder(undefined); // not found
      if (table === 'approval_instances') {
        const builder = chainableBuilder(undefined);
        builder.insert = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: INSTANCE_ID }])) }));
        return builder;
      }
      return chainableBuilder(undefined);
    });
    const app = makeApp({ authMiddleware: fakeAuth, db: patchedDb });

    const res = await request(app)
      .post('/api/v1/approvals/start')
      .send(VALID_BODY);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Annotation not found');

    // Verify annotations was queried with org scope
    expect(patchedDb).toHaveBeenCalledWith('annotations');
    const annCallIdx = patchedDb.mock.calls.findIndex((c: any[]) => c[0] === 'annotations');
    const annBuilder = patchedDb.mock.results[annCallIdx].value;
    expect(annBuilder.where).toHaveBeenCalledWith({ id: ANNOTATION_ID, org_id: ORG_ID });
  });

  it('allows start when both workflow and annotation belong to user org', async () => {
    const workflow = { id: WORKFLOW_ID, org_id: ORG_ID, steps: JSON.stringify([{ approver: 'u1' }]) };
    const annotation = { id: ANNOTATION_ID, org_id: ORG_ID };
    const insertedInstance = { id: INSTANCE_ID, workflow_id: WORKFLOW_ID, annotation_id: ANNOTATION_ID };
    const patchedDb: any = vi.fn((table: string) => {
      if (table === 'approval_workflows') return chainableBuilder(workflow);
      if (table === 'annotations') return chainableBuilder(annotation);
      if (table === 'approval_instances') {
        const builder = chainableBuilder(undefined);
        builder.insert = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([insertedInstance])) }));
        return builder;
      }
      return chainableBuilder(undefined);
    });
    const app = makeApp({ authMiddleware: fakeAuth, db: patchedDb });

    const res = await request(app)
      .post('/api/v1/approvals/start')
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.instance).toBeDefined();
    expect(res.body.instance.id).toBe(INSTANCE_ID);
  });
});

// =============================================================================
// Bug #4 — POST /approvals/:instanceId/advance: instance must belong to caller's org
// =============================================================================
describe('premium.routes — POST /api/v1/approvals/:instanceId/advance (IDOR fix #4)', () => {
  it('rejects when instance does not belong to user org (cross-tenant IDOR)', async () => {
    // Instance join returns nothing (not in caller's org)
    const patchedDb: any = vi.fn((table: string) => {
      if (table === 'approval_instances') {
        const builder: any = {};
        const chain = () => builder;
        builder.join = vi.fn(chain);
        builder.where = vi.fn(chain);
        builder.select = vi.fn(chain);
        builder.first = vi.fn(() => Promise.resolve(undefined)); // not found
        builder.update = vi.fn(() => Promise.resolve(1));
        return builder;
      }
      return chainableBuilder(undefined);
    });
    const app = makeApp({ authMiddleware: fakeAuth, db: patchedDb });

    const res = await request(app)
      .post(`/api/v1/approvals/${INSTANCE_ID}/advance`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Approval instance not found');

    // Verify the join query was used with org scope
    expect(patchedDb).toHaveBeenCalledWith('approval_instances');
    const callIdx = patchedDb.mock.calls.findIndex((c: any[]) => c[0] === 'approval_instances');
    const instanceBuilder = patchedDb.mock.results[callIdx].value;
    expect(instanceBuilder.join).toHaveBeenCalledWith(
      'approval_workflows', 'approval_workflows.id', 'approval_instances.workflow_id',
    );
    expect(instanceBuilder.where).toHaveBeenCalledWith({
      'approval_instances.id': INSTANCE_ID,
      'approval_workflows.org_id': ORG_ID,
    });
  });

  it('advances when instance belongs to caller org', async () => {
    const instance = { id: INSTANCE_ID, workflow_id: WORKFLOW_ID, current_step: 0, step_history: '[]' };
    const workflow = { id: WORKFLOW_ID, org_id: ORG_ID, steps: JSON.stringify([{ approver: 'u1' }, { approver: 'u2' }]) };
    let callCount = 0;
    const patchedDb: any = vi.fn((table: string) => {
      if (table === 'approval_instances') {
        callCount++;
        if (callCount === 1) {
          // First call: the join query to verify ownership
          const builder: any = {};
          const chain = () => builder;
          builder.join = vi.fn(chain);
          builder.where = vi.fn(chain);
          builder.select = vi.fn(chain);
          builder.first = vi.fn(() => Promise.resolve(instance));
          return builder;
        } else {
          // Second call: the update query
          const builder: any = {};
          const chain = () => builder;
          builder.where = vi.fn(chain);
          builder.update = vi.fn(() => Promise.resolve(1));
          return builder;
        }
      }
      if (table === 'approval_workflows') return chainableBuilder(workflow);
      return chainableBuilder(undefined);
    });
    const app = makeApp({ authMiddleware: fakeAuth, db: patchedDb });

    const res = await request(app)
      .post(`/api/v1/approvals/${INSTANCE_ID}/advance`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('in_progress');
    expect(res.body.currentStep).toBe(1);
    expect(res.body.totalSteps).toBe(2);
  });
});
