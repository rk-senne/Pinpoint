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
 *
 * Mission A4: sensitive credential fields are redacted wherever they appear in
 * a logged object. We list both the bare key (depth-0) and common nested
 * locations (headers, req/res, body, config, integration/data) so an errant
 * `logger.info({ integration })` or `req.log.error({ err, body })` can't leak
 * an access token, refresh token, client secret, password, cookie, or auth
 * header into the log stream. `censor` is the default `[Redacted]`.
 */
const REDACT_KEYS = [
  'authorization',
  'cookie',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'client_secret',
  'clientSecret',
  'password',
  'token',
  'rawKey',
  'secret',
];

const REDACT_PARENTS = ['', '*', 'headers', 'req.headers', 'res.headers', 'body', 'config', 'data', 'integration'];

/** Cartesian expansion of parent paths × sensitive keys into pino redact paths. */
const REDACT_PATHS = REDACT_PARENTS.flatMap((parent) =>
  REDACT_KEYS.map((key) => (parent === '' ? key : `${parent}.${key}`)),
);

/**
 * Header-specific paths. Header names containing a dash need bracket notation
 * in pino redact paths. Covers both inbound request headers and the response
 * `set-cookie` header that pino-http serialises at `res.headers`.
 */
const REDACT_HEADER_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-project-key"]',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
  'headers["x-csrf-token"]',
  'headers["x-project-key"]',
  'headers["x-api-key"]',
  'headers["set-cookie"]',
  // Body fields (req.body is not logged by pino-http by default, but an
  // errant `{ req, body }` context must not leak credentials either).
  'req.body.password',
  'req.body.token',
  'req.body.rawKey',
  'req.body.secret',
  'req.body.clientSecret',
];

/**
 * The single redaction config shared by the root logger AND the per-request
 * pino-http logger built in `composition/container.ts` (F-04). Anything that
 * constructs a pino instance for HTTP traffic must pass this.
 */
export const REDACT_OPTIONS = {
  paths: [...REDACT_PATHS, ...REDACT_HEADER_PATHS],
  censor: '[Redacted]',
} as const;

/**
 * pino options (level + redaction) shared by every pino instance in the
 * process, including the one the composition root hands to pino-http so
 * request/response headers are redacted in HTTP access logs (F-04).
 */
export function buildPinoOptions(level: string): pino.LoggerOptions {
  return { level, redact: { paths: [...REDACT_OPTIONS.paths], censor: REDACT_OPTIONS.censor } };
}

export const logger = pino(buildPinoOptions(process.env.LOG_LEVEL || 'info'));

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
