// getCurrentUser use case (Phase 1.5 / Wave 2 follow-up).
//
// Implements `GET /api/v1/users/me`. The dashboard polls this endpoint
// on every page load to confirm the `fl_session` cookie is still valid
// (see `dashboard/src/lib/auth.ts#probeIsAuthed`), so the use case only
// reads — no side effects, no mutation. Returns the safe `User`
// projection (no password hash, no `verified` flag) which is what
// `UserRepo.findById` already produces.
//
// Errors:
//   - `NotFound` when the authenticated `userId` no longer maps to a
//     persisted user (deleted account, stale token).

import { NotFound, err, ok } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { UserRepo } from '../ports/UserRepo.js';
import type { User } from '../User.js';

export interface GetCurrentUserInput {
  userId: string;
}

export interface GetCurrentUserOutput {
  user: User;
}

export interface GetCurrentUserDeps {
  userRepo: UserRepo;
}

export class GetCurrentUser {
  constructor(private readonly deps: GetCurrentUserDeps) {}

  async execute(
    input: GetCurrentUserInput,
  ): Promise<Result<GetCurrentUserOutput, DomainError>> {
    const { userRepo } = this.deps;
    const user = await userRepo.findById(input.userId);
    if (!user) {
      return err(new NotFound('User not found.'));
    }
    return ok({ user });
  }
}
