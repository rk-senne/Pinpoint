import type { NextFunction, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

/**
 * Strict per-IP+email rate limiter for authentication-sensitive endpoints
 * (Task 8.2 / Requirements 19.1, 19.2, 19.3).
 *
 * Three independent limiters run in sequence (F-09):
 *
 *  1. **per-IP** — 20 req/min per client IP, regardless of email. Stops one
 *     address spraying many accounts.
 *  2. **per-(IP, email)** — 5 req/min. The hard "lock": it only ever blocks
 *     the caller's own IP, so a third party on another IP cannot lock a
 *     victim's login by hammering their address.
 *  3. **per-email** — 30 req/15 min across ALL IPs, a deliberately higher
 *     ceiling that bounds distributed guessing against one account. Because
 *     it sits behind (1) and (2), a single attacker IP is throttled to 5/min
 *     long before it can spend this budget quickly, and requests it fails to
 *     get past (1)/(2) never count toward it. On `/auth/login`, successful
 *     requests do not consume the per-email budget so the legitimate owner
 *     signing in is never what exhausts it.
 *
 * Behind the ALB `req.ip` is only the real client when Express `trust proxy`
 * is configured (TRUST_PROXY, see composition/container.ts); otherwise every
 * client shares the ALB's IP and (1) would be a global limit.
 *
 * **Per-(IP, email) window**: 5 requests per 1 minute per `(req.ip, body.email)` key.
 *
 * **Why this key shape (design.md §"Rate limiting")**: keying on `req.ip`
 * alone lets an attacker rotate IPs to brute-force a single account; keying
 * on `email` alone lets an attacker grind through many accounts from one
 * IP. Combining the two means every `(IP, email)` pair gets its own
 * 10-per-15-min budget, which throttles both attacks at once.
 *
 * **Why stricter than the general limiter (Req 19.3)**: the general limiter
 * in `index.ts` is 100 req / 15 min for authenticated traffic; this strict
 * limiter is 5 req / 1 min for the auth surface (`/auth/login`,
 * `/auth/register`, `/auth/reset-password`, `/auth/resend-verification`,
 * `/shared/:linkId/verify`).
 *
 * **Headers / response shape (Req 19.2)**:
 *  - `Retry-After: <seconds>` is set automatically by `express-rate-limit`
 *    when the limit is exceeded (the lib emits the header whenever
 *    `legacyHeaders || standardHeaders` is truthy).
 *  - The 429 body uses the project-wide error envelope with code
 *    `AUTH_RATE_LIMIT` (per the API error table in design.md §"Error Codes").
 *
 * **IPv6 safety**: `ipKeyGenerator(req.ip)` is used to normalise IPv6
 * addresses to a /64 subnet, preventing trivial bypass by rotating
 * the host bits of an IPv6 address. Using `req.ip` directly without
 * `ipKeyGenerator` triggers `express-rate-limit`'s `ERR_ERL_KEY_GEN_IPV6`
 * validation error.
 */
const rejectHandler = (_req: Request, res: Response): void => {
  // The library has already set `Retry-After` and the
  // `RateLimit-*` policy headers at this point; we own the body.
  res.status(429).json({
    error: {
      code: 'AUTH_RATE_LIMIT',
      message: 'Too many authentication attempts. Please wait and try again.',
    },
  });
};

/** `req.body.email` normalised (trim + lowercase); '' when absent/non-string. */
function emailOf(req: Request): string {
  return typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
}

/** IPv6-safe (/64) client IP key. */
function ipOf(req: Request): string {
  return ipKeyGenerator(req.ip ?? '');
}

export interface AuthRateLimitOptions {
  /** Per-IP ceiling per minute (default 20). */
  ipLimit?: number;
  /** Per-(IP,email) ceiling per minute (default 5). */
  ipEmailLimit?: number | (() => number);
  /** Per-email ceiling per 15 minutes across all IPs (default 30). */
  emailLimit?: number;
  /** When true, 2xx/3xx responses don't consume the per-email budget (login). */
  skipSuccessfulForEmail?: boolean;
}

/**
 * Build a fresh auth limiter chain with its own in-memory stores. Exported
 * for tests (and so login can opt into success-skipping on the per-email
 * budget); production wiring uses the singletons below.
 */
export function createAuthRateLimiter(
  opts: AuthRateLimitOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const base = { standardHeaders: true, legacyHeaders: false, handler: rejectHandler } as const;

  const perIp = rateLimit({
    ...base,
    windowMs: 60 * 1000,
    // AUTH_RATE_LIMIT_IP_MAX raises it for load/E2E runs from one machine.
    limit: opts.ipLimit ?? (Number(process.env.AUTH_RATE_LIMIT_IP_MAX) || 20),
    keyGenerator: (req: Request): string => `ip:${ipOf(req)}`,
  });

  const perIpEmail = rateLimit({
    ...base,
    windowMs: 60 * 1000, // 1 minute (Req 19.1)
    limit: typeof opts.ipEmailLimit === 'function' ? opts.ipEmailLimit : (opts.ipEmailLimit ?? 5), // Req 19.1
    keyGenerator: (req: Request): string => `${ipOf(req)}:${emailOf(req)}`,
  });

  const perEmail = rateLimit({
    ...base,
    windowMs: 15 * 60 * 1000,
    limit: opts.emailLimit ?? 30,
    skipSuccessfulRequests: opts.skipSuccessfulForEmail === true,
    // Requests without an email (e.g. /shared/:linkId/verify) are not subject
    // to the per-email budget; they are covered by the IP limiters.
    skip: (req: Request): boolean => emailOf(req) === '',
    keyGenerator: (req: Request): string => `email:${emailOf(req)}`,
  });

  return (req, res, next) => {
    perIp(req, res, (e1?: unknown) => {
      if (e1) return next(e1);
      perIpEmail(req, res, (e2?: unknown) => {
        if (e2) return next(e2);
        perEmail(req, res, next);
      });
    });
  };
}

/** Auth-surface limiter: login/register/reset/resend/shared-link verify. */
export const authRateLimiter = createAuthRateLimiter();

/**
 * 2FA surface (`/auth/login/mfa`, `/auth/mfa/*`): its own stores so MFA traffic
 * cannot starve (or be starved by) login/register. Requests carry no email, so
 * the budget is per IP: 10/min (the per-user lockout in MfaService is the real
 * brute-force control; this bounds a single address spraying many challenges).
 */
export const mfaRateLimiter = createAuthRateLimiter({
  // MFA_RATE_LIMIT_MAX (read per request) lets E2E / integration runs from one machine raise it.
  ipEmailLimit: () => Number(process.env.MFA_RATE_LIMIT_MAX) || 10,
});

/** Login variant: successful sign-ins don't burn the per-email budget. */
export const loginRateLimiter = createAuthRateLimiter({ skipSuccessfulForEmail: true });
