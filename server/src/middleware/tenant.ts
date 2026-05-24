import type { Request, Response, NextFunction } from 'express';
import type { Knex } from 'knex';

/**
 * Tenant context middleware.
 * Extracts org_id from the authenticated JWT and attaches it to the request.
 * Must run AFTER auth middleware.
 */
export function tenantContext(req: Request, res: Response, next: NextFunction): void {
  const orgId = (req as any).user?.orgId;
  if (!orgId) {
    res.status(403).json({ error: { code: 'NO_ORG', message: 'No organization context' } });
    return;
  }
  (req as any).orgId = orgId;
  next();
}

/**
 * Execute a callback within a tenant-scoped transaction.
 * Sets the PostgreSQL session variable that RLS policies check.
 */
export async function withTenant<T>(
  db: Knex,
  orgId: string,
  fn: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.current_org_id = ?`, [orgId]);
    return fn(trx);
  });
}

/**
 * RBAC middleware factory.
 * Checks that the authenticated user has one of the required roles in the current org.
 */
export function requireRole(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const role = (req as any).user?.role;
    if (!role || !roles.includes(role)) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
      });
      return;
    }
    next();
  };
}

/** Role hierarchy for comparison */
const ROLE_HIERARCHY: Record<string, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

/**
 * Check if a role has at least the given minimum level.
 */
export function hasMinRole(userRole: string, minRole: string): boolean {
  return (ROLE_HIERARCHY[userRole] ?? -1) >= (ROLE_HIERARCHY[minRole] ?? 99);
}
