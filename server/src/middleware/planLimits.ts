import type { Request, Response, NextFunction } from 'express';
import type { Knex } from 'knex';
import { PLAN_LIMITS, type PlanName } from '../domain/billing/usecases/billing.js';

export type LimitKind = 'annotations' | 'projects' | 'seats';

export function createPlanLimitsMiddleware(db: Knex, kind: LimitKind) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = req.user?.orgId;
      if (!orgId) { next(); return; }

      const org = await db('organizations').where({ id: orgId }).first();
      if (!org) { next(); return; }

      // Grace period: warn but don't block (Task 1)
      if (org.grace_period_ends_at) {
        const endsAt = new Date(org.grace_period_ends_at).toISOString();
        res.setHeader('X-Grace-Period-Ends', endsAt);
      }

      const plan: PlanName = (org.plan as PlanName) || 'free';
      const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

      if (kind === 'annotations') {
        if (limits.annotationsPerMonth === Infinity) { next(); return; }
        const now = new Date();
        const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        const usageRow = await db('usage_records').where({ org_id: orgId, period_start: periodStart }).first();
        const count = usageRow?.annotations_count ?? 0;
        if (count >= limits.annotationsPerMonth) {
          res.status(402).json({
            error: { code: 'PLAN_LIMIT_EXCEEDED', message: `Free plan limited to ${limits.annotationsPerMonth} annotations/month. Upgrade to Pro.` },
          });
          return;
        }
      } else if (kind === 'projects') {
        if (limits.projects === Infinity) { next(); return; }
        const [{ count }] = await db('projects').where({ org_id: orgId }).count('id as count');
        if (Number(count) >= limits.projects) {
          res.status(402).json({
            error: { code: 'PLAN_LIMIT_EXCEEDED', message: `Free plan limited to ${limits.projects} projects. Upgrade to Pro.` },
          });
          return;
        }
      } else if (kind === 'seats') {
        if (limits.seats === Infinity) { next(); return; }
        const [{ count }] = await db('memberships').where({ org_id: orgId }).count('id as count');
        if (Number(count) >= limits.seats) {
          res.status(402).json({
            error: { code: 'PLAN_LIMIT_EXCEEDED', message: `Plan limited to ${limits.seats} seats. Upgrade to add more members.` },
          });
          return;
        }
      }

      next();
    } catch {
      next();
    }
  };
}
