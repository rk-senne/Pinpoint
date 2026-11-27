import type { Knex } from 'knex';
import { runAsSystem } from '../../../infrastructure/tenantContext.js';
import type { ApiKey, ApiKeyRepo, ApiKeyType, NewApiKey } from '../../../domain/org/ports/ApiKeyRepo.js';

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
      key_type: input.keyType ?? 'standard',
      project_id: input.projectId ?? null,
      allowed_origins: input.allowedOrigins ?? [],
      daily_quota: input.dailyQuota ?? null,
    }).returning('*');
    return this.map(row);
  }

  async findByHash(keyHash: string): Promise<ApiKey | null> {
    // Pre-tenant lookup by secret hash: the org is unknown until the key resolves (RLS system scope).
    // (`await` INSIDE the scope: knex builders are lazy and run on first await.)
    const row = await runAsSystem(async () =>
      await this.db('api_keys').where({ key_hash: keyHash }).whereNull('revoked_at').first(),
    );
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
    await runAsSystem(async () => {
      await this.db('api_keys').where({ id }).update({ last_used_at: this.db.fn.now() });
    });
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
      keyType: (row.key_type ?? 'standard') as ApiKeyType,
      projectId: row.project_id ?? null,
      allowedOrigins: row.allowed_origins ?? [],
      dailyQuota: row.daily_quota ?? null,
    };
  }
}
