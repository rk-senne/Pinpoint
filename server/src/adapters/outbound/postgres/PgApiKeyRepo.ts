import type { Knex } from 'knex';
import type { ApiKey, ApiKeyRepo, NewApiKey } from '../../../domain/org/ports/ApiKeyRepo.js';

export class PgApiKeyRepo implements ApiKeyRepo {
  constructor(private readonly db: Knex) {}

  async insert(input: NewApiKey): Promise<ApiKey> {
    const [row] = await this.db('api_keys').insert({
      org_id: input.orgId,
      name: input.name,
      key_hash: input.keyHash,
      key_prefix: input.keyPrefix,
      scopes: input.scopes,
      created_by: input.createdBy,
    }).returning('*');
    return this.map(row);
  }

  async findByHash(keyHash: string): Promise<ApiKey | null> {
    const row = await this.db('api_keys').where({ key_hash: keyHash }).whereNull('revoked_at').first();
    return row ? this.map(row) : null;
  }

  async listByOrg(orgId: string): Promise<ApiKey[]> {
    const rows = await this.db('api_keys').where({ org_id: orgId }).orderBy('created_at', 'desc');
    return rows.map((r: any) => this.map(r));
  }

  async revoke(id: string): Promise<void> {
    await this.db('api_keys').where({ id }).update({ revoked_at: this.db.fn.now() });
  }

  async updateLastUsed(id: string): Promise<void> {
    await this.db('api_keys').where({ id }).update({ last_used_at: this.db.fn.now() });
  }

  private map(row: any): ApiKey {
    return {
      id: row.id,
      orgId: row.org_id,
      name: row.name,
      keyPrefix: row.key_prefix,
      scopes: row.scopes,
      createdBy: row.created_by,
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }
}
