import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import pino from 'pino';
import pinoHttp from 'pino-http';

/**
 * Root structured logger for the API server (Requirement 27.1).
 *
 * All boot-time and out-of-request log output flows through this instance.
 * Request handlers SHOULD use the per-request child logger attached at
 * `req.log` by the `httpLogger` middleware below so that records inherit
 * the request_id field (Requirement 27.4).
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

/**
 * pino-http middleware (Requirement 27.2 / 27.4).
 *
 * - Generates a request_id for every incoming request, preferring an
 *   inbound `X-Request-Id` header when present and falling back to a
 *   freshly minted UUID v4. The chosen id is exposed as `req.id` and
 *   echoed back to the client via the `X-Request-Id` response header
 *   so callers can correlate their own logs.
 * - Attaches a child logger bound to that id at `req.log`, which the
 *   global error handler and downstream route handlers can use to emit
 *   one JSON record per request including method, path, status, and
 *   latency.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req: IncomingMessage, res: ServerResponse) => {
    const headerId = req.headers['x-request-id'];
    const incoming = Array.isArray(headerId) ? headerId[0] : headerId;
    const id = incoming && incoming.trim().length > 0 ? incoming : randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
});
