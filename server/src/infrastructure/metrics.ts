// Prometheus metrics (`GET /metrics`).
//
// Exposes the default Node process metrics plus:
//   - http_requests_total{method,route,status}
//   - http_request_duration_seconds{method,route,status} (histogram)
//
// `route` is the matched Express route pattern (e.g. `/api/v1/projects/:id`),
// never the raw URL, so ids can't blow up label cardinality. Unmatched
// requests are labelled `unmatched`.
//
// Operational gauges (see `startQueueMetrics`, refreshed by a cheap periodic SQL
// poll, never per request): pinpoint_db_up, the notification / webhook queue
// depth, oldest-pending age, and failure counters. They feed the alert rules in
// deploy/monitoring/alerts.yml.
//
// Access: when METRICS_TOKEN is set, scrapers must send
// `Authorization: Bearer <token>`; otherwise only loopback / private-network
// callers (in-cluster Prometheus, the compose `monitoring` profile) are
// allowed. The endpoint is never exposed to the public internet by default.

import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import client from 'prom-client';
import { runAsSystem } from './tenantContext.js';

/**
 * Fixed allow-list of top-level `/api/v1/<area>` segments that may appear in
 * the `route` label when no route pattern matched (e.g. an auth 401 raised
 * inside a mounted router). Anything else collapses to `unmatched` so an
 * attacker walking `/api/v1/<random>` cannot mint unbounded label values (F-21).
 */
export const KNOWN_API_AREAS: ReadonlySet<string> = new Set([
  'auth', 'projects', 'annotations', 'teams', 'shared', 'guidelines', 'users',
  'webhooks', 'notifications', 'org', 'api-keys', 'feedback', 'portals',
  'workflows', 'reports', 'billing', 'integrations', 'widget',
]);

export interface Metrics {
  registry: client.Registry;
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  handler: (req: Request, res: Response) => Promise<void>;
}

/** Loopback, RFC1918, CGNAT, link-local and ULA — i.e. not the public internet. */
export function isPrivateAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (v === '::1' || v === '127.0.0.1' || v.startsWith('127.')) return true;
  if (/^10\./.test(v) || /^192\.168\./.test(v)) return true;
  const m = /^172\.(\d+)\./.exec(v);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  const c = /^100\.(\d+)\./.exec(v);
  if (c && Number(c[1]) >= 64 && Number(c[1]) <= 127) return true;
  if (/^169\.254\./.test(v)) return true;
  const lower = v.toLowerCase();
  return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createMetrics(opts: { token?: string; collectDefaults?: boolean } = {}): Metrics {
  const registry = new client.Registry();
  if (opts.collectDefaults !== false) client.collectDefaultMetrics({ register: registry });

  const labelNames = ['method', 'route', 'status'] as const;
  const requests = new client.Counter({
    name: 'http_requests_total',
    help: 'HTTP requests served, by method, matched route and status code.',
    labelNames,
    registers: [registry],
  });
  const duration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds, by method, matched route and status code.',
    labelNames,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === '/metrics') return next();
    const end = duration.startTimer();
    res.on('finish', () => {
      const routePath = (req.route as { path?: string } | undefined)?.path;
      // Matched route → its pattern. Rejected before any route matched
      // (e.g. an auth 401 inside a mounted router) → the top-level API area
      // (`/api/v1/projects/*`), derived from a fixed segment so concrete ids
      // never become label values. Otherwise `unmatched`.
      let route: string;
      if (routePath) {
        route = `${req.baseUrl}${routePath === '/' ? '' : routePath}` || '/';
      } else {
        const area = /^\/api\/v1\/([a-z][a-z-]*)(?:\/|$)/.exec(req.originalUrl.split("?")[0] ?? "")?.[1];
        route = area && KNOWN_API_AREAS.has(area) ? `/api/v1/${area}/*` : 'unmatched';
      }
      const labels = { method: req.method, route, status: String(res.statusCode) };
      requests.inc(labels);
      end(labels);
    });
    next();
  };

  const handler = async (req: Request, res: Response): Promise<void> => {
    const allowed = opts.token
      ? tokenMatches(req.headers.authorization, opts.token)
      : // PP-07: `req.ip` honours `trust proxy` (the real client behind an ALB), and a
        // request that carries proxy headers was NOT scraped from inside the private
        // network even if the immediate peer (the proxy) has a private address.
        isPrivateAddress(req.ip ?? req.socket.remoteAddress) &&
        !req.headers['x-forwarded-for'] &&
        !req.headers['forwarded'] &&
        !req.headers['x-real-ip'];
    if (!allowed) {
      res.status(opts.token ? 401 : 403).json({
        error: { code: opts.token ? 'UNAUTHORIZED' : 'FORBIDDEN', message: 'Metrics access denied.', details: {} },
      });
      return;
    }
    res.setHeader('Content-Type', registry.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.end(await registry.metrics());
  };

  return { registry, middleware, handler };
}

/** The one thing the queue poller needs from knex (`db.raw`), so tests can fake it. */
export interface RawQueryRunner {
  raw(sql: string): PromiseLike<{ rows: Array<Record<string, unknown>> }>;
}

