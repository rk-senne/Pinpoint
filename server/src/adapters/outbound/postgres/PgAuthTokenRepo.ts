// Postgres adapter for AuthTokenRepo (Phase 1.5 / task 4.8.1).
//
// Backs the `auth_tokens` table that replaced the legacy `password_resets`
// table. Discriminator column `kind` selects between `verify_email`,
// `reset_password`, and `team_invite` flows.

import type { Knex } from 'knex';
import type {
  AuthToken,
  AuthTokenKind,
  NewAuthToken,
} from '../../../domain/auth/AuthToken.js';
import type { AuthTokenRepo } from '../../../domain/auth/ports/AuthTokenRepo.js';

interface AuthTokenRow {
  id: string;
  user_id: string;
  kind: string;
  token_hash: string;
  expires_at: Date | string;
  used: boolean;
  created_at: Date | string;
}

export class PgAuthTokenRepo implements AuthTokenRepo {
  constructor(private readonly db: Knex) {}

  async insert(input: NewAuthToken): Promise<AuthToken> {
    const [created] = await this.db<AuthTokenRow>('auth_tokens')
      .insert({
        user_id: input.userId,
        kind: input.kind,
        token_hash: input.tokenHash,
        expires_at: input.expiresAt,
        used: false,
      })
      .returning('*');
    return this.mapRow(created);
  }

  async findValid(
    tokenHash: string,
    kind: AuthTokenKind,
    now: Date,
  ): Promise<AuthToken | null> {
    const row = await this.db<AuthTokenRow>('auth_tokens')
      .where({ token_hash: tokenHash, kind, used: false })
      .where('expires_at', '>', now)
      .first();
    return row ? this.mapRow(row) : null;
  }

  async markUsed(id: string): Promise<void> {
    await this.db('auth_tokens').where({ id }).update({ used: true });
  }

  async markAllUsedForUser(userId: string, kind: AuthTokenKind): Promise<void> {
    await this.db('auth_tokens')
      .where({ user_id: userId, kind, used: false })
      .update({ used: true });
  }

  private mapRow(row: AuthTokenRow): AuthToken {
    return {
      id: row.id,
      userId: row.user_id,
      kind: row.kind as AuthTokenKind,
      tokenHash: row.token_hash,
      expiresAt: toIso(row.expires_at),
      used: row.used,
      createdAt: toIso(row.created_at),
    };
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
