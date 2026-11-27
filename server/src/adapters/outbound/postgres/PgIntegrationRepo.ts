import type { Knex } from 'knex';
import type { Integration, IntegrationRepo } from '../../../domain/integration/ports/IntegrationRepo.js';
import type { SecretBox } from '../../../services/secretBox.js';

/**
 * Postgres adapter for integrations.
 *
 * Mission A4: `access_token`, `refresh_token`, and `config.clientSecret` are
 * sensitive bearer credentials. When a `SecretBox` is provided they are stored
 * AES-256-GCM-encrypted at rest and decrypted on read. The box is optional so
 * the adapter still functions (pass-through) in environments without a key —
 * decryption tolerates legacy plaintext rows via `decryptMaybe`.
 */
export class PgIntegrationRepo implements IntegrationRepo {
  constructor(
    private readonly db: Knex,
    private readonly secretBox?: SecretBox,
  ) {}

  async findByOrgAndProvider(orgId: string, provider: string): Promise<Integration | null> {
    const row = await this.db('integrations').where({ org_id: orgId, provider }).first();
    return row ? this.map(row) : null;
  }

  async listByOrg(orgId: string): Promise<Integration[]> {
    const rows = await this.db('integrations').where({ org_id: orgId }).orderBy('created_at', 'desc');
    return rows.map((r: any) => this.map(r));
  }

  async upsert(orgId: string, provider: string, data: Partial<Integration>): Promise<Integration> {
    const config = { ...(data.config ?? {}) };
    // Encrypt the nested clientSecret before persisting config JSON.
    if (this.secretBox && typeof config.clientSecret === 'string' && config.clientSecret) {
      config.clientSecret = this.secretBox.encrypt(config.clientSecret);
    }

    const insert: Record<string, unknown> = {
      org_id: orgId,
      provider,
      access_token: this.encryptField(data.accessToken ?? ''),
      refresh_token: data.refreshToken ? this.encryptField(data.refreshToken) : null,
      token_expires_at: data.tokenExpiresAt ?? null,
      config: JSON.stringify(config),
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

  /** Encrypt a non-empty value when a box is configured; else store raw. */
  private encryptField(value: string): string {
    if (!value) return value;
    return this.secretBox ? this.secretBox.encrypt(value) : value;
  }

  /** Decrypt an encrypted value; tolerate legacy plaintext. */
  private decryptField(value: string | null | undefined): string | undefined {
    if (value === null || value === undefined) return undefined;
    if (!this.secretBox) return value;
    const out = this.secretBox.decryptMaybe(value);
    return out ?? undefined;
  }

  private map(row: any): Integration {
    const config = typeof row.config === 'string' ? JSON.parse(row.config) : (row.config ?? {});
    // Decrypt nested clientSecret on read.
    if (this.secretBox && typeof config.clientSecret === 'string') {
      config.clientSecret = this.secretBox.decryptMaybe(config.clientSecret);
    }

    return {
      id: row.id,
      orgId: row.org_id,
      provider: row.provider,
      accessToken: this.decryptField(row.access_token) ?? '',
      refreshToken: this.decryptField(row.refresh_token),
      tokenExpiresAt: row.token_expires_at
        ? (row.token_expires_at instanceof Date ? row.token_expires_at.toISOString() : row.token_expires_at)
        : undefined,
      config,
      enabled: row.enabled,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }
}
