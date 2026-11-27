import { readSessionCookie } from './sessionCookies.js';
import type { Request, Response, NextFunction } from 'express';

/**
 * Per-tenant (org-scoped) rate limiter using in-memory token buckets.
 *
 * Each org gets `maxTokens` requests per `windowMs`. Tokens refill at
 * a constant rate. This prevents any single tenant from starving others
 * on shared infrastructure.
 *
 * For production at scale, swap the in-memory store with Redis
 * (INCR + EXPIRE pattern) for multi-instance consistency.
 */

interface BucketConfig {
  maxTokens: number;
  refillRate: number; // tokens per ms
  windowMs: number;
}

/**
 * Behavior when the Redis backend is unreachable.
 *   'open'  — allow the request (availability over strictness).
 *   'closed'— reject with 429 (strictness over availability).
 *
 * The per-tenant limiter defaults to 'open' (an outage must not take down
 * the authenticated API). The widget/guest limiter (A3) overrides this to
 * 'closed' so an unauthenticated abuse surface can't be unlocked by a
 * Redis outage.
 */
export type RateLimitFailMode = 'open' | 'closed';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/** Generic Redis-like interface — no dependency on a specific Redis package. */
export interface RedisRateLimitClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
}

const DEFAULT_CONFIG: BucketConfig = {
  maxTokens: 1000,
  refillRate: 1000 / (60 * 60 * 1000), // 1000 tokens/hour
  windowMs: 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Tenant identification (F-22)
// ---------------------------------------------------------------------------
//
// This limiter is mounted app-wide at `/api/v1`, i.e. BEFORE the per-router
// auth middleware has populated `req.user`. Reading `req.user?.orgId` there
// meant it was always undefined, so the limiter never limited anything.
// Instead the tenant is derived from the *verified* session token itself
// (Bearer JWT or `fl_session` cookie) with the same verifier the auth
// middleware uses. An unverifiable / absent token yields no tenant and the
// request passes through (unauthenticated traffic is covered by the per-IP
// and auth limiters, and is rejected by auth anyway). Bearer API keys
// (`pk_…`) are not JWTs, so they are not attributed to a tenant here.

/** Anything with a JWT-style `verify` (the TokenIssuer port satisfies this). */
export interface OrgTokenVerifier {
  verify(token: string): { orgId?: string | null };
}

/** Build a tenant resolver from the verified bearer token / session cookie. */
export function orgIdFromVerifiedToken(
  verifier: OrgTokenVerifier,
): (req: Request) => string | undefined {
  return (req) => {
    const header = req.headers.authorization;
    const bearer =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const cookie =
      readSessionCookie(req.cookies) ?? '';
    // Same precedence as the auth middleware: bearer wins over the cookie.
    const token = bearer || cookie;
    if (!token) return undefined;
    try {
      return verifier.verify(token).orgId ?? undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * Express middleware: identifies the tenant (`resolveOrgId`, default
 * `req.user?.orgId` for routers mounted after auth; the composition root
 * passes {@link orgIdFromVerifiedToken} because this runs before auth) and
 * applies the per-tenant bucket. Unidentified requests pass through (they're
 * covered by the IP-based limiter).
 *
 * When a `redis` client is provided, uses Redis INCR + EXPIRE for
 * multi-instance consistency. Falls back to in-memory when omitted.
 */
export function tenantRateLimit(
  config: Partial<BucketConfig> = {},
  redis?: RedisRateLimitClient,
  resolveOrgId: (req: Request) => string | undefined = (req) => req.user?.orgId,
): (req: Request, res: Response, next: NextFunction) => void {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const windowSec = Math.ceil(cfg.windowMs / 1000);

  // Per-instance buckets honouring THIS instance's config (previously a
  // module-global map refilled with the default config).
  const buckets = new Map<string, Bucket>();
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastRefill > cfg.windowMs * 2) buckets.delete(key);
    }
  }, 10 * 60 * 1000).unref();

  const consume = (orgId: string): { ok: boolean; remaining: number } => {
    const now = Date.now();
    let bucket = buckets.get(orgId);
    if (!bucket) {
      bucket = { tokens: cfg.maxTokens, lastRefill: now };
      buckets.set(orgId, bucket);
    }
    bucket.tokens = Math.min(cfg.maxTokens, bucket.tokens + (now - bucket.lastRefill) * cfg.refillRate);
    bucket.lastRefill = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true, remaining: Math.floor(bucket.tokens) };
    }
    return { ok: false, remaining: 0 };
  };

  return (req: Request, res: Response, next: NextFunction) => {
    const orgId = resolveOrgId(req);
    if (!orgId) { next(); return; }

    if (redis) {
      const key = `rl:${orgId}`;
      redis.incr(key).then((count) => {
        if (count === 1) redis.expire(key, windowSec);
        if (count <= cfg.maxTokens) {
          res.setHeader('X-RateLimit-Remaining', (cfg.maxTokens - count).toString());
          next();
        } else {
          res.setHeader('Retry-After', windowSec.toString());
          res.status(429).json({
            error: {
              code: 'TENANT_RATE_LIMIT',
              message: 'Rate limit exceeded for your organization. Please retry later.',
            },
          });
        }
      }).catch(() => {
        // Redis failure — fall through to allow request (fail-open)
        next();
      });
      return;
    }

    const { ok, remaining } = consume(orgId);
    if (ok) {
      res.setHeader('X-RateLimit-Remaining', remaining.toString());
      next();
    } else {
      const retryAfter = Math.ceil(1 / cfg.refillRate / 1000);
      res.setHeader('Retry-After', retryAfter.toString());
      res.status(429).json({
        error: {
          code: 'TENANT_RATE_LIMIT',
          message: 'Rate limit exceeded for your organization. Please retry later.',
        },
      });
    }
  };
}
