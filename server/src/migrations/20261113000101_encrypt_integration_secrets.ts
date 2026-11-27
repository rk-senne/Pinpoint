import type { Knex } from 'knex';
import crypto from 'node:crypto';

/**
 * Mission A4 — encrypt existing integration secrets at rest.
 *
 * Earlier rows stored `access_token`, `refresh_token`, and
 * `config.clientSecret` as plaintext. This migration wraps any plaintext value
 * in the AES-256-GCM envelope using the configured `INTEGRATION_ENCRYPTION_KEY`
 * (falling back to the same derived dev key as `loadConfigFromEnv`). It is
 * idempotent: values already in the `v1.` envelope are left untouched, so a
 * re-run never double-encrypts.
 *
 * Self-contained by design: migrations run via ts-node (CommonJS), which can't
 * resolve the app's NodeNext `.js` import specifiers, and a migration must stay
 * frozen even if `services/secretBox.ts` evolves. The envelope below is
 * byte-compatible with `SecretBox` (`v1.<iv>.<ciphertext>.<authTag>`, base64,
 * 12-byte IV) — `secretBox.test.ts` + the migration round-trip check cover it.
 */

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'v1.';

function resolveKey(): Buffer {
  const raw = (
    process.env.INTEGRATION_ENCRYPTION_KEY ||
    Buffer.from('pinpoint-dev-integration-key-0001').subarray(0, 32).toString('base64')
  ).trim();
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (key.length !== 32) {
    throw new Error('INTEGRATION_ENCRYPTION_KEY must decode to 32 bytes (base64 or 64-char hex)');
  }
  return key;
}

function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), ct.toString('base64'), cipher.getAuthTag().toString('base64')].join('.');
}

function decrypt(key: Buffer, envelope: string): string {
  const [, iv, ct, tag] = envelope.split('.');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

const box = {
  encrypt: (v: string) => encrypt(resolveKey(), v),
  decrypt: (v: string) => decrypt(resolveKey(), v),
};

export async function up(knex: Knex): Promise<void> {
  const rows = await knex('integrations').select(
    'id',
    'access_token',
    'refresh_token',
    'config',
  );

  for (const row of rows) {
    const update: Record<string, unknown> = {};

    if (typeof row.access_token === 'string' && row.access_token && !isEncrypted(row.access_token)) {
      update.access_token = box.encrypt(row.access_token);
    }
    if (typeof row.refresh_token === 'string' && row.refresh_token && !isEncrypted(row.refresh_token)) {
      update.refresh_token = box.encrypt(row.refresh_token);
    }

    const config = typeof row.config === 'string' ? JSON.parse(row.config) : (row.config ?? {});
    if (typeof config.clientSecret === 'string' && config.clientSecret && !isEncrypted(config.clientSecret)) {
      config.clientSecret = box.encrypt(config.clientSecret);
      update.config = JSON.stringify(config);
    }

    if (Object.keys(update).length > 0) {
      await knex('integrations').where({ id: row.id }).update(update);
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  const rows = await knex('integrations').select(
    'id',
    'access_token',
    'refresh_token',
    'config',
  );

  for (const row of rows) {
    const update: Record<string, unknown> = {};

    if (typeof row.access_token === 'string' && isEncrypted(row.access_token)) {
      update.access_token = box.decrypt(row.access_token);
    }
    if (typeof row.refresh_token === 'string' && isEncrypted(row.refresh_token)) {
      update.refresh_token = box.decrypt(row.refresh_token);
    }

    const config = typeof row.config === 'string' ? JSON.parse(row.config) : (row.config ?? {});
    if (typeof config.clientSecret === 'string' && isEncrypted(config.clientSecret)) {
      config.clientSecret = box.decrypt(config.clientSecret);
      update.config = JSON.stringify(config);
    }

    if (Object.keys(update).length > 0) {
      await knex('integrations').where({ id: row.id }).update(update);
    }
  }
}
