import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { SecretBox, deriveKey, isEncrypted } from './secretBox.js';

const hexKey = 'a'.repeat(64);
const base64Key = Buffer.alloc(32, 9).toString('base64');

describe('deriveKey', () => {
  it('accepts a 64-char hex key', () => {
    expect(deriveKey(hexKey)).toHaveLength(32);
  });

  it('accepts a base64 key decoding to 32 bytes', () => {
    expect(deriveKey(base64Key)).toHaveLength(32);
  });

  it('accepts url-safe base64', () => {
    const urlSafe = Buffer.alloc(32, 250).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    expect(deriveKey(urlSafe)).toHaveLength(32);
  });

  it('rejects empty key', () => {
    expect(() => deriveKey('')).toThrow();
    expect(() => deriveKey('   ')).toThrow();
  });

  it('rejects a key of the wrong length', () => {
    expect(() => deriveKey('tooshort')).toThrow();
    expect(() => deriveKey(Buffer.alloc(16).toString('base64'))).toThrow();
  });
});

describe('SecretBox', () => {
  const box = SecretBox.fromRawKey(hexKey);

  it('round-trips plaintext through encrypt/decrypt', () => {
    const secret = 'ya29.super-secret-oauth-token';
    const envelope = box.encrypt(secret);
    expect(envelope).not.toContain(secret);
    expect(isEncrypted(envelope)).toBe(true);
    expect(box.decrypt(envelope)).toBe(secret);
  });

  it('produces a fresh IV per encryption (non-deterministic ciphertext)', () => {
    const a = box.encrypt('same');
    const b = box.encrypt('same');
    expect(a).not.toBe(b);
    expect(box.decrypt(a)).toBe('same');
    expect(box.decrypt(b)).toBe('same');
  });

  it('round-trips unicode', () => {
    const secret = '🔐 клиентский секрет — café';
    expect(box.decrypt(box.encrypt(secret))).toBe(secret);
  });

  it('rejects a tampered ciphertext (auth tag mismatch)', () => {
    const envelope = box.encrypt('tamper-me');
    const parts = envelope.split('.');
    const ct = Buffer.from(parts[2], 'base64');
    ct[0] ^= 0xff;
    parts[2] = ct.toString('base64');
    expect(() => box.decrypt(parts.join('.'))).toThrow();
  });

  // Semgrep gcm-no-tag-length: without `authTagLength` Node accepts a
  // truncated tag (e.g. 4 bytes), which makes GCM forgeries ~2^32 guesses.
  it('rejects a truncated auth tag (authTagLength is pinned to 16)', () => {
    const envelope = box.encrypt('truncate-me');
    const parts = envelope.split('.');
    parts[3] = Buffer.from(parts[3], 'base64').subarray(0, 4).toString('base64');
    expect(() => box.decrypt(parts.join('.'))).toThrow();
  });

  it('cannot decrypt with a different key', () => {
    const envelope = box.encrypt('cross-key');
    const other = SecretBox.fromRawKey(crypto.randomBytes(32).toString('hex'));
    expect(() => other.decrypt(envelope)).toThrow();
  });

  it('decrypt rejects non-envelope input', () => {
    expect(() => box.decrypt('plaintext-not-encrypted')).toThrow();
  });

  it('decryptMaybe passes through plaintext and null/undefined', () => {
    expect(box.decryptMaybe('plain')).toBe('plain');
    expect(box.decryptMaybe(null)).toBeNull();
    expect(box.decryptMaybe(undefined)).toBeUndefined();
    const env = box.encrypt('x');
    expect(box.decryptMaybe(env)).toBe('x');
  });

  it('encryptMaybe passes through empty/null/undefined', () => {
    expect(box.encryptMaybe('')).toBe('');
    expect(box.encryptMaybe(null)).toBeNull();
    expect(box.encryptMaybe(undefined)).toBeUndefined();
    expect(isEncrypted(box.encryptMaybe('v') as string)).toBe(true);
  });

  it('rejects construction with a non-32-byte key', () => {
    expect(() => new SecretBox(Buffer.alloc(16))).toThrow();
  });
});

describe('isEncrypted', () => {
  it('detects the v1 envelope prefix', () => {
    expect(isEncrypted('v1.a.b.c')).toBe(true);
    expect(isEncrypted('plaintext')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
  });
});
