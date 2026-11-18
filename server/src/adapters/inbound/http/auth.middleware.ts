// Inbound HTTP adapter — authentication middleware factory
// (Phase 1.5 / task 4.9.1).
//
// Authenticates inbound HTTP requests through the `TokenIssuer` port
// rather than importing `jsonwebtoken` directly so the only place in
// the codebase that touches the JWT library remains the JWT outbound
// adapter (Req 54.5).
//
// Resolution order: `Authorization: Bearer <token>` header wins, with
// `fl_session` cookie as fallback. Either source decoded through
// `TokenIssuer.verify` populates `req.user`. Missing / invalid tokens
// yield HTTP 401.
//
// A valid signature is not enough: the middleware also loads the user's
// CURRENT `token_version` and membership for the token's org, so that
//   - logout / password reset / "revoke sessions" (which bump token_version)
//     invalidate every previously issued JWT, and
//   - a user removed from the org (no membership row) is locked out
//     immediately instead of when their JWT expires.
// `req.user.role` is overwritten with the live membership role so RBAC
// decisions never trust a stale JWT claim.
//
// The `Express.Request.user` augmentation lives in `./types.d.ts`.

import type { NextFunction, Request, Response } from 'express';
import { readSessionCookie } from '../../../middleware/sessionCookies.js';
import type { Knex } from 'knex';
import type { TokenIssuer, TokenPayload } from '../../../domain/auth/ports/TokenIssuer.js';
import { getRegisteredSessionDb } from './access.js';

export interface AuthMiddlewareDeps {
  tokenIssuer: TokenIssuer;
  /**
   * Database used to validate `token_version` + membership. Optional for
   * backwards compatibility: when omitted the db registered by the route
   * factories (`registerSessionDb`) is used.
   */
  db?: Knex;
}

type AuthedRequest = Request & { user?: { tokenVersion?: number } };

function extractToken(req: Request): string | null {
  let bearerToken: string | null = null;
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const value = header.slice(7).trim();
    if (value.length > 0) bearerToken = value;
  }
  return bearerToken ?? readSessionCookie(req.cookies);
}

export type SessionCheck =
  | { ok: true; role: string; tokenVersion: number; name: string | null }
  | { ok: false };

/**
 * Compare a verified token against the user's current server-side state.
 * `db` is null only when no database is available (legacy wiring).
 */
export async function checkSession(db: Knex | null, payload: TokenPayload): Promise<SessionCheck> {
  if (!db) {
    return { ok: true, role: payload.role, tokenVersion: payload.tokenVersion, name: null };
  }
  let row: { token_version?: number | null; name?: string | null; role?: string | null } | undefined;
  try {
    row = await db('users as u')
      .leftJoin('memberships as m', function joinMembership() {
        this.on('m.user_id', '=', 'u.id').andOn('m.org_id', '=', db.raw('?', [payload.orgId]));
      })
      .where('u.id', payload.userId)
      .first('u.token_version as token_version', 'u.name as name', 'm.role as role');
  } catch (e) {
    // A malformed uuid claim (22P02) can only come from a forged/legacy
    // token: it identifies nobody, so the session is simply invalid.
    if ((e as { code?: string } | null)?.code === '22P02') return { ok: false };
    throw e;
  }

  if (!row) return { ok: false };
  const current = Number(row.token_version ?? 0);
  if (!Number.isFinite(current) || (payload.tokenVersion ?? 0) < current) return { ok: false };
  if (!row.role) return { ok: false };
  return { ok: true, role: String(row.role), tokenVersion: current, name: row.name ?? null };
}

function unauthorized(res: Response, message: string): void {
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message } });
}

/**
 * Build the request-authenticated middleware. Composition root supplies
 * the configured `TokenIssuer` adapter; routes that require a logged-in
 * user mount the returned function before their handlers.
 */
export function createAuthMiddleware(
  deps: AuthMiddlewareDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  const { tokenIssuer } = deps;

  return async function authMiddleware(req, res, next): Promise<void> {
    const token = extractToken(req);
    if (!token) {
      unauthorized(res, 'Missing session cookie or bearer token.');
      return;
    }

    let payload: TokenPayload;
    try {
      payload = tokenIssuer.verify(token);
    } catch {
      unauthorized(res, 'Invalid or expired token.');
      return;
    }

    let session: SessionCheck;
    try {
      session = await checkSession(deps.db ?? getRegisteredSessionDb(), payload);
    } catch (e) {
      next(e);
      return;
    }
    if (!session.ok) {
      unauthorized(res, 'Session is no longer valid.');
      return;
    }

    req.user = { userId: payload.userId, email: payload.email, orgId: payload.orgId, role: session.role };
    if (payload.sessionStart !== undefined) req.user.sessionStart = payload.sessionStart;
    (req as AuthedRequest).user!.tokenVersion = session.tokenVersion;
    next();
  };
}

/**
 * Like `createAuthMiddleware` but never rejects: `req.user` is populated
 * when a valid session is presented and left unset otherwise. Used by
 * endpoints that act on the session if there is one (logout).
 */
export function createOptionalAuthMiddleware(
  deps: AuthMiddlewareDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  const strict = createAuthMiddleware(deps);
  return (req, res, next) => {
    if (!extractToken(req)) {
      next();
      return;
    }
    const passthrough = {
      status: () => passthrough,
      json: () => {
        next();
        return passthrough;
      },
    } as unknown as Response;
    void (strict(req, passthrough, next) as unknown);
  };
}