export interface QueueMetricsOptions {
  db: RawQueryRunner;
  /** Poll period; default 30 s (one cheap indexed query per queue). */
  intervalMs?: number;
  /** Tenant-context wrapper. Default `runAsSystem` (RLS: webhook_deliveries is tenant-scoped). */
  asSystem?: <T>(fn: () => T) => T;
  onError?: (err: unknown) => void;
}

export interface QueueMetrics {
  /** Run one poll now (the timer calls this; exported for tests). */
  collect(): Promise<void>;
  stop(): void;
}

interface QueueSpec {
  key: 'notifications' | 'webhook';
  table: string;
  pending: client.Gauge;
  oldest: client.Gauge;
  failures: client.Counter;
}

// Only pending/failed rows are read, so the (status, scheduled_at) index is
// used and the cost does not grow with the table's `sent` history.
const queueSql = (table: string): string => `
  SELECT status,
         count(*)::int AS n,
         COALESCE(EXTRACT(EPOCH FROM now() - min(scheduled_at) FILTER (WHERE scheduled_at <= now())), 0)::float8 AS oldest_age
    FROM ${table}
   WHERE status IN ('pending', 'failed')
   GROUP BY status`;

/**
 * Register and periodically refresh the operational gauges:
 *
 *   pinpoint_db_up                                    1 when `SELECT 1` works
 *   pinpoint_notifications_pending / _oldest_pending_age_seconds
 *   pinpoint_webhook_deliveries_pending / _oldest_pending_age_seconds
 *   pinpoint_notification_failures_total              new permanently-failed notifications
 *   pinpoint_webhook_delivery_failures_total          new permanently-failed deliveries
 *   pinpoint_queue_metrics_last_success_timestamp_seconds
 *
 * A growing oldest-pending age with a healthy DB means the worker is stuck or
 * dead; that is the "worker last-run" signal (the workers themselves are not
 * instrumented). The failure counters are derived from the change in the
 * number of `failed` rows between polls (the first poll only sets the
 * baseline), so they are monotonic even though they are computed in SQL.
 */
export function startQueueMetrics(registry: client.Registry, opts: QueueMetricsOptions): QueueMetrics {
  const asSystem = opts.asSystem ?? runAsSystem;
  const reg = [registry];
  const dbUp = new client.Gauge({ name: 'pinpoint_db_up', help: '1 if the API can query PostgreSQL, else 0.', registers: reg });
  const lastOk = new client.Gauge({
    name: 'pinpoint_queue_metrics_last_success_timestamp_seconds',
    help: 'Unix time of the last successful queue-metrics poll.',
    registers: reg,
  });
  const specs: QueueSpec[] = [
    {
      key: 'notifications',
      table: 'notifications',
      pending: new client.Gauge({ name: 'pinpoint_notifications_pending', help: 'Notifications waiting to be sent.', registers: reg }),
      oldest: new client.Gauge({
        name: 'pinpoint_notifications_oldest_pending_age_seconds',
        help: 'Age of the oldest due pending notification (0 if none).',
        registers: reg,
      }),
      failures: new client.Counter({
        name: 'pinpoint_notification_failures_total',
        help: 'Notifications that newly reached the failed state.',
        registers: reg,
      }),
    },
    {
      key: 'webhook',
      table: 'webhook_deliveries',
      pending: new client.Gauge({ name: 'pinpoint_webhook_deliveries_pending', help: 'Webhook deliveries waiting to be sent.', registers: reg }),
      oldest: new client.Gauge({
        name: 'pinpoint_webhook_deliveries_oldest_pending_age_seconds',
        help: 'Age of the oldest due pending webhook delivery (0 if none).',
        registers: reg,
      }),
      failures: new client.Counter({
        name: 'pinpoint_webhook_delivery_failures_total',
        help: 'Webhook deliveries that newly reached the failed state.',
        registers: reg,
      }),
    },
  ];
  const lastFailed = new Map<string, number>();

  const collect = async (): Promise<void> => {
    try {
      await asSystem(async () => {
        await opts.db.raw('SELECT 1');
        dbUp.set(1);
        for (const q of specs) {
          const { rows } = await opts.db.raw(queueSql(q.table));
          const byStatus = new Map(rows.map((r) => [String(r.status), r]));
          const pending = byStatus.get('pending');
          q.pending.set(Number(pending?.n ?? 0));
          q.oldest.set(Number(pending?.oldest_age ?? 0));
          const failed = Number(byStatus.get('failed')?.n ?? 0);
          const prev = lastFailed.get(q.key);
          if (prev !== undefined && failed > prev) q.failures.inc(failed - prev);
          lastFailed.set(q.key, failed);
        }
      });
      lastOk.set(Date.now() / 1000);
    } catch (err) {
      dbUp.set(0);
      opts.onError?.(err);
    }
  };

  void collect();
  const timer = setInterval(() => void collect(), opts.intervalMs ?? 30_000);
  timer.unref();
  return { collect, stop: () => clearInterval(timer) };
}
