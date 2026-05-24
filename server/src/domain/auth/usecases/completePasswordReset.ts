// completePasswordReset use case (Phase 1.5 / task 4.7.1).
//
// Hex extraction of `POST /api/auth/reset-password/:token`.
// Validates the supplied raw token (sha256-hashed against
// `auth_tokens.token_hash` with `kind='reset_password'`, unused, and
// not yet expired), enforces the password policy, hashes the new
// password through `PasswordHasher`, then atomically updates the
// user's `password_hash` and marks the token used. Atomicity is the
// outbound adapter's responsibility — the use case calls the two
// repos in order and the postgres adapter wraps both writes in a
// transaction.

import { createHash } from 'node:crypto';
import { validatePassword } from '@pinpoint/shared';
import { Validation, err, ok } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { Clock } from '../../shared/ports/Clock.js';
import type { AuthTokenRepo } from '../ports/AuthTokenRepo.js';
import type { PasswordHasher } from '../ports/PasswordHasher.js';
import type { UserRepo } from '../../user/ports/UserRepo.js';

export interface CompletePasswordResetInput {
  /** Raw token from the email link. */
  token: string;
  /** New plaintext password chosen by the user. */
  newPassword: string;
}

export interface CompletePasswordResetOutput {
  passwordReset: true;
}

export interface CompletePasswordResetDeps {
  userRepo: UserRepo;
  authTokenRepo: AuthTokenRepo;
  passwordHasher: PasswordHasher;
  clock: Clock;
}

export class CompletePasswordReset {
  constructor(private readonly deps: CompletePasswordResetDeps) {}

  async execute(
    input: CompletePasswordResetInput,
  ): Promise<Result<CompletePasswordResetOutput, DomainError>> {
    const { userRepo, authTokenRepo, passwordHasher, clock } = this.deps;

    if (typeof input.newPassword !== 'string') {
      return err(new Validation('Password must be a string.'));
    }
    if (input.newPassword.length === 0) {
      return err(new Validation('New password is required.'));
    }
    const policy = validatePassword(input.newPassword);
    if (!policy.ok) {
      return err(new Validation(policy.error));
    }

    if (typeof input.token !== 'string' || input.token.length === 0) {
      return err(new Validation('Reset token is invalid or has expired.'));
    }

    const tokenHash = createHash('sha256').update(input.token).digest('hex');
    const record = await authTokenRepo.findValid(
      tokenHash,
      'reset_password',
      clock.now(),
    );
    if (!record) {
      return err(new Validation('Reset token is invalid or has expired.'));
    }

    const passwordHash = await passwordHasher.hash(input.newPassword);

    await userRepo.update(record.userId, { passwordHash });
    await authTokenRepo.markUsed(record.id);

    return ok({ passwordReset: true });
  }
}
