// Postgres adapter for UserRepo (Phase 1.5 / task 4.8.1).

import type { Knex } from 'knex';
import type { NewUser, User, UserPatch } from '../../../domain/user/User.js';
import type { UserRepo, UserWithSecret } from '../../../domain/user/ports/UserRepo.js';

interface BaseUserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  notification_preferences: User['notificationPreferences'] | string;
  created_at: Date | string;
}

interface UserRow extends BaseUserRow {
  password_hash: string;
  verified: boolean;
}

const BASE_COLUMNS = [
  'id',
  'email',
  'name',
  'avatar_url',
  'notification_preferences',
  'created_at',
] as const;

const SECRET_COLUMNS = [
  'id',
  'email',
  'name',
  'avatar_url',
  'password_hash',
  'notification_preferences',
  'verified',
  'created_at',
] as const;

export class PgUserRepo implements UserRepo {
  constructor(private readonly db: Knex) {}

  async insert(input: NewUser): Promise<User> {
    const row: Record<string, unknown> = {
      email: input.email.toLowerCase(),
      name: input.name,
      password_hash: input.passwordHash || null,
      verified: input.verified ?? false,
    };

    const [created] = await this.db<BaseUserRow>('users')
      .insert(row)
      .returning([...BASE_COLUMNS]);
    return this.mapRow(created);
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.db<BaseUserRow>('users')
      .select([...BASE_COLUMNS])
      .where({ id })
      .first();
    return row ? this.mapRow(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.db<BaseUserRow>('users')
      .select([...BASE_COLUMNS])
      .where({ email: email.toLowerCase() })
      .first();
    return row ? this.mapRow(row) : null;
  }

  async findByEmailWithSecret(email: string): Promise<UserWithSecret | null> {
    const row = await this.db<UserRow>('users')
      .select([...SECRET_COLUMNS])
      .where({ email: email.toLowerCase() })
      .first();
    return row ? this.mapRowWithSecret(row) : null;
  }

  async findByIdWithSecret(id: string): Promise<UserWithSecret | null> {
    const row = await this.db<UserRow>('users')
      .select([...SECRET_COLUMNS])
      .where({ id })
      .first();
    return row ? this.mapRowWithSecret(row) : null;
  }

  async update(id: string, patch: UserPatch): Promise<User> {
    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.email !== undefined) updates.email = patch.email.toLowerCase();
    if (patch.avatarUrl !== undefined) updates.avatar_url = patch.avatarUrl;
    if (patch.passwordHash !== undefined) updates.password_hash = patch.passwordHash;
    if (patch.verified !== undefined) updates.verified = patch.verified;
    if (patch.notificationPreferences !== undefined) {
      // Merge with the current preferences so callers can pass partial updates.
      const current = await this.db<UserRow>('users')
        .select('notification_preferences')
        .where({ id })
        .first();
      const merged = {
        ...(parsePrefs(current?.notification_preferences) ?? {}),
        ...patch.notificationPreferences,
      };
      updates.notification_preferences = JSON.stringify(merged);
    }

    const [updated] = await this.db<BaseUserRow>('users')
      .where({ id })
      .update(updates)
      .returning([...BASE_COLUMNS]);
    return this.mapRow(updated);
  }

  async markVerified(id: string): Promise<void> {
    await this.db('users').where({ id }).update({ verified: true });
  }

  async incrementTokenVersion(id: string): Promise<void> {
    await this.db('users').where({ id }).increment('token_version', 1);
  }

  private mapRow(row: BaseUserRow): User {
    const user: User = {
      id: row.id,
      email: row.email,
      name: row.name,
      notificationPreferences: parsePrefs(row.notification_preferences) ?? {
        newAnnotation: true,
        newComment: true,
        promotedToOwner: true,
        projectDeleted: true,
      },
      createdAt: toIso(row.created_at),
    };
    if (row.avatar_url) user.avatarUrl = row.avatar_url;
    return user;
  }

  private mapRowWithSecret(row: UserRow): UserWithSecret {
    return {
      ...this.mapRow(row),
      passwordHash: row.password_hash,
      verified: row.verified,
    };
  }
}

function parsePrefs(
  raw: User['notificationPreferences'] | string | undefined | null,
): User['notificationPreferences'] | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as User['notificationPreferences'];
    } catch {
      return null;
    }
  }
  return raw;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
