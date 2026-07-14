// Inbound HTTP adapter — DomainError ↔ HTTP response mapping
// (Phase 1.5 / task 4.9.1).
//
// Use_Cases return `Result<T, DomainError>`; this module is the single
// place that translates a `DomainError` `kind` discriminator into an
// Express response. Routes never `switch (err.kind)` themselves — they
// call `sendDomainError(res, err)` and let this module own the HTTP
// vocabulary.
//
// Status mapping (per task 4.9.1 spec):
//   NotFound      → 404
//   Forbidden     → 403
//   Conflict      → 409
//   Validation    → 400
//   Unauthorized  → 401
//   Locked        → 423   (with `Retry-After` header from `retryAfterSeconds`)
//   Unavailable   → 503
//
// Body shape: `{ error: { code: "SNAKE_UPPER_CASE", message: "...", details?: {} } }`.
// All domain errors now emit a standard envelope matching `ApiErrorEnvelope`
// from `@pinpoint/shared`. Validation issues surface inside `details.issues`,
// and lock/attempt metadata lives inside `details` as well.

import type { Response } from 'express';
import type { DomainError } from '../../../domain/shared/DomainError.js';
import {
  Locked,
  Validation,
} from '../../../domain/shared/DomainError.js';

const STATUS_BY_KIND: Record<DomainError['kind'], number> = {
  NotFound: 404,
  Forbidden: 403,
  Conflict: 409,
  Validation: 400,
  Unauthorized: 401,
  Locked: 423,
  Unavailable: 503,
};

/**
 * Optional per-instance details surfaced through subclasses. The base
 * `DomainError` does not declare `details` itself, so we read it
 * defensively via a structural cast.
 */
function detailsOf(error: DomainError): Record<string, unknown> | undefined {
  const maybe = (error as unknown as { details?: Record<string, unknown> }).details;
  if (maybe && typeof maybe === 'object') return maybe;

  // Validation surfaces Zod issues through the `issues` field; the task
  // spec asks for them in the response body so a misformed request is
  // self-describing.
  if (error instanceof Validation && error.issues && error.issues.length > 0) {
    return { issues: error.issues };
  }
  return undefined;
}

/** Map DomainError kind to a SNAKE_UPPER_CASE code. */
const CODE_BY_KIND: Record<DomainError['kind'], string> = {
  NotFound: 'NOT_FOUND',
  Forbidden: 'FORBIDDEN',
  Conflict: 'CONFLICT',
  Validation: 'VALIDATION',
  Unauthorized: 'UNAUTHORIZED',
  Locked: 'LOCKED',
  Unavailable: 'UNAVAILABLE',
};

/**
 * Render a `DomainError` as the canonical HTTP response and return the
 * `Response` so handlers can `return sendDomainError(...)`.
 *
 * Standard shape:
 * ```json
 * { "error": { "code": "SNAKE_UPPER_CASE", "message": "Human readable", "details": {} } }
 * ```
 */
export function sendDomainError(res: Response, error: DomainError): Response {
  const status = STATUS_BY_KIND[error.kind] ?? 500;

  if (error instanceof Locked && typeof error.retryAfterSeconds === 'number') {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
  }

  const code = CODE_BY_KIND[error.kind] ?? 'INTERNAL_ERROR';
  const details: Record<string, unknown> = {};

  // Surface domain-level details (e.g. Validation.issues).
  const domainDetails = detailsOf(error);
  if (domainDetails) {
    for (const [k, v] of Object.entries(domainDetails)) {
      details[k] = v;
    }
  }

  // Surface lockout metadata when the error is the shared-link variant.
  if (error instanceof Locked) {
    const lockedUntil = (error as unknown as { lockedUntil?: string }).lockedUntil;
    if (typeof lockedUntil === 'string') details.lockedUntil = lockedUntil;
    if (typeof error.retryAfterSeconds === 'number') {
      details.retryAfterSeconds = error.retryAfterSeconds;
    }
  }

  // Surface the remaining-attempts countdown carried by the
  // shared-link `InvalidPassword` variant (Req 15.4).
  const attemptsRemaining = (error as unknown as { attemptsRemaining?: number })
    .attemptsRemaining;
  if (typeof attemptsRemaining === 'number') {
    details.attemptsRemaining = attemptsRemaining;
  }

  const body: { error: { code: string; message: string; details?: Record<string, unknown> } } = {
    error: { code, message: error.message },
  };
  if (Object.keys(details).length > 0) {
    body.error.details = details;
  }

  return res.status(status).json(body);
}

/**
 * Render a Zod `flatten()` payload as a 400 Validation response without
 * needing to construct a `Validation` instance first. Convenience for
 * inbound handlers that want to fail fast on input parsing.
 *
 * Standard shape:
 * ```json
 * { "error": { "code": "VALIDATION", "message": "...", "details": { "issues": ... } } }
 * ```
 */
export function sendZodFailure(
  res: Response,
  message: string,
  zodIssues: unknown,
): Response {
  return res.status(400).json({
    error: {
      code: 'VALIDATION',
      message,
      details: { issues: zodIssues },
    },
  });
}

/**
 * Coerce a `req.params[name]` slot to a single string. Express types
 * the field as `string | string[]` (the array variant only happens
 * when route params are listed twice in the path); routes that mount
 * with `mergeParams` inherit the broader type. The Express runtime
 * never produces an array for our paths, so the helper picks the
 * first entry defensively and returns `''` when the slot is missing.
 */
export function paramString(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? '';
  return '';
}

/**
 * Validate that a route parameter value is a well-formed UUID.
 * Returns `true` if valid, `false` (after sending 400) if invalid.
 * Use as an early guard in handlers that accept UUID path params.
 */
export function validateUuidParam(res: Response, paramName: string, value: string): boolean {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(value)) {
    res.status(400).json({ error: { code: 'VALIDATION', message: `${paramName} must be a valid UUID`, details: {} } });
    return false;
  }
  return true;
}
