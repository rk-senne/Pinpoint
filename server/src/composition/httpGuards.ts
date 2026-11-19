// Small HTTP guards wired by the composition root (F-14), extracted so they
// can be unit-tested without booting the whole container.

import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';

import { StorageUnavailableError } from '../domain/annotation/ports/ScreenshotStore.js';

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

export interface ErrorHandlerOptions {
  /** `config.nodeEnv` (NODE_ENV). */
  nodeEnv: string;
  /** `isExposedDeployment(env)` — production / self-host / non-loopback bind. */
  exposed: boolean;
}

/**
 * 4xx errors raised by body-parser / http-errors keep a safe, fixed message.
 * Everything else is a server fault: the client ALWAYS gets the generic
 * `Internal server error` body (never `err.message`, which can carry SQL,
 * file paths or driver details) and the real error goes to the log only.
 * The stack is attached only for `NODE_ENV=development` on a deployment that
 * is not exposed.
 */
export function createErrorHandler(opts: ErrorHandlerOptions): ErrorRequestHandler {
  const includeStack = opts.nodeEnv === 'development' && !opts.exposed;

  return (err: Error, req: Request, res: Response, _next: NextFunction): void => {
    // body-parser / http-errors set `status` (400 malformed JSON, 413 too
    // large, 415 bad charset). Those are client errors, not server faults.
    const httpStatus =
      (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
    if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500) {
      const type = (err as { type?: string }).type;
      const clientCode =
        type === 'entity.parse.failed' ? 'INVALID_JSON'
          : type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE'
            : 'BAD_REQUEST';
      const clientMessage =
        clientCode === 'INVALID_JSON' ? 'Request body is not valid JSON.'
          : clientCode === 'PAYLOAD_TOO_LARGE' ? 'Request body is too large.'
            : 'Bad request.';
      res.status(httpStatus).json({ error: { code: clientCode, message: clientMessage, details: {} } });
      return;
    }

    // Object storage missing/unreachable is an operational outage, not a bug:
    // surface it as 503 with a fixed, safe message (detail goes to the log).
    if (err instanceof StorageUnavailableError) {
      req.log?.error({ err }, 'Storage unavailable');
      res.status(503).json({
        error: {
          code: 'UNAVAILABLE',
          message: 'Screenshot storage is not configured or is currently unreachable.',
          details: {},
        },
      });
      return;
    }

    // Full detail (message, SQL, stack, driver code) is for the log only.
    req.log?.error({ err }, 'Unhandled error');

    const body: { error: { code: string; message: string; details?: { stack?: string } } } = {
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    };
    if (includeStack && err.stack) {
      body.error.details = { stack: err.stack };
    }
    res.status(500).json(body);
  };
}

// ---------------------------------------------------------------------------
// UUID path-segment guard
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Top-level `/api/v1/<resource>/<id>` resources whose `<id>` is a Postgres
 * `uuid` column, mapped to the literal (non-id) sub-paths their routers
 * register. A malformed id would otherwise reach Postgres and surface as a
 * `22P02 invalid input syntax for type uuid` 500.
 *
 * Deliberately NOT guarded: `/shared/:linkId` and `/review/:linkId` (shared
 * link ids are opaque non-UUID tokens) and every other mount.
 */
const UUID_RESOURCES: Readonly<Record<string, ReadonlySet<string>>> = {
  projects: new Set(['by-url']),
  annotations: new Set(),
  teams: new Set(),
  webhooks: new Set(['events']),
  'api-keys': new Set(),
};

/**
 * Express middleware mounted at `/api/v1`: responds 400 `INVALID_ID` when the
 * path segment following `/projects/`, `/annotations/`, `/teams/`,
 * `/webhooks/` or `/api-keys/` is neither a UUID nor a known literal route.
 */
export function uuidPathGuard(req: Request, res: Response, next: NextFunction): void {
  // `req.path` is relative to the mount point (`/api/v1`).
  const [, resource, segment] = req.path.split('/');
  const literals = resource ? UUID_RESOURCES[resource] : undefined;
  if (literals && segment) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      /* keep raw; fails the UUID test below */
    }
    if (!UUID_RE.test(decoded) && !literals.has(decoded)) {
      res.status(400).json({
        error: { code: 'INVALID_ID', message: 'Malformed identifier in request path.', details: {} },
      });
      return;
    }
  }
  next();
}
