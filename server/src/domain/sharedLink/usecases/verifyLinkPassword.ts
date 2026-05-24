// verifyLinkPassword use case (Phase 1.5 / task 4.7.7).
//
// Implements the lockout finite-state-machine for shared-link password
// verification (Req 9.4 / 9.6 / 15.3 – 15.6). The state machine is
// expressed through Outbound_Ports so the domain layer stays free of
// bcrypt/knex.
//
// State machine
// =============
//
//   load link
//   if locked_until is set AND locked_until > now()  → Locked (Retry-After)
//   if locked_until is set AND locked_until <= now() → reset attempts/lock
//   if no password_hash                              → ok (open link)
//   if no password supplied                          → Validation
//   bcrypt.compare:
//     match    → reset attempts/lock              → ok
//     mismatch → attempts += 1
//                if attempts >= MAX → set locked_until = now + 15m → Locked
//                else                                              → Unauthorized
//
// Constants are intentionally kept module-level so they match the legacy
// service exactly during the transition.

import {
  Locked,
  NotFound,
  Unauthorized,
  Validation,
  err,
  ok,
} from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { Clock } from '../../shared/ports/Clock.js';
import type { PasswordHasher } from '../../auth/ports/PasswordHasher.js';
import type { SharedLinkRepo } from '../ports/SharedLinkRepo.js';

export const MAX_FAILED_ATTEMPTS = 3;
export const LOCKOUT_MINUTES = 15;

export interface VerifyLinkPasswordInput {
  linkId: string;
  password?: string;
}

export interface VerifyLinkPasswordOutput {
  projectId: string;
  /** Number of remaining attempts after a successful match (always MAX). */
  attemptsRemaining: number;
}

export interface VerifyLinkPasswordDeps {
  sharedLinkRepo: SharedLinkRepo;
  passwordHasher: PasswordHasher;
  clock: Clock;
}

/**
 * `Validation` error raised when the link is password-protected but the
 * caller did not supply a password. Inbound adapters may surface this as
 * a 400 with `MISSING_PASSWORD` rather than the generic 400.
 */
export class MissingPassword extends Validation {
  constructor() {
    super('Password is required.');
  }
}

/**
 * `Unauthorized` error carrying the remaining attempts countdown so the
 * inbound adapter can surface it in the response details (matches the
 * legacy `attemptsRemaining` contract used by the dashboard).
 */
export class InvalidPassword extends Unauthorized {
  readonly attemptsRemaining: number;
  constructor(attemptsRemaining: number) {
    super('Incorrect password.');
    this.attemptsRemaining = attemptsRemaining;
  }
}

/**
 * `Locked` error variant carrying the absolute `lockedUntil` timestamp in
 * addition to the inherited `retryAfterSeconds`. The HTTP layer renders
 * both — `Retry-After` header from the seconds, `details.lockedUntil`
 * ISO-8601 from the timestamp.
 */
export class SharedLinkLocked extends Locked {
  readonly lockedUntil: string;
  constructor(retryAfterSeconds: number, lockedUntil: string) {
    super(
      'Access is locked due to too many failed attempts.',
      retryAfterSeconds,
    );
    this.lockedUntil = lockedUntil;
  }
}

export class VerifyLinkPassword {
  constructor(private readonly deps: VerifyLinkPasswordDeps) {}

  async execute(
    input: VerifyLinkPasswordInput,
  ): Promise<Result<VerifyLinkPasswordOutput, DomainError>> {
    const { sharedLinkRepo, passwordHasher, clock } = this.deps;

    const link = await sharedLinkRepo.findById(input.linkId);
    if (!link) {
      return err(new NotFound('Shared link not found.'));
    }

    let { failedAttempts, lockedUntil } = link;

    // --- Lock evaluation ---
    if (lockedUntil) {
      const lockedUntilDate = new Date(lockedUntil);
      const now = clock.now();
      if (now < lockedUntilDate) {
        const retryAfter = Math.max(
          1,
          Math.ceil((lockedUntilDate.getTime() - now.getTime()) / 1000),
        );
        return err(
          new SharedLinkLocked(retryAfter, lockedUntilDate.toISOString()),
        );
      }
      // Stale lock — clear before evaluating the password (Req 15.6).
      await sharedLinkRepo.update(link.id, {
        failedAttempts: 0,
        lockedUntil: null,
      });
      failedAttempts = 0;
      lockedUntil = null;
    }

    // --- Open link ---
    if (!link.passwordHash) {
      return ok({
        projectId: link.projectId,
        attemptsRemaining: MAX_FAILED_ATTEMPTS,
      });
    }

    // --- Password required ---
    if (typeof input.password !== 'string' || input.password.length === 0) {
      return err(new MissingPassword());
    }

    const isMatch = await passwordHasher.verify(
      input.password,
      link.passwordHash,
    );

    if (isMatch) {
      // Success: reset counters (Req 15.3).
      await sharedLinkRepo.update(link.id, {
        failedAttempts: 0,
        lockedUntil: null,
      });
      return ok({
        projectId: link.projectId,
        attemptsRemaining: MAX_FAILED_ATTEMPTS,
      });
    }

    // --- Mismatch: increment and possibly lock ---
    const newFailedAttempts = (failedAttempts || 0) + 1;

    if (newFailedAttempts >= MAX_FAILED_ATTEMPTS) {
      const lockedUntilDate = new Date(
        clock.now().getTime() + LOCKOUT_MINUTES * 60 * 1000,
      );
      await sharedLinkRepo.update(link.id, {
        failedAttempts: newFailedAttempts,
        lockedUntil: lockedUntilDate.toISOString(),
      });
      return err(
        new SharedLinkLocked(
          LOCKOUT_MINUTES * 60,
          lockedUntilDate.toISOString(),
        ),
      );
    }

    await sharedLinkRepo.update(link.id, {
      failedAttempts: newFailedAttempts,
    });

    return err(
      new InvalidPassword(MAX_FAILED_ATTEMPTS - newFailedAttempts),
    );
  }
}
