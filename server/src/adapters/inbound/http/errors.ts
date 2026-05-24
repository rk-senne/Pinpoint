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
// Body shape: `{ error: error.message, ...(error.details ?? {}) }`. The
// task requires a flat envelope so the `details` keys are spread
// alongside `error`. `Validation.issues` (Zod-derived issues) and the
// custom shared-link `attemptsRemaining` / `lockedUntil` fields
// surface through this helper as part of `details`.

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

/**
 * Render a `DomainError` as the canonical HTTP response and return the
 * `Response` so handlers can `return sendDomainError(...)`.
 */
export function sendDomainError(res: Response, error: DomainError): Response {
  const status = STATUS_BY_KIND[error.kind] ?? 500;

  if (error instanceof Locked && typeof error.retryAfterSeconds === 'number') {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
  }

  const body: Record<string, unknown> = { error: error.message };
  const details = detailsOf(error);
  if (details) {
    for (const [k, v] of Object.entries(details)) {
      body[k] = v;
    }
  }
  // Surface lockout metadata when the error is the shared-link variant.
  if (error instanceof Locked) {
    const lockedUntil = (error as unknown as { lockedUntil?: string }).lockedUntil;
    if (typeof lockedUntil === 'string') body.lockedUntil = lockedUntil;
    if (typeof error.retryAfterSeconds === 'number') {
      body.retryAfterSeconds = error.retryAfterSeconds;
    }
  }
  // Surface the remaining-attempts countdown carried by the
  // shared-link `InvalidPassword` variant (Req 15.4). The base
  // `Unauthorized` does not declare the field, so we read it
  // structurally without relying on `instanceof`.
  const attemptsRemaining = (error as unknown as { attemptsRemaining?: number })
    .attemptsRemaining;
  if (typeof attemptsRemaining === 'number') {
    body.attemptsRemaining = attemptsRemaining;
  }

  return res.status(status).json(body);
}

/**
 * Render a Zod `flatten()` payload as a 400 Validation response without
 * needing to construct a `Validation` instance first. Convenience for
 * inbound handlers that want to fail fast on input parsing.
 */
export function sendZodFailure(
  res: Response,
  message: string,
  zodIssues: unknown,
): Response {
  return res.status(400).json({
    error: message,
    issues: zodIssues,
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
