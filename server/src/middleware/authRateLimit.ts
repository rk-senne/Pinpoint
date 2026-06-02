import type { Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

/**
 * Strict per-IP+email rate limiter for authentication-sensitive endpoints
 * (Task 8.2 / Requirements 19.1, 19.2, 19.3).
 *
 * **Window**: 5 requests per 1 minute per `(req.ip, body.email)` key.
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
export const authRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute (Req 19.1)
  limit: 5, // 5 requests per minute per (IP, email) pair (Req 19.1)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    // `req.body.email` is populated by the global `express.json()` parser
    // mounted in `index.ts` (auth endpoints all accept JSON). Coerce to
    // string and normalise to lowercase so the same email captured under
    // different casing collapses into one bucket. Missing/non-string
    // emails fall through to the empty string, so the key degrades to
    // pure-IP rate limiting for endpoints that don't include an email
    // (e.g. `/shared/:linkId/verify`).
    const rawEmail =
      typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    // `ipKeyGenerator` normalises IPv6 to a /64 subnet so an attacker
    // can't trivially rotate the host bits of an IPv6 address to bypass
    // the limit.
    const ipKey = ipKeyGenerator(req.ip ?? '');
    return `${ipKey}:${rawEmail}`;
  },
  handler: (_req: Request, res: Response): void => {
    // The library has already set `Retry-After` and the
    // `RateLimit-*` policy headers at this point; we own the body.
    res.status(429).json({
      error: {
        code: 'AUTH_RATE_LIMIT',
        message:
          'Too many authentication attempts. Please wait and try again.',
      },
    });
  },
});
