// Shared authorization helpers for the inbound HTTP + WebSocket adapters.
//
// Every route that touches a project (or something that hangs off a project:
// annotations, comments, boards, workflows, ...) used to hand-roll its own
// `projects.org_id = caller.orgId` check. That is tenancy only: it lets any
// org member read/write any project in the org, while the domain use cases
// enforce the stricter owner-or-team-member rule from
// `domain/shared/projectAccess.ts`. This module is the single HTTP-side
// implementation of that rule so the two cannot drift:
//
//   access = project.org_id === caller.orgId
//            AND (project.owner_id === caller.userId
//                 OR caller is a member of project.team_id)
//
// It also hosts `requireRole`, the RBAC gate for destructive/admin routes.
//
// Not-found and not-allowed are deliberately indistinguishable (404) so a
// caller cannot probe for the existence of another tenant's project ids.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Knex } from 'knex';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** The slice of `req.user` the access rules need. */
export interface AccessPrincipal {
  userId: string;
  orgId: string;
  role?: string;
}

export interface AccessibleProject {
  id: string;
  orgId: string;
  ownerId: string | null;
  teamId: string | null;
}

export interface AccessibleAnnotation {
  id: string;
  projectId: string;
  orgId: string;
}

/** Thrown by `assertProjectAccess`; carries the HTTP status to use. */
export class AccessDeniedError extends Error {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
  constructor(message = 'Project not found.') {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

/**
 * Run a lookup keyed by a client-supplied id. Postgres rejects a malformed
 * uuid with 22P02 (invalid_text_representation); that just means "no such
 * row" for access purposes, so it becomes `undefined` rather than a 500.
 */
async function safeLookup<T>(fn: () => PromiseLike<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string } | null)?.code === '22P02') return undefined;
    throw e;
  }
}

/**
 * Resolve a project the principal may access, or `null`. Same predicate as
 * `hasProjectAccess` (owner or team member) plus the org match.
 */
export async function findAccessibleProject(
  db: Knex,
  user: AccessPrincipal,
  projectId: unknown,
): Promise<AccessibleProject | null> {
  if (typeof projectId !== 'string' || projectId.length === 0) return null;
  const row = await safeLookup(() => db('projects').where({ id: projectId, org_id: user.orgId }).first());
  if (!row) return null;

  const project: AccessibleProject = {
    id: row.id ?? projectId,
    orgId: row.org_id,
    ownerId: row.owner_id ?? null,
    teamId: row.team_id ?? null,
  };
  if (project.ownerId !== null && project.ownerId === user.userId) return project;
  if (!project.teamId) return null;

  const membership = await safeLookup(() =>
    db('team_members').where({ team_id: project.teamId, user_id: user.userId }).first(),
  );
  return membership ? project : null;
}

/** Like `findAccessibleProject` but throws `AccessDeniedError` instead of returning null. */
export async function assertProjectAccess(
  db: Knex,
  user: AccessPrincipal,
  projectId: unknown,
): Promise<AccessibleProject> {
  const project = await findAccessibleProject(db, user, projectId);
  if (!project) throw new AccessDeniedError();
  return project;
}

/** Boolean convenience for callers (e.g. the socket gateway) that don't need the row. */
export async function canAccessProject(
  db: Knex,
  user: AccessPrincipal,
  projectId: unknown,
): Promise<boolean> {
  return (await findAccessibleProject(db, user, projectId)) !== null;
}

/**
 * Resolve an annotation the principal may access (org match + access to the
 * annotation's project), or `null`.
 */
export async function findAccessibleAnnotation(
  db: Knex,
  user: AccessPrincipal,
  annotationId: unknown,
): Promise<AccessibleAnnotation | null> {
  if (typeof annotationId !== 'string' || annotationId.length === 0) return null;
  const row = await safeLookup(() =>
    db('annotations').where({ id: annotationId, org_id: user.orgId }).first('id', 'project_id', 'org_id'),
  );
  if (!row) return null;
  if (!(await canAccessProject(db, user, row.project_id))) return null;
  return { id: row.id, projectId: row.project_id, orgId: row.org_id };
}

function notFound(res: Response, message: string): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message, details: {} } });
}

/**
 * Express middleware: require access to the project in `req.params[param]`
 * (default `id`). Responds 404 when missing, foreign, or not accessible.
 */
