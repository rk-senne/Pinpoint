import type { Knex } from 'knex';
import type { Integration, IntegrationRepo } from '../../../domain/integration/ports/IntegrationRepo.js';

export class PgIntegrationRepo implements IntegrationRepo {
  constructor(private readonly db: Knex) {}

  async findByOrgAndProvider(orgId: string, provider: string): Promise<Integration | null> {
    const row = await this.db('integrations').where({ org_id: orgId, provider }).first();
    return row ? this.map(row) : null;
  }

  async listByOrg(orgId: string): Promise<Integration[]> {
    const rows = await this.db('integrations').where({ org_id: orgId }).orderBy('created_at', 'desc');
    return rows.map((r: any) => this.map(r));
  }

  async upsert(orgId: string, provider: string, data: Partial<Integration>): Promise<Integration> {
    const insert: Record<string, unknown> = {
      org_id: orgId,
      provider,
      access_token: data.accessToken ?? '',
      refresh_token: data.refreshToken ?? null,
      token_expires_at: data.tokenExpiresAt ?? null,
      config: JSON.stringify(data.config ?? {}),
      enabled: data.enabled ?? true,
    };
    const [row] = await this.db('integrations')
      .insert(insert)
      .onConflict(['org_id', 'provider'])
      .merge({
        access_token: insert.access_token,
        refresh_token: insert.refresh_token,
        token_expires_at: insert.token_expires_at,
        config: insert.config,
        enabled: insert.enabled,
        updated_at: this.db.fn.now(),
      })
      .returning('*');
    return this.map(row);
  }

  async delete(orgId: string, provider: string): Promise<boolean> {
    const count = await this.db('integrations').where({ org_id: orgId, provider }).del();
    return count > 0;
  }

  private map(row: any): Integration {
    return {
      id: row.id,
      orgId: row.org_id,
      provider: row.provider,
      accessToken: row.access_token,
      refreshToken: row.refresh_token ?? undefined,
      tokenExpiresAt: row.token_expires_at
        ? (row.token_expires_at instanceof Date ? row.token_expires_at.toISOString() : row.token_expires_at)
        : undefined,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : (row.config ?? {}),
      enabled: row.enabled,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }
}
