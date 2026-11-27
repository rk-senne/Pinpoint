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
// Access: when METRICS_TOKEN is set, scrapers must send
// `Authorization: Bearer <token>`; otherwise only loopback / private-network
// callers (in-cluster Prometheus, the compose `monitoring` profile) are
// allowed. The endpoint is never exposed to the public internet by default.

import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import client from 'prom-client';

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
