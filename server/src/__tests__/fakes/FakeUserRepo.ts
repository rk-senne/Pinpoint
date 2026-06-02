// FakeUserRepo — in-memory UserRepo fake (Phase 1.5 / task 4.11.1).
//
// Mirrors PgUserRepo's surface: tracks a `User` plus its sibling secrets
// (`passwordHash`, `verified`) per row so `findByEmailWithSecret` /
// `findByIdWithSecret` return the same projection production does.

import { randomUUID } from 'node:crypto';

import type {
  NewUser,
  NotificationPreferences,
  User,
  UserPatch,
} from '../../domain/user/User.js';
import type {
  UserRepo,
  UserWithSecret,
} from '../../domain/user/ports/UserRepo.js';
import type { Clock } from '../../domain/shared/ports/Clock.js';

const DEFAULT_PREFERENCES: NotificationPreferences = {
  newAnnotation: true,
  newComment: true,
  promotedToOwner: true,
  projectDeleted: true,
};

interface StoredUser extends User {
  passwordHash: string;
  verified: boolean;
  tokenVersion: number;
}

export class FakeUserRepo implements UserRepo {
  /** Public for direct inspection in tests. */
  readonly users = new Map<string, StoredUser>();

  constructor(private readonly clock: Clock) {}

  async insert(input: NewUser): Promise<User> {
    const id = randomUUID();
    const stored: StoredUser = {
      id,
      email: input.email.toLowerCase(),
      name: input.name,
      notificationPreferences: { ...DEFAULT_PREFERENCES },
      createdAt: this.clock.now().toISOString(),
      passwordHash: input.passwordHash,
      verified: input.verified ?? false,
      tokenVersion: 0,
    };
    this.users.set(id, stored);
    return this.toUser(stored);
  }

  async findById(id: string): Promise<User | null> {
    const row = this.users.get(id);
    return row ? this.toUser(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = this.findByEmailRaw(email);
    return row ? this.toUser(row) : null;
  }

  async findByEmailWithSecret(email: string): Promise<UserWithSecret | null> {
    const row = this.findByEmailRaw(email);
    return row ? this.toUserWithSecret(row) : null;
  }

  async findByIdWithSecret(id: string): Promise<UserWithSecret | null> {
    const row = this.users.get(id);
    return row ? this.toUserWithSecret(row) : null;
  }

  async update(id: string, patch: UserPatch): Promise<User> {
    const row = this.users.get(id);
    if (!row) throw new Error(`FakeUserRepo.update: user ${id} not found`);

    const next: StoredUser = { ...row };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.email !== undefined) next.email = patch.email.toLowerCase();
    if (patch.avatarUrl !== undefined) {
      if (patch.avatarUrl === null) {
        delete next.avatarUrl;
      } else {
        next.avatarUrl = patch.avatarUrl;
      }
    }
    if (patch.passwordHash !== undefined) next.passwordHash = patch.passwordHash;
    if (patch.verified !== undefined) next.verified = patch.verified;
    if (patch.notificationPreferences !== undefined) {
      next.notificationPreferences = {
        ...row.notificationPreferences,
        ...patch.notificationPreferences,
      };
    }
    this.users.set(id, next);
    return this.toUser(next);
  }

  async markVerified(id: string): Promise<void> {
    const row = this.users.get(id);
    if (!row) return;
    this.users.set(id, { ...row, verified: true });
  }

  async incrementTokenVersion(id: string): Promise<void> {
    const row = this.users.get(id);
    if (!row) return;
    this.users.set(id, { ...row, tokenVersion: row.tokenVersion + 1 });
  }

  private findByEmailRaw(email: string): StoredUser | null {
    const normalized = email.toLowerCase();
    for (const row of this.users.values()) {
      if (row.email === normalized) return row;
    }
    return null;
  }

  private toUser(row: StoredUser): User {
    const user: User = {
      id: row.id,
      email: row.email,
      name: row.name,
      notificationPreferences: { ...row.notificationPreferences },
      createdAt: row.createdAt,
    };
    if (row.avatarUrl) user.avatarUrl = row.avatarUrl;
    return user;
  }

  private toUserWithSecret(row: StoredUser): UserWithSecret {
    return {
      ...this.toUser(row),
      passwordHash: row.passwordHash,
      verified: row.verified,
    };
  }
}
