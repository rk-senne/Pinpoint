// Widget / guest-feedback rate limit (Mission A3).
//
// Unlike the per-tenant limiter (`tenantRateLimit.ts`), the widget surface
// is PUBLIC and UNAUTHENTICATED — so a Redis outage must NOT silently unlock
// it. This limiter is fail-CLOSED: when the Redis backend is unreachable we
// reject with 429 rather than allowing unbounded writes. It enforces two
// independent counters per API key:
//
//   1. A short sliding window (burst control, `windowMs` / `max`).
//   2. A per-key daily quota (calendar-day cap, from `ApiKey.dailyQuota`).
//
// Both use the Redis INCR + EXPIRE pattern for multi-instance consistency.
// The in-memory fallback exists ONLY for tests (pass `{ store: 'memory' }`);
// production always supplies a Redis client and runs fail-closed.

import type { Request, Response, NextFunction } from 'express';
import type { ApiKey } from '../domain/org/ports/ApiKeyRepo.js';
import type { RateLimitFailMode } from './tenantRateLimit.js';

/** Minimal Redis surface used by this limiter (INCR + EXPIRE + TTL). */
export interface WidgetRateLimitRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
}

export interface WidgetRateLimitConfig {
  /** Sliding-window length for burst control (default 60s). */
  windowMs?: number;
  /** Max submissions per window (default 5). */
  max?: number;
  /**
   * Fail-mode when the backend errors. Defaults to 'closed' — the whole
   * point of this limiter. Tests may pass 'open' to assert the contrast.
   */
  failMode?: RateLimitFailMode;
  /**
   * Backend store. 'memory' is for tests only; production passes a Redis
   * client via `redis`.
   */
  store?: 'memory' | 'redis';
  redis?: WidgetRateLimitRedis;
  /**
   * Namespace for the Redis/in-memory counter keys. Lets the same limiter
   * factory guard distinct public surfaces (the `pk_widget_` key surface and
   * the guest-feedback-by-link surface, Mission A7) without their counters
   * colliding. Defaults to `'wrl'` so the original widget wiring and its
   * tests are byte-for-byte unchanged.
   */
  keyPrefix?: string;
}

/**
 * Rate-limit identity (Mission A7). The limiter counts against `id` and caps
 * the per-day bucket at `dailyQuota` (null = no daily cap). An `ApiKey`
 * structurally satisfies this, which is why the original `getApiKey`
 * resolver keeps working untouched.
 */
export interface RateLimitIdentity {
  id: string;
  /** Max submissions per UTC day for this identity; null = unlimited. */
  dailyQuota: number | null;
}

/**
 * Resolve how the middleware identifies the caller.
 *
 * Exactly one of `getApiKey` (original widget surface — pulls the resolved
 * `ApiKey` off the request) or `getIdentity` (generic surface — e.g. the
 * guest-feedback-by-link limiter, which keys on `linkId`) is supplied.
 * `getApiKey` is retained verbatim so the widget route and its tests do not
 * change.
 */
export interface WidgetRateLimitDeps {
  /** Pulls the resolved `ApiKey` off the request (set by the widget route). */
  getApiKey?: (req: Request) => ApiKey | undefined;
  /** Generic identity resolver for non-widget public surfaces (A7). */
  getIdentity?: (req: Request) => RateLimitIdentity | undefined;
}

interface MemoryCounter {
  count: number;
  resetAt: number;
}

const memWindow = new Map<string, MemoryCounter>();
const memDaily = new Map<string, MemoryCounter>();

function rejectRateLimited(res: Response, retryAfterSec: number): void {
  res.setHeader('Retry-After', retryAfterSec.toString());
  res.status(429).json({
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many feedback submissions. Please try again later.',
      details: {},
    },
  });
}

/** Seconds remaining until the next UTC midnight. */
function secondsUntilUtcMidnight(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

/** YYYY-MM-DD in UTC — the daily-quota bucket key suffix. */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function memConsume(
  map: Map<string, MemoryCounter>,
  key: string,
  limit: number,
  ttlSec: number,
  now: number,
): boolean {
  const existing = map.get(key);
  if (!existing || existing.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + ttlSec * 1000 });
    return 1 <= limit;
  }
  existing.count += 1;
  return existing.count <= limit;
}

export function createWidgetRateLimit(
  deps: WidgetRateLimitDeps,
  config: WidgetRateLimitConfig = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const windowMs = config.windowMs ?? 60 * 1000;
  const windowSec = Math.ceil(windowMs / 1000);
  const max = config.max ?? 5;
  const failMode: RateLimitFailMode = config.failMode ?? 'closed';
  const useRedis = config.store !== 'memory' && !!config.redis;
  const prefix = config.keyPrefix ?? 'wrl';

  // Resolve the rate-limit identity from whichever resolver was supplied.
  // The original `getApiKey` resolver returns an `ApiKey`, which already
  // satisfies `RateLimitIdentity` structurally.
  const resolveIdentity = (req: Request): RateLimitIdentity | undefined => {
    if (deps.getIdentity) return deps.getIdentity(req);
    if (deps.getApiKey) return deps.getApiKey(req);
    return undefined;
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const identity = resolveIdentity(req);
    if (!identity) {
      // No resolved identity — the route's own auth/lookup check handles
      // the rejection. Don't count.
      next();
      return;
    }

    const now = Date.now();
    const windowKey = `${prefix}:win:${identity.id}`;
    const dailyKey = `${prefix}:day:${identity.id}:${utcDay(now)}`;
    const dailyTtl = secondsUntilUtcMidnight(now);
    const quota = identity.dailyQuota;

    if (useRedis && config.redis) {
      const redis = config.redis;
      void (async () => {
        try {
          const winCount = await redis.incr(windowKey);
          if (winCount === 1) await redis.expire(windowKey, windowSec);
          if (winCount > max) {
            rejectRateLimited(res, windowSec);
            return;
          }

          if (quota != null) {
            const dayCount = await redis.incr(dailyKey);
            if (dayCount === 1) await redis.expire(dailyKey, dailyTtl);
            if (dayCount > quota) {
              rejectRateLimited(res, dailyTtl);
              return;
            }
          }

          res.setHeader('X-RateLimit-Remaining', (max - winCount).toString());
          next();
        } catch {
          if (failMode === 'closed') {
            rejectRateLimited(res, windowSec);
          } else {
            next();
          }
        }
      })();
      return;
    }

    // In-memory fallback (tests only).
    if (!memConsume(memWindow, windowKey, max, windowSec, now)) {
      rejectRateLimited(res, windowSec);
      return;
    }
    if (quota != null && !memConsume(memDaily, dailyKey, quota, dailyTtl, now)) {
      rejectRateLimited(res, dailyTtl);
      return;
    }
    next();
  };
}

/** Test-only: clear the in-memory counters between cases. */
export function __resetWidgetRateLimitMemory(): void {
  memWindow.clear();
  memDaily.clear();
}
