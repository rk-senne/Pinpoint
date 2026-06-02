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
// The `Express.Request.user` augmentation lives in `./types.d.ts`.

import type { NextFunction, Request, Response } from 'express';
import type { TokenIssuer } from '../../../domain/auth/ports/TokenIssuer.js';

export interface AuthMiddlewareDeps {
  tokenIssuer: TokenIssuer;
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

  return function authMiddleware(req, res, next): void {
    let bearerToken: string | null = null;
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const value = header.slice(7).trim();
      if (value.length > 0) {
        bearerToken = value;
      }
    }

    const cookieToken =
      typeof req.cookies?.fl_session === 'string' && req.cookies.fl_session.length > 0
        ? req.cookies.fl_session
        : null;

    const token = bearerToken ?? cookieToken;
    if (!token) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Missing session cookie or bearer token.' },
      });
      return;
    }

    try {
      const payload = tokenIssuer.verify(token);
      req.user = { userId: payload.userId, email: payload.email, orgId: payload.orgId, role: payload.role };
      next();
    } catch {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token.' },
      });
    }
  };
}
