// Authenticated-encryption helper for secrets at rest (Mission A4).
//
// Integration OAuth tokens (`access_token` / `refresh_token`) and the
// `config.clientSecret` are long-lived bearer credentials. Storing them as
// plaintext means a single read of the `integrations` table — a leaked DB
// backup, a logged row, an errant `SELECT *` — hands an attacker standing
// access to the customer's Jira/Linear/GitHub tenant. We wrap them with
// AES-256-GCM (authenticated encryption) keyed by a dedicated
// `INTEGRATION_ENCRYPTION_KEY` so ciphertext is tamper-evident and useless
// without the key.
//
// Wire format (all base64, dot-separated, versioned):
//   v1.<iv>.<ciphertext>.<authTag>
// The `v1.` prefix lets `isEncrypted()` distinguish already-encrypted values
// from legacy plaintext during the migration window and lets us rotate the
// scheme later without ambiguity.

import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length
const VERSION = 'v1';
const PREFIX = `${VERSION}.`;

/**
 * Derive a 32-byte key from the configured `INTEGRATION_ENCRYPTION_KEY`.
 *
 * Accepts either:
 *  - base64 (standard or url-safe) decoding to exactly 32 bytes, or
 *  - hex decoding to exactly 32 bytes (64 hex chars).
 *
 * Any other length/format is rejected so a misconfigured key fails loudly at
 * boot rather than silently producing a weak/undersized key.
 */
export function deriveKey(raw: string): Buffer {
  if (!raw || raw.trim().length === 0) {
    throw new Error('INTEGRATION_ENCRYPTION_KEY is empty');
  }
  const value = raw.trim();

  // Try hex first when it looks like 64 hex chars.
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }

  // Fall back to base64 (accept url-safe variants).
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(normalized, 'base64');
  if (buf.length === KEY_BYTES) {
    return buf;
  }

  throw new Error(
    `INTEGRATION_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes ` +
      '(base64 or 64-char hex); got ' + buf.length + ' bytes after base64 decode',
  );
}

/**
 * True when `value` is in our versioned ciphertext envelope. Used to make
 * decrypt() tolerant of legacy plaintext rows written before A4 shipped and
 * to make the backfill migration idempotent.
 */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * A SecretBox bound to a single key. Construct once at composition time from
 * `deriveKey(config.integrationEncryptionKey)` and share it.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`SecretBox key must be ${KEY_BYTES} bytes, got ${key.length}`);
    }
    this.key = key;
  }

  static fromRawKey(raw: string): SecretBox {
    return new SecretBox(deriveKey(raw));
  }

  /** Encrypt UTF-8 plaintext into the versioned envelope. */
  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64'),
      ciphertext.toString('base64'),
      authTag.toString('base64'),
    ].join('.');
  }

  /**
   * Decrypt a versioned envelope back to UTF-8 plaintext. Throws on a tampered
   * or malformed value. Passing a non-encrypted (legacy plaintext) value is a
   * programming error here — callers use `decryptMaybe` for the tolerant path.
   */
  decrypt(envelope: string): string {
    if (!isEncrypted(envelope)) {
      throw new Error('SecretBox.decrypt: value is not an encrypted envelope');
    }
    const parts = envelope.split('.');
    if (parts.length !== 4) {
      throw new Error('SecretBox.decrypt: malformed envelope');
    }
    const [, ivB64, ctB64, tagB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const ciphertext = Buffer.from(ctB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }

  /**
   * Decrypt when encrypted, otherwise return the value unchanged. Lets repo
   * reads survive the migration window where some rows may still be plaintext.
   */
  decryptMaybe(value: string | null | undefined): string | null | undefined {
    if (value === null || value === undefined) return value;
    if (!isEncrypted(value)) return value;
    return this.decrypt(value);
  }

  /** Encrypt when non-empty; pass through null/undefined/'' untouched. */
  encryptMaybe(value: string | null | undefined): string | null | undefined {
    if (value === null || value === undefined || value === '') return value;
    return this.encrypt(value);
  }
}
