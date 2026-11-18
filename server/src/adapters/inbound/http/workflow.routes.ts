import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';
import { PaginationParamsSchema, paginationMeta } from '@pinpoint/shared';
import { sendZodFailure, validateUuidParam } from './errors.js';
import { findAccessibleProject, registerSessionDb, requireOrgAdmin } from './access.js';

export interface WorkflowRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

const CreateRuleSchema = z.object({
  projectId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  triggerEvent: z.enum(['annotation.created', 'annotation.status_changed', 'comment.created']),
  conditions: z.record(z.string(), z.unknown()).optional(),
  actionType: z.enum(['assign', 'set_status', 'set_due_date', 'notify']),
  actionParams: z.record(z.string(), z.unknown()),
  priority: z.number().int().optional(),
});

const CreateSlaSchema = z.object({
  name: z.string().min(1).max(255),
  severity: z.enum(['critical', 'major', 'minor']),
  responseTimeHours: z.number().int().min(1),
  resolutionTimeHours: z.number().int().min(1),
});

export function createWorkflowRoutes(deps: WorkflowRouteDeps): Router {
  const { authMiddleware, db } = deps;
  const router = Router();
  router.use(authMiddleware);
  registerSessionDb(db);

  // === Automation Rules ===

  router.get('/rules', async (req: Request, res: Response) => {
    const { page, pageSize } = PaginationParamsSchema.parse(req.query);
    const base = db('automation_rules').where('org_id', req.user!.orgId);
    const [{ count: total }] = await base.clone().count('* as count');
    const data = await base
      .clone()
      .orderBy('priority')
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    res.json({ data, pagination: paginationMeta(Number(total), page, pageSize) });
  });

  router.post('/rules', requireOrgAdmin, async (req: Request, res: Response) => {
    const parsed = CreateRuleSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid rule.', parsed.error.flatten()); return; }

    // Verify the caller can access the project when provided (prevent cross-tenant IDOR)
    if (parsed.data.projectId) {
      const project = await findAccessibleProject(db, req.user!, parsed.data.projectId);
      if (!project) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Project not in your organization' } });
        return;
      }
    }

    const [rule] = await db('automation_rules').insert({
      org_id: req.user!.orgId,
      project_id: parsed.data.projectId,
      name: parsed.data.name,
      trigger_event: parsed.data.triggerEvent,
      conditions: JSON.stringify(parsed.data.conditions ?? {}),
      action_type: parsed.data.actionType,
      action_params: JSON.stringify(parsed.data.actionParams),
      priority: parsed.data.priority ?? 0,
    }).returning('*');
    res.status(201).json({ rule });
  });

  router.patch('/rules/:id', requireOrgAdmin, async (req: Request, res: Response) => {
    if (!validateUuidParam(res, 'id', req.params.id as string)) return;
    const { active, priority, name } = req.body;
    const updated = await db('automation_rules')
      .where({ id: req.params.id, org_id: req.user!.orgId })
      .update({ ...(active !== undefined && { active }), ...(priority !== undefined && { priority }), ...(name && { name }), updated_at: db.fn.now() })
      .returning('*');
    if (!updated.length) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rule not found' } }); return; }
    res.json({ rule: updated[0] });
  });

  router.delete('/rules/:id', requireOrgAdmin, async (req: Request, res: Response) => {
    if (!validateUuidParam(res, 'id', req.params.id as string)) return;
    const deleted = await db('automation_rules').where({ id: req.params.id, org_id: req.user!.orgId }).del();
    if (!deleted) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rule not found' } }); return; }
    res.status(204).end();
  });

  // === SLA Policies ===

  router.get('/sla', async (req: Request, res: Response) => {
    const { page, pageSize } = PaginationParamsSchema.parse(req.query);
    const base = db('sla_policies').where('org_id', req.user!.orgId);
    const [{ count: total }] = await base.clone().count('* as count');
    const data = await base
      .clone()
      .orderBy('created_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    res.json({ data, pagination: paginationMeta(Number(total), page, pageSize) });
  });

  router.post('/sla', requireOrgAdmin, async (req: Request, res: Response) => {
    const parsed = CreateSlaSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid SLA.', parsed.error.flatten()); return; }

    const [policy] = await db('sla_policies').insert({
      org_id: req.user!.orgId,
      name: parsed.data.name,
      severity: parsed.data.severity,
      response_time_hours: parsed.data.responseTimeHours,
      resolution_time_hours: parsed.data.resolutionTimeHours,
    }).returning('*');
    res.status(201).json({ policy });
  });

  router.delete('/sla/:id', requireOrgAdmin, async (req: Request, res: Response) => {
    if (!validateUuidParam(res, 'id', req.params.id as string)) return;
    const deleted = await db('sla_policies').where({ id: req.params.id, org_id: req.user!.orgId }).del();
    if (!deleted) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'SLA policy not found' } }); return; }
    res.status(204).end();
  });

  // === SLA Breach Check (called by a scheduled job or on annotation update) ===

  router.get('/sla/breaches', async (req: Request, res: Response) => {
    const { page, pageSize } = PaginationParamsSchema.parse(req.query);
    const base = db('sla_breaches')
      .join('annotations', 'annotations.id', 'sla_breaches.annotation_id')
      .where('annotations.org_id', req.user!.orgId);
    const [{ count: total }] = await base.clone().count('sla_breaches.id as count');
    const data = await base
      .clone()
      .select('sla_breaches.*', 'annotations.body', 'annotations.severity', 'annotations.status')
      .orderBy('sla_breaches.breached_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    res.json({ data, pagination: paginationMeta(Number(total), page, pageSize) });
  });

  return router;
}
