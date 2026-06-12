import type { Request, Response, NextFunction } from 'express';

/**
 * Simple in-memory LRU cache middleware with TTL.
 * See docs/PERFORMANCE_SPEC.md § Enhancement 3.
 */

interface CacheEntry {
  body: string;
  status: number;
  createdAt: number;
}

const MAX_ENTRIES = 500;
const store = new Map<string, CacheEntry>();

function evictIfNeeded(): void {
  if (store.size >= MAX_ENTRIES) {
    // Delete oldest entry (first key in insertion order)
    const first = store.keys().next().value;
    if (first !== undefined) store.delete(first);
  }
}

/**
 * Cache middleware factory.
 * @param ttlMs - time-to-live for cached entries in milliseconds
 * @param keyFn - optional custom cache key derivation; defaults to req.originalUrl
 */
export function cacheMiddleware(
  ttlMs: number,
  keyFn?: (req: Request) => string,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET') { next(); return; }

    const key = keyFn ? keyFn(req) : req.originalUrl;
    const cached = store.get(key);

    if (cached && Date.now() - cached.createdAt < ttlMs) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(cached.status).end(cached.body);
      return;
    }

    // Intercept res.json to capture the response
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown): Response {
      const raw = JSON.stringify(body);
      evictIfNeeded();
      store.set(key, { body: raw, status: res.statusCode || 200, createdAt: Date.now() });
      res.setHeader('X-Cache', 'MISS');
      return originalJson(body);
    };
    next();
  };
}

/**
 * Invalidate all cache entries whose keys start with the given prefix.
 */
export function invalidateCache(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
