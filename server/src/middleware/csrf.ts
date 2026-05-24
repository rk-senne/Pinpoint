import { Request, Response, NextFunction } from 'express';

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
 * 3. Requests with no `fl_session` cookie at all (and no Bearer) are
 *    pre-session: login, register, refresh, reset-password. There is no
 *    authenticated session to forge against, so the check is skipped.
 *
 * Rejected requests get HTTP 403 with the standard envelope:
 *   `{ error: { code: 'CSRF_INVALID', message: 'CSRF token mismatch.' } }`
 * (matching the API error table in design.md §"Error Codes").
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function csrfMiddleware(req: Request, res: Response, next: NextFunction): void {
  // (1) Only enforce on state-changing methods (Req 18.4, 18.5).
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  const sessionCookie: string | undefined = req.cookies?.fl_session;

  // (2 & 3) Enforce CSRF only when the request carries a Dashboard
  // `fl_session` cookie. This collapses two rules into one:
  //   - Extension proof-of-possession exempt: Bearer-only requests
  //     (no `fl_session`) skip the check (Req 18.6, 18.7).
  //   - Pre-session endpoints (login/register/refresh/reset-password)
  //     have no `fl_session` yet, so the check is skipped.
  if (!sessionCookie) {
    next();
    return;
  }

  // (Cookie session present) Enforce double-submit (Req 18.5).
  const csrfCookie = req.cookies?.fl_csrf;
  const csrfHeaderRaw = req.headers['x-csrf-token'];
  const csrfHeader = Array.isArray(csrfHeaderRaw) ? csrfHeaderRaw[0] : csrfHeaderRaw;

  if (
    !csrfCookie ||
    typeof csrfCookie !== 'string' ||
    !csrfHeader ||
    typeof csrfHeader !== 'string' ||
    csrfHeader !== csrfCookie
  ) {
    res.status(403).json({
      error: { code: 'CSRF_INVALID', message: 'CSRF token mismatch.' },
    });
    return;
  }

  next();
}
