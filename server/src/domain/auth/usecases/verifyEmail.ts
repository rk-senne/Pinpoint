// verifyEmail use case (Phase 1.5 / task 4.7.1).
//
// Hex extraction of `POST /api/auth/verify-email/:token` (task 6.2 /
// Req 20.2, 20.3). Looks up the supplied raw token by its sha256 hash
// in the `auth_tokens` table, requires `kind='verify_email'`, unused,
// and not yet expired. On a hit we flip `users.verified=true` and mark
// the token used. Both writes happen through the repos; persisting them
// in a single transaction is the postgres adapter's responsibility.
//
// Missing / expired / already-used tokens MUST NOT flip the verified
// flag; we surface them as `Validation` so the inbound adapter renders
// the legacy `INVALID_TOKEN` 400 response.

import { createHash } from 'node:crypto';
import { Validation, err, ok } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { Clock } from '../../shared/ports/Clock.js';
import type { AuthTokenRepo } from '../ports/AuthTokenRepo.js';
import type { UserRepo } from '../../user/ports/UserRepo.js';

export interface VerifyEmailInput {
  /** Raw token from the verification link emailed to the user. */
  token: string;
}

export interface VerifyEmailOutput {
  verified: true;
}

export interface VerifyEmailDeps {
  authTokenRepo: AuthTokenRepo;
  userRepo: UserRepo;
  clock: Clock;
}

export class VerifyEmail {
  constructor(private readonly deps: VerifyEmailDeps) {}

  async execute(
    input: VerifyEmailInput,
  ): Promise<Result<VerifyEmailOutput, DomainError>> {
    const { authTokenRepo, userRepo, clock } = this.deps;

    const invalidToken = (): Result<VerifyEmailOutput, DomainError> =>
      err(
        new Validation('Verification token is invalid or has expired.'),
      );

    if (typeof input.token !== 'string' || input.token.length === 0) {
      return invalidToken();
    }

    const tokenHash = createHash('sha256').update(input.token).digest('hex');
    const record = await authTokenRepo.findValid(
      tokenHash,
      'verify_email',
      clock.now(),
    );
    if (!record) {
      return this.confirmEmailChange(tokenHash, clock.now());
    }

    await userRepo.markVerified(record.userId);
    await authTokenRepo.markUsed(record.id);

    return ok({ verified: true });
  }

  /**
   * PP-06: the same dashboard link (`/verify-email/:token`) also confirms an
   * e-mail change. Applies the stored `pending_email`, clears it, revokes every
   * session of the user (token_version bump) and burns the token.
   */
  private async confirmEmailChange(
    tokenHash: string,
    now: Date,
  ): Promise<Result<VerifyEmailOutput, DomainError>> {
    const { authTokenRepo, userRepo } = this.deps;
    const invalid = (): Result<VerifyEmailOutput, DomainError> =>
      err(new Validation('Verification token is invalid or has expired.'));
    const record = await authTokenRepo.findValid(tokenHash, 'change_email', now);
    if (!record) return invalid();
    const user = await userRepo.findByIdWithSecret(record.userId);
    const pending = user?.pendingEmail;
    if (!user || !pending) {
      await authTokenRepo.markUsed(record.id);
      return invalid();
    }
    const taken = await userRepo.findByEmail(pending);
    if (taken && taken.id !== user.id) {
      await authTokenRepo.markUsed(record.id);
      await userRepo.setPendingEmail(user.id, null);
      return invalid();
    }
    await userRepo.update(user.id, { email: pending, verified: true });
    await userRepo.setPendingEmail(user.id, null);
    await authTokenRepo.markUsed(record.id);
    await userRepo.incrementTokenVersion(user.id);
    return ok({ verified: true });
  }
}
