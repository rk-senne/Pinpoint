// registerUser use case (Phase 1.5 / task 4.7.1).
//
// Implements `POST /api/auth/register`.
// Pipeline:
//   1. Validate password against the shared Common_Passwords_Blocklist
//      policy (Req 1.10/1.11) — fast-fail before doing any I/O.
//   2. Reject duplicate email with `Conflict` (Req 1.5).
//   3. Hash the password through the `PasswordHasher` port (the bcrypt
//      adapter is the only file that imports `bcrypt`).
//   4. Insert the user as `verified: false` so login is blocked until
//      they complete the verify-email flow (Req 20.1, task 6.4).
//   5. Mint a single-use `verify_email` `AuthToken`: the raw token is
//      sha256-hashed and stored as the hash; the raw value is included
//      in the link sent to the user's inbox.
//   6. Hand off the verification email to the durable
//      `NotificationQueue` (Req 28). The queue dispatcher renders the
//      template and ships it through the `Mailer` adapter — domain
//      code never imports nodemailer.
//
// `node:crypto` is a Node built-in (not a restricted infra package per
// `.eslintrc.cjs`'s `no-restricted-imports` allow-list); using it here
// for random-bytes + sha256 keeps the use case dependency-free.

import { randomBytes, createHash } from 'node:crypto';
import { validatePassword } from '@pinpoint/shared';
import {
  Conflict,
  Validation,
  err,
  ok,
} from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { Clock } from '../../shared/ports/Clock.js';
import type { PasswordHasher } from '../ports/PasswordHasher.js';
import type { AuthTokenRepo } from '../ports/AuthTokenRepo.js';
import type { NotificationQueue } from '../../notification/ports/NotificationQueue.js';
import type { UserRepo } from '../../user/ports/UserRepo.js';
import type { User } from '../../user/User.js';

/** TTL for the issued `verify_email` token (Req 20.1). */
export const VERIFY_EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface RegisterUserInput {
  email: string;
  password: string;
  name: string;
}

export interface RegisterUserOutput {
  user: User;
}

export interface RegisterUserDeps {
  userRepo: UserRepo;
  authTokenRepo: AuthTokenRepo;
  passwordHasher: PasswordHasher;
  notificationQueue: NotificationQueue;
  clock: Clock;
  /**
   * Composition-root supplied URL builder so the domain doesn't have to
   * know `process.env.APP_URL`. Returns the absolute verify-email link
   * for `rawToken`.
   */
  buildVerifyEmailLink: (rawToken: string) => string;
}

export class RegisterUser {
  constructor(private readonly deps: RegisterUserDeps) {}

  async execute(
    input: RegisterUserInput,
  ): Promise<Result<RegisterUserOutput, DomainError>> {
    const {
      userRepo,
      authTokenRepo,
      passwordHasher,
      notificationQueue,
      clock,
      buildVerifyEmailLink,
    } = this.deps;

    // --- Input validation ----------------------------------------------------
    if (
      typeof input.email !== 'string' ||
      typeof input.password !== 'string' ||
      typeof input.name !== 'string'
    ) {
      return err(
        new Validation('Email, password, and name must be strings.'),
      );
    }
    if (
      input.email.length === 0 ||
      input.password.length === 0 ||
      input.name.length === 0
    ) {
      return err(
        new Validation('Email, password, and name are required.'),
      );
    }

    const policy = validatePassword(input.password);
    if (!policy.ok) {
      return err(new Validation(policy.error));
    }

    const normalizedEmail = input.email.toLowerCase();

    // --- Duplicate email guard ----------------------------------------------
    const existing = await userRepo.findByEmail(normalizedEmail);
    if (existing) {
      return err(new Conflict('Email already registered.'));
    }

    // --- Persist user (unverified) ------------------------------------------
    const passwordHash = await passwordHasher.hash(input.password);
    const user = await userRepo.insert({
      email: normalizedEmail,
      name: input.name,
      passwordHash,
      verified: false,
    });

    // --- Mint single-use verify_email token ---------------------------------
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(
      clock.now().getTime() + VERIFY_EMAIL_TOKEN_TTL_MS,
    ).toISOString();

    await authTokenRepo.insert({
      userId: user.id,
      kind: 'verify_email',
      tokenHash,
      expiresAt,
    });

    // --- Enqueue verification email -----------------------------------------
    await notificationQueue.enqueue(
      {
        kind: 'verify_email',
        recipientUserId: user.id,
        recipientEmail: user.email,
        link: buildVerifyEmailLink(rawToken),
      },
      clock.now(),
    );

    return ok({ user });
  }
}
