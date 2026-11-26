// Automation-rule engine. `automation_rules` rows (created in the dashboard's
// Workflows page / POST /workflows/rules) were stored but never executed; this
// hooks `annotation.created` and `annotation.status_changed` on the event bus
// (in place, like the Slack wiring) and applies matching, active rules.
//
// Supported actions (params as documented in the dashboard):
//   assign        { assigneeId }      — only if the user belongs to the org
//   set_status    { status }          — active | in_progress | resolved
//   set_due_date  { daysFromNow }
//   notify        — not executed here (no recipient model); logged only.
// Conditions are equality checks on the annotation (`severity`, `type`, `status`).
// Rules run detached and best-effort: a failure never affects the emit.
// `comment.created` rules are stored but not executed yet.
import type { Knex } from 'knex';
import type { EventBus } from '../domain/shared/ports/EventBus.js';
import type { Logger } from '../domain/shared/ports/Logger.js';
import { runAsSystem } from '../infrastructure/tenantContext.js';

const STATUSES = new Set(['active', 'in_progress', 'resolved']);
const CONDITION_KEYS = ['severity', 'type', 'status'] as const;
const TRIGGERS = new Set(['annotation.created', 'annotation.status_changed']);

interface RuleRow {
  id: string;
  name: string;
  conditions: unknown;
  action_type: string;
  action_params: unknown;
}

function asObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try {
      return asObject(JSON.parse(v));
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** True when every known condition key present on the rule equals the annotation's value. */
export function conditionsMatch(conditions: unknown, annotation: Record<string, unknown>): boolean {
  const c = asObject(conditions);
  return CONDITION_KEYS.every((k) => c[k] === undefined || c[k] === annotation[k]);
}

/** Apply every matching rule for `trigger` to the annotation in `payload`. */
export async function applyRules(
  db: Knex,
  logger: Logger,
  trigger: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const annotationId = payload.id;
  const projectId = payload.projectId;
  if (typeof annotationId !== 'string' || typeof projectId !== 'string') return 0;
  return runAsSystem(async () => {
    const project = await db('projects').where({ id: projectId }).first('org_id');
    if (!project) return 0;
    const orgId = project.org_id as string;
    const rules = (await db('automation_rules')
      .where({ org_id: orgId, trigger_event: trigger, active: true })
      .andWhere((q) => q.whereNull('project_id').orWhere('project_id', projectId))
      .orderBy('priority')
      .orderBy('created_at')) as RuleRow[];
    let applied = 0;
    for (const rule of rules) {
      if (!conditionsMatch(rule.conditions, payload)) continue;
      const params = asObject(rule.action_params);
      const patch: Record<string, unknown> = {};
      if (rule.action_type === 'assign' && typeof params.assigneeId === 'string') {
        const member = await db('memberships').where({ org_id: orgId, user_id: params.assigneeId }).first('user_id');
        if (member) patch.assignee_id = params.assigneeId;
      } else if (rule.action_type === 'set_status' && typeof params.status === 'string' && STATUSES.has(params.status)) {
        patch.status = params.status;
      } else if (rule.action_type === 'set_due_date' && typeof params.daysFromNow === 'number' && params.daysFromNow >= 0) {
        const due = new Date(Date.now() + Math.floor(params.daysFromNow) * 86_400_000);
        patch.due_date = due.toISOString().slice(0, 10);
      } else if (rule.action_type === 'notify') {
        logger.info({ ruleId: rule.id }, 'workflow rule matched (notify is not executed)');
        continue;
      }
      if (Object.keys(patch).length === 0) continue;
      await db('annotations').where({ id: annotationId }).update({ ...patch, updated_at: db.fn.now() });
      applied += 1;
    }
    return applied;
  });
}

/** Hook the bus in place; detached so it can never block or fail `emit`. */
export function attachWorkflowEngine(bus: EventBus, db: Knex, logger: Logger): void {
  const original = bus.emit.bind(bus);
  bus.emit = (event) => {
    original(event);
    if (!TRIGGERS.has(event.type)) return;
    const payload = event.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object') return;
    void applyRules(db, logger, event.type, payload).catch((err: unknown) => {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'workflow rule execution failed');
    });
  };
}