export function requireProjectAccess(db: Knex, param = 'id'): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = (req.params as Record<string, string | string[] | undefined>)[param];
      const projectId = Array.isArray(raw) ? raw[0] : raw;
      const project = await findAccessibleProject(db, req.user!, projectId);
      if (!project) {
        notFound(res, 'Project not found.');
        return;
      }
      res.locals.project = project;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/**
 * Express middleware: require access to the annotation in `req.params[param]`
 * (default `id`) — org match plus access to its project. 404 otherwise.
 */
export function requireAnnotationAccess(db: Knex, param = 'id'): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = (req.params as Record<string, string | string[] | undefined>)[param];
      const annotationId = Array.isArray(raw) ? raw[0] : raw;
      const annotation = await findAccessibleAnnotation(db, req.user!, annotationId);
      if (!annotation) {
        notFound(res, 'Annotation not found.');
        return;
      }
      res.locals.annotation = annotation;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/**
 * RBAC gate on the org-membership role carried on `req.user.role`
 * (owner / admin / member / viewer). The auth middleware refreshes that value
 * from the memberships table on every request, so a demoted user loses
 * privileges immediately rather than when their JWT expires.
 *
 * API-key principals (`role === 'api_key'`) are never granted a role here:
 * keys only reach the explicit allow-list in `apiKeyOrJwt.ts`, and anything
 * that needs an owner/admin is session-only.
 */
export function requireRole(...roles: string[]): RequestHandler {
  const allowed = new Set(roles);
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role || role === 'api_key' || !allowed.has(role)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions.', details: {} } });
      return;
    }
    next();
  };
}

/**
 * Blocks read-only `viewer` members from mutating routes. API-key principals
 * (`api_key`) pass: their reachable surface is already narrowed by the
 * allow-list in `apiKeyOrJwt.ts`.
 */
export const requireWriteAccess: RequestHandler = (req, res, next) => {
  if (req.user?.role === 'viewer') {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Viewers have read-only access.', details: {} } });
    return;
  }
  next();
};

/**
 * PP-05 — default-deny for the read-only `viewer` role. Wraps an auth
 * middleware so that after authentication ANY non-safe request by a viewer
 * is rejected with 403, unless `(METHOD, path)` matches `exempt` (self-service
 * or decision routes that are authorised by identity, not by role). Applied
 * once in `mountInboundHttp` to every tenant router, so a newly added mutating
 * route is protected without anyone having to remember `requireWriteAccess`.
 */
export const VIEWER_WRITE_EXEMPT: ReadonlyArray<{ method: string; path: RegExp }> = [
  // Switching org / accepting an invitation only affects the caller's own session.
  { method: 'POST', path: /^\/api\/v1\/org\/switch$/ },
  { method: 'POST', path: /^\/api\/v1\/org\/invitations\/accept$/ },
  // An approver decides their own approval step; the use case checks identity.
  { method: 'POST', path: /^\/api\/v1\/approvals\/[^/]+\/advance$/ },
];

export function guardViewerWrites(
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void,
): (req: Request, res: Response, next: NextFunction) => void {
  const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
  return (req, res, next) => {
    authMiddleware(req, res, (e?: unknown) => {
      if (e) return next(e as never);
      if (req.user?.role !== 'viewer' || SAFE.has(req.method)) return next();
      const full = (req.baseUrl + req.path).replace(/\/+$/, '');
      if (VIEWER_WRITE_EXEMPT.some((x) => x.method === req.method && x.path.test(full))) return next();
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Viewers have read-only access.', details: {} } });
    });
  };
}

/** owner/admin only. */
export const requireOrgAdmin: RequestHandler = requireRole('owner', 'admin');

/** True when `userId` has a membership in `orgId`. */
export async function isOrgMember(db: Knex, orgId: string, userId: string): Promise<boolean> {
  if (!userId || !orgId) return false;
  const row = await safeLookup(() =>
    db('memberships').where({ org_id: orgId, user_id: userId }).first('user_id'),
  );
  return !!row;
}

// ---------------------------------------------------------------------------
// Session validation registry
// ---------------------------------------------------------------------------
// The auth middleware must consult the DB (token_version + current
// membership). Route factories already receive `db`; they register it here so
// middleware built with only a `TokenIssuer` (several call sites in the
// composition root) still validates sessions. An explicit `db` passed to
// `createAuthMiddleware` always wins.

let registeredDb: Knex | null = null;

export function registerSessionDb(db: Knex | undefined | null): void {
  if (db) registeredDb = db;
}

export function getRegisteredSessionDb(): Knex | null {
  return registeredDb;
}
