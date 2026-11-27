import type { Knex } from 'knex';
import crypto from 'node:crypto';

/**
 * PP-11 — encrypt existing webhook signing secrets at rest (same AES-256-GCM
 * envelope as the integration secrets; `PgWebhookRepo` now encrypts new rows and
 * reads legacy plaintext transparently). Idempotent: `v1.` values are skipped.
 * down() decrypts them back. Derived from migration 20261113000101 (see its
 * header for why the envelope code is duplicated here).
 *
 * Original header of that migration follows:
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
  // The ciphertext envelope is longer than the original varchar(64).
  await knex.raw('ALTER TABLE webhook_endpoints ALTER COLUMN secret TYPE text');
  const rows = await knex('webhook_endpoints').select('id', 'secret');
  for (const row of rows) {
    if (typeof row.secret === 'string' && row.secret && !isEncrypted(row.secret)) {
      await knex('webhook_endpoints').where({ id: row.id }).update({ secret: box.encrypt(row.secret) });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  const rows = await knex('webhook_endpoints').select('id', 'secret');
  for (const row of rows) {
    if (typeof row.secret === 'string' && isEncrypted(row.secret)) {
      await knex('webhook_endpoints').where({ id: row.id }).update({ secret: box.decrypt(row.secret) });
    }
  }
  await knex.raw('ALTER TABLE webhook_endpoints ALTER COLUMN secret TYPE varchar(64)');
}
