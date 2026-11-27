import { describe, it, expect } from 'vitest';
import {
  WHSEC_PREFIX,
  generateSecret,
  isWhsecSecret,
  secretKeyBytes,
  computeSignature,
  buildSignatureHeaders,
  verifySignature,
} from './standardWebhooks.js';

describe('standardWebhooks', () => {
  describe('generateSecret', () => {
    it('mints a whsec_-prefixed base64 secret decoding to 32 bytes', () => {
      const s = generateSecret();
      expect(s.startsWith(WHSEC_PREFIX)).toBe(true);
      expect(isWhsecSecret(s)).toBe(true);
      expect(secretKeyBytes(s)).toHaveLength(32);
    });

    it('is random per call', () => {
      expect(generateSecret()).not.toBe(generateSecret());
    });
  });

  describe('secretKeyBytes', () => {
    it('base64-decodes whsec_ secrets', () => {
      const raw = Buffer.alloc(32, 5);
      const secret = WHSEC_PREFIX + raw.toString('base64');
      expect(secretKeyBytes(secret).equals(raw)).toBe(true);
    });

    it('uses raw utf8 bytes for legacy (unprefixed) secrets', () => {
      const legacy = 'a'.repeat(64);
      expect(secretKeyBytes(legacy).equals(Buffer.from(legacy, 'utf8'))).toBe(true);
    });
  });

  describe('computeSignature', () => {
    it('signs `${msgId}.${ts}.${body}` deterministically', () => {
      const secret = generateSecret();
      const a = computeSignature(secret, 'msg_1', 1700000000, '{"x":1}');
      const b = computeSignature(secret, 'msg_1', 1700000000, '{"x":1}');
      expect(a).toBe(b);
    });

    it('differs when any signed component changes', () => {
      const secret = generateSecret();
      const base = computeSignature(secret, 'msg_1', 1700000000, 'body');
      expect(computeSignature(secret, 'msg_2', 1700000000, 'body')).not.toBe(base);
      expect(computeSignature(secret, 'msg_1', 1700000001, 'body')).not.toBe(base);
      expect(computeSignature(secret, 'msg_1', 1700000000, 'body2')).not.toBe(base);
    });
  });

  describe('buildSignatureHeaders', () => {
    it('emits the three standard-webhooks headers', () => {
      const secret = generateSecret();
      const h = buildSignatureHeaders(secret, 'msg_42', '{}', 1700000000);
      expect(h['webhook-id']).toBe('msg_42');
      expect(h['webhook-timestamp']).toBe('1700000000');
      expect(h['webhook-signature']).toMatch(/^v1,/);
    });

    it('defaults the timestamp to now (seconds)', () => {
      const before = Math.floor(Date.now() / 1000);
      const h = buildSignatureHeaders(generateSecret(), 'm', '{}');
      const ts = Number(h['webhook-timestamp']);
      expect(ts).toBeGreaterThanOrEqual(before);
    });
  });

  describe('verifySignature', () => {
    it('verifies a header produced by buildSignatureHeaders', () => {
      const secret = generateSecret();
      const body = JSON.stringify({ event: 'annotation.created', data: {} });
      const h = buildSignatureHeaders(secret, 'msg_1', body, 1700000000);
      expect(verifySignature(secret, 'msg_1', 1700000000, body, h['webhook-signature'])).toBe(true);
    });

    it('rejects a tampered body', () => {
      const secret = generateSecret();
      const h = buildSignatureHeaders(secret, 'msg_1', 'body', 1700000000);
      expect(verifySignature(secret, 'msg_1', 1700000000, 'TAMPERED', h['webhook-signature'])).toBe(false);
    });

    it('verifies against multiple space-separated signatures', () => {
      const secret = generateSecret();
      const good = computeSignature(secret, 'm', 1700000000, 'b');
      const header = `v1,deadbeef v1,${good}`;
      expect(verifySignature(secret, 'm', 1700000000, 'b', header)).toBe(true);
    });

    it('round-trips legacy (unprefixed) secrets', () => {
      const legacy = 'f'.repeat(64);
      const h = buildSignatureHeaders(legacy, 'm', 'b', 1700000000);
      expect(verifySignature(legacy, 'm', 1700000000, 'b', h['webhook-signature'])).toBe(true);
    });
  });
});
