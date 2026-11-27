// Inbound HTTP adapter — audit log routes.
//
// Mounted at `/api/v1/org/audit-log`. Returns paginated audit events
// for the current organization with optional filters (action, actionPrefix,
// actorId, resourceType, resourceId, ip, requestId, date range).

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Knex } from 'knex';
import { PaginationParamsSchema, paginationMeta } from '@pinpoint/shared';
import { z } from 'zod';
import { sendZodFailure } from './errors.js';

export interface AuditLogRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

const AuditLogQuerySchema = PaginationParamsSchema.extend({
  action: z.string().max(100).optional(),
  actorId: z.string().uuid().optional(),
  /** Prefix match on the action, e.g. `auth.` or `share_link.`. */
  actionPrefix: z.string().max(100).regex(/^[a-z0-9_.]+$/).optional(),
  resourceType: z.string().max(50).optional(),
  resourceId: z.string().max(255).optional(),
  ip: z.string().max(45).optional(),
  requestId: z.string().max(64).optional(),
  dateFrom: z.string().max(64).refine((v) => !Number.isNaN(Date.parse(v)), 'must be a valid date').optional(),
  dateTo: z.string().max(64).refine((v) => !Number.isNaN(Date.parse(v)), 'must be a valid date').optional(),
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
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid audit-log filter.', parsed.error.flatten());
      return;
    }
    const { page, pageSize, action, actionPrefix, actorId, resourceType, resourceId, ip, requestId, dateFrom, dateTo } = parsed.data;

    const orgId = req.user!.orgId;

    let baseQuery = db('audit_logs')
      .where('audit_logs.org_id', orgId);

    if (action) baseQuery = baseQuery.andWhere('audit_logs.action', action);
    if (actionPrefix) baseQuery = baseQuery.andWhere('audit_logs.action', 'like', `${actionPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    if (resourceType) baseQuery = baseQuery.andWhere('audit_logs.resource_type', resourceType);
    if (resourceId) baseQuery = baseQuery.andWhere('audit_logs.resource_id', resourceId);
    if (ip) baseQuery = baseQuery.andWhere('audit_logs.ip_address', ip);
    if (requestId) baseQuery = baseQuery.andWhere('audit_logs.request_id', requestId);
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
        'audit_logs.ip_address',
        'audit_logs.user_agent',
        'audit_logs.request_id',
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
      ipAddress: r.ip_address ?? null,
      userAgent: r.user_agent ?? null,
      requestId: r.request_id ?? null,
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
  /** Null only for pre-authentication events that belong to no tenant (unknown-user login failure). */
  orgId: string | null;
  /** For API-key requests this is the key's CREATOR; `apiKeyId` says a key acted. Null when nobody is identified. */
  actorId: string | null;
  /** Set when the action was performed through an org API key rather than a session. */
  apiKeyId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  /** The originating request: supplies ip, user-agent and request id. */
  request?: Pick<Request, 'ip' | 'headers'> & { id?: unknown };
}

/**
 * `apiKeyId` for the current request when it was authenticated with an org
 * API key (spread into `recordAudit` params so audit rows show a key acted).
 */
export function auditApiKeyContext(req: Request): { apiKeyId?: string } {
  const key = (req as Request & { apiKey?: { id?: string } }).apiKey;
  return key?.id ? { apiKeyId: key.id } : {};
}

/** ip / user-agent / request-id columns for an audit row. */
export function auditRequestContext(request: RecordAuditParams['request']): {
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
} {
  if (!request) return { ip_address: null, user_agent: null, request_id: null };
  const ua = request.headers?.['user-agent'];
  const id = request.id;
  return {
    ip_address: typeof request.ip === 'string' ? request.ip.slice(0, 45) : null,
    user_agent: typeof ua === 'string' ? ua.slice(0, 512) : null,
    request_id: typeof id === 'string' || typeof id === 'number' ? String(id).slice(0, 64) : null,
  };
}

export async function recordAudit(db: Knex, params: RecordAuditParams): Promise<void> {
  try {
    await db('audit_logs').insert({
      org_id: params.orgId,
      actor_id: params.actorId,
      action: params.action,
      resource_type: params.resourceType,
      resource_id: params.resourceId ?? null,
      metadata: JSON.stringify(
        params.apiKeyId
          ? { ...(params.metadata ?? {}), viaApiKey: true, apiKeyId: params.apiKeyId }
          : (params.metadata ?? {}),
      ),
      ...auditRequestContext(params.request),
    });
  } catch {
    // Swallow — audit logging should never break the primary operation.
  }
}
