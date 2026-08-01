import type { Knex } from 'knex';
import type { OAuthAccount, OAuthAccountRepo } from '../../../domain/auth/usecases/oauthLogin.js';

export class PgOAuthAccountRepo implements OAuthAccountRepo {
  constructor(private readonly db: Knex) {}

  async findByProviderAndId(provider: string, providerUserId: string): Promise<OAuthAccount | null> {
    const row = await this.db('oauth_accounts')
      .where({ provider, provider_user_id: providerUserId })
      .first();
    if (!row) return null;
    return this.mapRow(row);
  }

  async insert(input: { userId: string; provider: string; providerUserId: string; email?: string }): Promise<OAuthAccount> {
    const [row] = await this.db('oauth_accounts')
      .insert({
        user_id: input.userId,
        provider: input.provider,
        provider_user_id: input.providerUserId,
        email: input.email ?? null,
      })
      .returning('*');
    return this.mapRow(row);
  }

  private mapRow(row: any): OAuthAccount {
    return {
      id: row.id,
      userId: row.user_id,
      provider: row.provider,
      providerUserId: row.provider_user_id,
      email: row.email ?? undefined,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }
}
