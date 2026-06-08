import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';
import { sendZodFailure } from './errors.js';

export interface WorkflowRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

const CreateRuleSchema = z.object({
  projectId: z.string().uuid().optional(),
  name: z.string().min(1),
  triggerEvent: z.enum(['annotation.created', 'annotation.status_changed', 'comment.created']),
  conditions: z.record(z.unknown()).optional(),
  actionType: z.enum(['assign', 'set_status', 'set_due_date', 'notify']),
  actionParams: z.record(z.unknown()),
  priority: z.number().int().optional(),
});

const CreateSlaSchema = z.object({
  name: z.string().min(1),
  severity: z.enum(['critical', 'major', 'minor']),
  responseTimeHours: z.number().int().min(1),
  resolutionTimeHours: z.number().int().min(1),
});

export function createWorkflowRoutes(deps: WorkflowRouteDeps): Router {
  const { authMiddleware, db } = deps;
  const router = Router();
  router.use(authMiddleware);

  // === Automation Rules ===

  router.get('/rules', async (req: Request, res: Response) => {
    const rules = await db('automation_rules').where('org_id', req.user!.orgId).orderBy('priority');
    res.json({ rules });
  });

  router.post('/rules', async (req: Request, res: Response) => {
    const parsed = CreateRuleSchema.safeParse(req.body);
    if (!parsed.success) { sendZodFailure(res, 'Invalid rule.', parsed.error.flatten()); return; }

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

  router.patch('/rules/:id', async (req: Request, res: Response) => {
    const { active, priority, name } = req.body;
    const updated = await db('automation_rules')
      .where({ id: req.params.id, org_id: req.user!.orgId })
      .update({ ...(active !== undefined && { active }), ...(priority !== undefined && { priority }), ...(name && { name }), updated_at: db.fn.now() })
      .returning('*');
    if (!updated.length) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rule not found' } }); return; }
    res.json({ rule: updated[0] });
  });

  router.delete('/rules/:id', async (req: Request, res: Response) => {
    const deleted = await db('automation_rules').where({ id: req.params.id, org_id: req.user!.orgId }).del();
    if (!deleted) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rule not found' } }); return; }
    res.status(204).end();
  });

  // === SLA Policies ===

  router.get('/sla', async (req: Request, res: Response) => {
    const policies = await db('sla_policies').where('org_id', req.user!.orgId);
    res.json({ policies });
  });

  router.post('/sla', async (req: Request, res: Response) => {
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

  router.delete('/sla/:id', async (req: Request, res: Response) => {
    await db('sla_policies').where({ id: req.params.id, org_id: req.user!.orgId }).del();
    res.status(204).end();
  });

  // === SLA Breach Check (called by a scheduled job or on annotation update) ===

  router.get('/sla/breaches', async (req: Request, res: Response) => {
    const breaches = await db('sla_breaches')
      .join('annotations', 'annotations.id', 'sla_breaches.annotation_id')
      .where('annotations.org_id', req.user!.orgId)
      .select('sla_breaches.*', 'annotations.body', 'annotations.severity', 'annotations.status')
      .orderBy('sla_breaches.breached_at', 'desc')
      .limit(50);
    res.json({ breaches });
  });

  return router;
}

/**
 * Run automation rules against a domain event. Call from the inbound
 * adapter after an annotation/comment event fires.
 */
export async function executeRules(
  db: Knex,
  orgId: string,
  triggerEvent: string,
  context: Record<string, unknown>,
): Promise<void> {
  const rules = await db('automation_rules')
    .where({ org_id: orgId, trigger_event: triggerEvent, active: true })
    .orderBy('priority');

  for (const rule of rules) {
    const conditions = typeof rule.conditions === 'string' ? JSON.parse(rule.conditions) : rule.conditions;
    // Check conditions match
    const matches = Object.entries(conditions).every(
      ([key, val]) => context[key] === val,
    );
    if (!matches) continue;

    const params = typeof rule.action_params === 'string' ? JSON.parse(rule.action_params) : rule.action_params;
    const annotationId = context.annotationId as string;
    if (!annotationId) continue;

    switch (rule.action_type) {
      case 'assign':
        await db('annotations').where('id', annotationId).update({ assignee_id: params.assigneeId });
        break;
      case 'set_status':
        await db('annotations').where('id', annotationId).update({ status: params.status });
        break;
      case 'set_due_date': {
        const due = new Date(Date.now() + (params.hoursFromNow ?? 48) * 3600 * 1000);
        await db('annotations').where('id', annotationId).update({ due_date: due });
        break;
      }
    }
  }
}
