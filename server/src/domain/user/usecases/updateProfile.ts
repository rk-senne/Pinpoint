// updateProfile use case (Phase 1.5 / Wave 2 follow-up).
//
// Implements `PUT /api/v1/users/me`. Patches the authenticated user's
// `name`, `email`, and / or `avatarUrl`. At least one field must be
// supplied; each supplied field is validated independently.
//
// Errors:
//   - `Validation` when the patch is empty, when a string field is
//     blank, or when `avatarUrl` has the wrong type.
//   - `Conflict` when changing `email` collides with another account
//     (Req 1.5 — emails are unique).
//   - `NotFound` when the user disappeared between the auth check and
//     the patch (deleted account or stale token).

import {
  Conflict,
  NotFound,
  Validation,
  err,
  ok,
} from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { UserRepo } from '../ports/UserRepo.js';
import type { User, UserPatch } from '../User.js';

export interface UpdateProfileInput {
  userId: string;
  name?: string;
  email?: string;
  avatarUrl?: string | null;
}

export interface UpdateProfileOutput {
  user: User;
}

export interface UpdateProfileDeps {
  userRepo: UserRepo;
}

export class UpdateProfile {
  constructor(private readonly deps: UpdateProfileDeps) {}

  async execute(
    input: UpdateProfileInput,
  ): Promise<Result<UpdateProfileOutput, DomainError>> {
    const { userRepo } = this.deps;
    const patch: UserPatch = {};

    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || input.name.trim().length === 0) {
        return err(new Validation('Name must be a non-empty string.'));
      }
      patch.name = input.name.trim();
    }

    if (input.email !== undefined) {
      if (typeof input.email !== 'string' || input.email.trim().length === 0) {
        return err(new Validation('Email must be a non-empty string.'));
      }
      const normalizedEmail = input.email.toLowerCase().trim();
      const collision = await userRepo.findByEmail(normalizedEmail);
      if (collision && collision.id !== input.userId) {
        return err(
          new Conflict('Email already in use by another account.'),
        );
      }
      patch.email = normalizedEmail;
    }

    if (input.avatarUrl !== undefined) {
      if (input.avatarUrl !== null && typeof input.avatarUrl !== 'string') {
        return err(new Validation('Avatar URL must be a string or null.'));
      }
      patch.avatarUrl = input.avatarUrl;
    }

    if (Object.keys(patch).length === 0) {
      return err(new Validation('No valid fields provided for update.'));
    }

    // Confirm the user exists before issuing the update so we can return
    // a meaningful `NotFound` instead of relying on the repo throwing.
    const existing = await userRepo.findById(input.userId);
    if (!existing) {
      return err(new NotFound('User not found.'));
    }

    const user = await userRepo.update(input.userId, patch);
    return ok({ user });
  }
}
