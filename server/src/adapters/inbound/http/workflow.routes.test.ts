import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createWorkflowRoutes, type WorkflowRouteDeps } from './workflow.routes.js';

/**
 * Route tests for the workflow (automation rules) endpoints.
 * Validates IDOR fix: POST /rules must verify projectId belongs to
 * req.user.orgId when provided.
 */

const ORG_ID = 'a0000000-0000-0000-0000-000000000001';
const OTHER_ORG_ID = 'a0000000-0000-0000-0000-000000000002';
const PROJECT_ID = 'b0000000-0000-0000-0000-000000000001';

function fakeAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  (req as any).user = { userId: 'u1', email: 'a@b.com', orgId: ORG_ID, role: 'admin' };
  next();
}

function chainableBuilder(resolveValue: any = undefined) {
  const builder: any = {};
  const chain = () => builder;
  builder.where = vi.fn(chain);
  builder.join = vi.fn(chain);
  builder.select = vi.fn(chain);
  builder.first = vi.fn(() => Promise.resolve(resolveValue));
  builder.insert = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([resolveValue])) }));
  builder.update = vi.fn(() => Promise.resolve(1));
  builder.orderBy = vi.fn(chain);
  builder.limit = vi.fn(chain);
  builder.del = vi.fn(() => Promise.resolve(1));
  builder.returning = vi.fn(() => Promise.resolve([resolveValue]));
  return builder;
}

function makeApp(deps: WorkflowRouteDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/workflow', createWorkflowRoutes(deps));
  return app;
}

const VALID_RULE_BODY = {
  projectId: PROJECT_ID,
  name: 'Auto-assign critical',
  triggerEvent: 'annotation.created' as const,
  conditions: { severity: 'critical' },
  actionType: 'assign' as const,
  actionParams: { assigneeId: 'user-2' },
  priority: 1,
};

// =============================================================================
// Bug #5 — POST /rules: projectId (optional) must belong to caller's org
// =============================================================================
describe('workflow.routes — POST /api/v1/workflow/rules (IDOR fix #5)', () => {
  it('rejects creation when projectId does not belong to user org (cross-tenant IDOR)', async () => {
    // project not found for this org
    const db: any = vi.fn((table: string) => {
      if (table === 'projects') return chainableBuilder(undefined); // not found
      if (table === 'automation_rules') {
        const builder = chainableBuilder(undefined);
        builder.insert = vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: 'rule-1' }])),
        }));
        return builder;
      }
      return chainableBuilder(undefined);
    });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app)
      .post('/api/v1/workflow/rules')
      .send(VALID_RULE_BODY);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('Project not in your organization');

    // Verify projects was queried with org scope
    expect(db).toHaveBeenCalledWith('projects');
    const callIdx = db.mock.calls.findIndex((c: any[]) => c[0] === 'projects');
    const projectsBuilder = db.mock.results[callIdx].value;
    expect(projectsBuilder.where).toHaveBeenCalledWith({ id: PROJECT_ID, org_id: ORG_ID });
  });

  it('allows creation when projectId belongs to caller org', async () => {
    const ownedProject = { id: PROJECT_ID, org_id: ORG_ID };
    const insertedRule = { id: 'rule-new', org_id: ORG_ID, project_id: PROJECT_ID, name: 'Auto-assign critical' };
    const db: any = vi.fn((table: string) => {
      if (table === 'projects') return chainableBuilder(ownedProject);
      if (table === 'automation_rules') {
        const builder = chainableBuilder(undefined);
        builder.insert = vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([insertedRule])),
        }));
        return builder;
      }
      return chainableBuilder(undefined);
    });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app)
      .post('/api/v1/workflow/rules')
      .send(VALID_RULE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.rule).toBeDefined();
    expect(res.body.rule.id).toBe('rule-new');
  });

  it('allows creation without projectId (no ownership check needed)', async () => {
    const insertedRule = { id: 'rule-global', org_id: ORG_ID, name: 'Global rule' };
    const db: any = vi.fn((table: string) => {
      if (table === 'automation_rules') {
        const builder = chainableBuilder(undefined);
        builder.insert = vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([insertedRule])),
        }));
        return builder;
      }
      return chainableBuilder(undefined);
    });
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app)
      .post('/api/v1/workflow/rules')
      .send({
        name: 'Global rule',
        triggerEvent: 'annotation.created',
        actionType: 'assign',
        actionParams: { assigneeId: 'user-2' },
      });

    expect(res.status).toBe(201);
    expect(res.body.rule.id).toBe('rule-global');
    // projects table should NOT have been queried
    expect(db).not.toHaveBeenCalledWith('projects');
  });

  it('rejects invalid body (missing name)', async () => {
    const db: any = vi.fn(() => chainableBuilder(undefined));
    const app = makeApp({ authMiddleware: fakeAuth, db });

    const res = await request(app)
      .post('/api/v1/workflow/rules')
      .send({
        projectId: PROJECT_ID,
        triggerEvent: 'annotation.created',
        actionType: 'assign',
        actionParams: { assigneeId: 'user-2' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });
});
