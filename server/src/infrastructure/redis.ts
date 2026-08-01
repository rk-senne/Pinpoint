/**
 * Redis client factory — creates and exports an ioredis client when
 * REDIS_URL is configured. Used by:
 * - Rate limiting middleware (replaces in-memory store)
 * - Socket.IO adapter (multi-instance pub/sub)
 * - Health endpoint (connection check)
 *
 * Returns null when REDIS_URL is unset (graceful degradation to in-memory).
 */
import Redis from 'ioredis';
import type { Logger } from '../domain/shared/ports/Logger.js';

export interface RedisClients {
  /** Primary client for rate limiting and general commands. */
  primary: Redis;
  /** Subscriber client for Socket.IO pub/sub adapter. */
  subscriber: Redis;
}

/**
 * Create Redis clients from a URL. Returns null if url is falsy.
 * Both clients share the same connection options (TLS, timeouts).
 */
export function createRedisClients(
  url: string | undefined,
  logger: Logger,
): RedisClients | null {
  if (!url) return null;

  const opts = {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number): number | null {
      if (times > 10) return null; // stop retrying after 10 attempts
      return Math.min(times * 200, 5000);
    },
    lazyConnect: false,
  };

  const primary = new Redis(url, opts);
  const subscriber = new Redis(url, opts);

  primary.on('error', (err: Error) => {
    logger.error({ error: err.message }, 'redis primary connection error');
  });

  subscriber.on('error', (err: Error) => {
    logger.error({ error: err.message }, 'redis subscriber connection error');
  });

  primary.on('connect', () => {
    logger.info({}, 'redis primary connected');
  });

  return { primary, subscriber };
}

/**
 * Redis-backed rate limit store implementing the RedisRateLimitClient
 * interface from the tenantRateLimit middleware.
 */
export function createRedisRateLimitStore(client: Redis): {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
} {
  return {
    async incr(key: string): Promise<number> {
      return client.incr(key);
    },
    async expire(key: string, seconds: number): Promise<void> {
      await client.expire(key, seconds);
    },
  };
}
