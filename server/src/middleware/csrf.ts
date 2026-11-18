import { createHash } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import type { TokenIssuer } from '../domain/auth/ports/TokenIssuer.js';
import type { ApiKeyRepo } from '../domain/org/ports/ApiKeyRepo.js';
import { readCsrfCookie, readSessionCookie, type CsrfBinder } from './sessionCookies.js';

/**
 * CSRF protection middleware (Task 7.2 / Requirements 18.4, 18.5, 18.6, 18.7).
 *
 * Implements the **double-submit-cookie** pattern. On login the API issues
 * a readable `fl_csrf` cookie alongside the HttpOnly `fl_session` cookie
 * (Task 7.1 / Req 18.3). The Dashboard reads `fl_csrf` from `document.cookie`
 * and echoes it as the `X-CSRF-Token` header on every mutating fetch
 * (Task 7.4 / Req 18.4). This middleware enforces that header == cookie
 * for `POST/PUT/PATCH/DELETE` (Req 18.5).
 *
 * **Exemptions**:
 *
 * 1. Non-mutating methods (`GET`, `HEAD`, `OPTIONS`) are not state-changing
 *    so Req 18.4/18.5 don't apply.
 *
 * 2. Requests authenticated solely via `Authorization: Bearer <token>` with
 *    NO `fl_session` cookie are exempt (Req 18.6, 18.7). The Extension
 *    stashes its bearer in `chrome.storage.local`, sends it in the
 *    `Authorization` header, and never authenticates via the session
 *    cookie. The bearer token is already proof-of-possession, so
 *    double-submit is unnecessary AND impossible (the Extension can't
 *    read site cookies anyway).
 *
 *    Also exempt: a request that carries BOTH a `fl_session` cookie and a
 *    bearer, provided the bearer itself authenticates (valid JWT signature,
 *    or a live non-widget org API key). The auth middleware prefers the
 *    bearer over the cookie, so the cookie plays no part in authenticating
 *    such a request and cannot be abused for CSRF. A bogus/expired bearer
 *    does NOT earn the exemption: a cookie session still needs the
 *    double-submit token.
 *
 * 3. Requests with no `fl_session` cookie at all (and no Bearer) are
 *    pre-session: login, register, refresh, reset-password. There is no
 *    authenticated session to forge against, so the check is skipped.
 *
 * Rejected requests get HTTP 403 with the standard envelope:
 *   `{ error: { code: 'CSRF_INVALID', message: 'CSRF token mismatch.' } }`
 * (matching the API error table in design.md §"Error Codes").
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface CsrfDeps {
  /** Verifies JWT bearers. Without it a JWT bearer never earns the cookie-coexistence exemption. */
  tokenIssuer?: Pick<TokenIssuer, 'verify'>;
  /** Resolves `pk_` API keys. Without it key bearers never earn the exemption. */
  apiKeyRepo?: Pick<ApiKeyRepo, 'findByHash'>;
  /**
   * PP-15: when supplied, the double-submit token must also be bound to the
   * session (HMAC over the nonce + user id + session start), so a token tossed
   * from a sibling subdomain or minted for another session is rejected.
   */
  binder?: CsrfBinder;
}

function bearerOf(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const value = header.slice(7).trim();
  return value.length > 0 ? value : null;
}

/** True only when the bearer on the request genuinely authenticates. */
async function bearerAuthenticates(bearer: string, deps: CsrfDeps): Promise<boolean> {
  try {
    if (bearer.startsWith('pk_')) {
      // Widget keys are never valid Bearer credentials (see apiKeyAuth).
      if (bearer.startsWith('pk_widget_') || !deps.apiKeyRepo) return false;
      const key = await deps.apiKeyRepo.findByHash(createHash('sha256').update(bearer).digest('hex'));
      return !!key && key.keyType !== 'widget';
    }
    if (!deps.tokenIssuer) return false;
    deps.tokenIssuer.verify(bearer);
    return true;
  } catch {
    // Fail closed: any verification problem means CSRF is enforced.
    return false;
  }
}

export function createCsrfMiddleware(deps: CsrfDeps = {}) {
  return async function csrf(req: Request, res: Response, next: NextFunction): Promise<void> {
    // (1) Only enforce on state-changing methods (Req 18.4, 18.5).
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }

    const sessionCookie = readSessionCookie(req.cookies);

    // (2 & 3) Enforce CSRF only when the request carries a Dashboard
    // `fl_session` cookie (Bearer-only and pre-session requests skip it).
    if (!sessionCookie) {
      next();
      return;
    }

    // Cookie present AND a bearer that really authenticates: proof of possession.
    const bearer = bearerOf(req);
    if (bearer && (await bearerAuthenticates(bearer, deps))) {
      next();
      return;
    }

    // (Cookie session present) Enforce double-submit (Req 18.5).
    const csrfCookie = readCsrfCookie(req.cookies);
    const csrfHeaderRaw = req.headers['x-csrf-token'];
    const csrfHeader = Array.isArray(csrfHeaderRaw) ? csrfHeaderRaw[0] : csrfHeaderRaw;

    if (
      !csrfCookie ||
      typeof csrfCookie !== 'string' ||
      !csrfHeader ||
      typeof csrfHeader !== 'string' ||
      csrfHeader !== csrfCookie ||
      (deps.binder !== undefined && !deps.binder.isBoundTo(csrfCookie, sessionCookie))
    ) {
      res.status(403).json({
        error: { code: 'CSRF_INVALID', message: 'CSRF token mismatch.' },
      });
      return;
    }

    next();
  };
}

/** Default instance without bearer verification (cookie sessions always enforced). */
export const csrfMiddleware = createCsrfMiddleware();
