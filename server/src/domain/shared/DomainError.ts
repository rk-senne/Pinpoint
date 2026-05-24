// Domain error hierarchy (Req 54.4 / Phase 1.5 task 4.6.3).
//
// Use_Cases return `Result<T, DomainError>` rather than throwing. Inbound
// adapters (HTTP routes, WebSocket handlers, workers) translate the `kind`
// discriminator into the correct transport-level response: 404 for
// `NotFound`, 403 for `Forbidden`, 409 for `Conflict`, 400 for
// `Validation`, 401 for `Unauthorized`, 423 for `Locked`, 503 for
// `Unavailable`.
//
// The kind tag is duplicated across the abstract base and each concrete
// subclass so both `instanceof` checks and exhaustive `switch (err.kind)`
// branches type-narrow correctly.
//
// Domain code MUST NOT import any infrastructure (Express, knex, pg,
// bcrypt, …); the only dependency is `zod` for the optional `issues`
// payload on `Validation`.

import type { ZodIssue } from 'zod';

export type DomainErrorKind =
  | 'NotFound'
  | 'Forbidden'
  | 'Conflict'
  | 'Validation'
  | 'Unauthorized'
  | 'Locked'
  | 'Unavailable';

export abstract class DomainError extends Error {
  abstract readonly kind: DomainErrorKind;

  constructor(message: string) {
    super(message);
    // `Error` does not carry `.name` from the concrete class by default.
    // Set it explicitly so logs surface the right type.
    this.name = new.target.name;
  }
}

export class NotFound extends DomainError {
  readonly kind = 'NotFound' as const;

  constructor(message = 'Resource not found.') {
    super(message);
  }
}

export class Forbidden extends DomainError {
  readonly kind = 'Forbidden' as const;

  constructor(message = 'Access is forbidden.') {
    super(message);
  }
}

export class Conflict extends DomainError {
  readonly kind = 'Conflict' as const;

  constructor(message = 'Conflict with current resource state.') {
    super(message);
  }
}

export class Validation extends DomainError {
  readonly kind = 'Validation' as const;
  readonly issues?: ZodIssue[];

  constructor(message = 'Invalid input.', issues?: ZodIssue[]) {
    super(message);
    this.issues = issues;
  }
}

export class Unauthorized extends DomainError {
  readonly kind = 'Unauthorized' as const;

  constructor(message = 'Authentication required.') {
    super(message);
  }
}

export class Locked extends DomainError {
  readonly kind = 'Locked' as const;
  /** Optional seconds until the lock expires (used for the `Retry-After` header). */
  readonly retryAfterSeconds?: number;

  constructor(message = 'Resource is locked.', retryAfterSeconds?: number) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class Unavailable extends DomainError {
  readonly kind = 'Unavailable' as const;

  constructor(message = 'Service is unavailable.') {
    super(message);
  }
}

// --- Result helper -----------------------------------------------------------

/**
 * Disjoint union returned by Use_Cases. `value` is only present on the
 * success branch; `error` is only present on the failure branch. Pattern
 * matches as `if (r.ok) { … r.value … } else { … r.error … }`.
 */
export type Result<T, E = DomainError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function err<E = DomainError>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}
