// updateNotificationPreferences use case (Phase 1.5 / Wave 2 follow-up).
//
// Implements `PUT /api/v1/users/me/notifications`. Accepts a partial
// `NotificationPreferences` patch — each supplied key must be a
// boolean. The merge against the current preferences is the
// `UserRepo.update` adapter's job (see `PgUserRepo.update`'s
// `notification_preferences` branch and the matching merge in
// `FakeUserRepo`).
//
// Errors:
//   - `Validation` when the patch is empty or any value is not a
//     boolean.
//   - `NotFound` when the authenticated `userId` no longer maps to a
//     user.

import {
  NotFound,
  Validation,
  err,
  ok,
} from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { UserRepo } from '../ports/UserRepo.js';
import type { NotificationPreferences, User } from '../User.js';

const VALID_KEYS: readonly (keyof NotificationPreferences)[] = [
  'newAnnotation',
  'newComment',
  'promotedToOwner',
  'projectDeleted',
] as const;

export interface UpdateNotificationPreferencesInput {
  userId: string;
  preferences: Partial<NotificationPreferences>;
}

export interface UpdateNotificationPreferencesOutput {
  user: User;
  notificationPreferences: NotificationPreferences;
}

export interface UpdateNotificationPreferencesDeps {
  userRepo: UserRepo;
}

export class UpdateNotificationPreferences {
  constructor(private readonly deps: UpdateNotificationPreferencesDeps) {}

  async execute(
    input: UpdateNotificationPreferencesInput,
  ): Promise<
    Result<UpdateNotificationPreferencesOutput, DomainError>
  > {
    const { userRepo } = this.deps;
    const patch: Partial<NotificationPreferences> = {};

    const incoming = (input.preferences ?? {}) as Record<string, unknown>;
    for (const key of VALID_KEYS) {
      const value = incoming[key];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') {
        return err(
          new Validation(
            `Notification preference "${key}" must be a boolean.`,
          ),
        );
      }
      patch[key] = value;
    }

    if (Object.keys(patch).length === 0) {
      return err(
        new Validation('No valid notification preferences provided.'),
      );
    }

    const existing = await userRepo.findById(input.userId);
    if (!existing) {
      return err(new NotFound('User not found.'));
    }

    const user = await userRepo.update(input.userId, {
      notificationPreferences: patch,
    });
    return ok({
      user,
      notificationPreferences: user.notificationPreferences,
    });
  }
}
