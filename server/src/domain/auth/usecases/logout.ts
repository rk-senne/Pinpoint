// logout use case (Phase 1.5 / task 4.7.1).
//
// Hex extraction of `POST /api/v1/auth/logout` (task 7.5 / Req 18.1).
// The current design (key decision #19 in design.md) uses sliding-window
// JWTs with no separate refresh-token table, so there is no server-side
// session state to revoke — logout is effectively "tell the dashboard
// to clear its cookies" plus "extension clears its `chrome.storage.local`
// bearer." Cookie clearing is the inbound adapter's job; this use case
// owns the (currently trivial) server-side bookkeeping plus the seam
// where future revocation lists or refresh-token rows would attach.
//
// Logout also bumps the user's token_version (when `userRepo` is wired) so
// the old JWT is rejected server-side, not merely forgotten by the browser.
//
// The `AuthTokenRepo` dependency is wired through per the task spec so
// that when a revocable-token kind is added (e.g., `'session'` or
// `'refresh'`), invalidation lands here without touching every caller.
// Today we additionally mark any outstanding `verify_email` /
// `reset_password` tokens for the user as used, so a stolen reset link
// does not survive an explicit sign-out. Callers without a known
// `userId` (anonymous logout from the dashboard when the cookie is
// already gone) are handled as a no-op success.

import { ok } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { AuthTokenRepo } from '../ports/AuthTokenRepo.js';
import type { UserRepo } from '../../user/ports/UserRepo.js';

export interface LogoutInput {
  /** Authenticated user id, or null when the caller has no valid session. */
  userId: string | null;
}

export interface LogoutOutput {
  success: true;
}

export interface LogoutDeps {
  authTokenRepo: AuthTokenRepo;
  /**
   * When wired, logout bumps `users.token_version`, invalidating every JWT
   * previously issued to the user (the auth middleware rejects lower
   * versions). Without it logout only clears cookies client-side.
   */
  userRepo?: UserRepo;
}

export class Logout {
  constructor(private readonly deps: LogoutDeps) {}

  async execute(
    input: LogoutInput,
  ): Promise<Result<LogoutOutput, DomainError>> {
    const { authTokenRepo } = this.deps;

    if (typeof input.userId === 'string' && input.userId.length > 0) {
      // Belt-and-braces: invalidate any outstanding single-use tokens so
      // a stolen reset / verify link cannot survive an explicit logout.
      await authTokenRepo.markAllUsedForUser(input.userId, 'reset_password');
      await authTokenRepo.markAllUsedForUser(input.userId, 'verify_email');
      // Server-side session revocation: a stolen bearer/cookie dies here.
      await this.deps.userRepo?.incrementTokenVersion(input.userId);
    }

    return ok({ success: true });
  }
}
