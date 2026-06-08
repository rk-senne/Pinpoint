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

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const DEFAULT_CONFIG: BucketConfig = {
  maxTokens: 1000,
  refillRate: 1000 / (60 * 60 * 1000), // 1000 tokens/hour
  windowMs: 60 * 60 * 1000,
};

const buckets = new Map<string, Bucket>();

// Evict stale buckets every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > DEFAULT_CONFIG.windowMs * 2) {
      buckets.delete(key);
    }
  }
}, 10 * 60 * 1000).unref();

function getOrCreateBucket(orgId: string): Bucket {
  let bucket = buckets.get(orgId);
  if (!bucket) {
    bucket = { tokens: DEFAULT_CONFIG.maxTokens, lastRefill: Date.now() };
    buckets.set(orgId, bucket);
  }
  return bucket;
}

function refill(bucket: Bucket): void {
  const now = Date.now();
  const elapsed = now - bucket.lastRefill;
  const tokensToAdd = elapsed * DEFAULT_CONFIG.refillRate;
  bucket.tokens = Math.min(DEFAULT_CONFIG.maxTokens, bucket.tokens + tokensToAdd);
  bucket.lastRefill = now;
}

function consume(bucket: Bucket): boolean {
  refill(bucket);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

/**
 * Express middleware: extracts `orgId` from `req.user` (set by auth
 * middleware) and applies the per-tenant bucket. Unauthenticated
 * requests pass through (they're covered by the IP-based limiter).
 */
export function tenantRateLimit(
  config: Partial<BucketConfig> = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return (req: Request, res: Response, next: NextFunction) => {
    const orgId = req.user?.orgId;
    if (!orgId) { next(); return; }

    const bucket = getOrCreateBucket(orgId);
    // Apply custom config
    if (cfg.maxTokens !== DEFAULT_CONFIG.maxTokens) {
      bucket.tokens = Math.min(cfg.maxTokens, bucket.tokens);
    }

    if (consume(bucket)) {
      res.setHeader('X-RateLimit-Remaining', Math.floor(bucket.tokens).toString());
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
