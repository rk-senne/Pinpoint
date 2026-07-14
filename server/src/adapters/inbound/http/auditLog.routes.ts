// Inbound HTTP adapter — audit log routes.
//
// Mounted at `/api/v1/org/audit-log`. Returns paginated audit events
// for the current organization with optional filters.

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Knex } from 'knex';
import { PaginationParamsSchema, paginationMeta } from '@pinpoint/shared';
import { z } from 'zod';

export interface AuditLogRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

const AuditLogQuerySchema = PaginationParamsSchema.extend({
  action: z.string().optional(),
  actorId: z.string().uuid().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

export function createAuditLogRoutes(deps: AuditLogRouteDeps): Router {
  const { authMiddleware, db } = deps;
  const router = Router();

  // GET /api/v1/org/audit-log?page=1&pageSize=25&action=...&actorId=...&dateFrom=...&dateTo=...
  router.get('/', authMiddleware, async (req: Request, res: Response) => {
    // Only owners and admins can view audit logs
    if (req.user!.role !== 'owner' && req.user!.role !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions.' } });
    }

    const parsed = AuditLogQuerySchema.safeParse(req.query);
    const { page, pageSize, action, actorId, dateFrom, dateTo } = parsed.success
      ? parsed.data
      : { page: 1, pageSize: 25, action: undefined, actorId: undefined, dateFrom: undefined, dateTo: undefined };

    const orgId = req.user!.orgId;

    let baseQuery = db('audit_logs')
      .where('audit_logs.org_id', orgId);

    if (action) baseQuery = baseQuery.andWhere('audit_logs.action', action);
    if (actorId) baseQuery = baseQuery.andWhere('audit_logs.actor_id', actorId);
    if (dateFrom) baseQuery = baseQuery.andWhere('audit_logs.created_at', '>=', dateFrom);
    if (dateTo) baseQuery = baseQuery.andWhere('audit_logs.created_at', '<=', dateTo);

    const [{ count: total }] = await baseQuery.clone().count('* as count');

    const offset = (page - 1) * pageSize;

    const rows = await baseQuery
      .clone()
      .leftJoin('users', 'audit_logs.actor_id', 'users.id')
      .select(
        'audit_logs.id',
        'audit_logs.org_id',
        'audit_logs.actor_id',
        'users.name as actor_name',
        'audit_logs.action',
        'audit_logs.resource_type',
        'audit_logs.resource_id',
        'audit_logs.metadata',
        'audit_logs.created_at',
      )
      .orderBy('audit_logs.created_at', 'desc')
      .limit(pageSize)
      .offset(offset);

    const data = rows.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      actorId: r.actor_id,
      actorName: r.actor_name ?? null,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id ?? null,
      metadata: r.metadata ?? {},
      createdAt: r.created_at,
    }));

    res.json({
      data,
      pagination: paginationMeta(Number(total), page, pageSize),
    });
  });

  return router;
}

// =========================================================================
// Helper: recordAudit
// =========================================================================
// Lightweight insert helper that can be called from any route handler to
// log an audit event. Does not throw on failure — logs and swallows to
// avoid blocking the primary operation.

export interface RecordAuditParams {
  orgId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(db: Knex, params: RecordAuditParams): Promise<void> {
  try {
    await db('audit_logs').insert({
      org_id: params.orgId,
      actor_id: params.actorId,
      action: params.action,
      resource_type: params.resourceType,
      resource_id: params.resourceId ?? null,
      metadata: JSON.stringify(params.metadata ?? {}),
    });
  } catch {
    // Swallow — audit logging should never break the primary operation.
  }
}
