import { describe, it, expect } from 'vitest';
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUri, totpAt, verifyTotp } from './totp.js';

// RFC 6238 Appendix B (SHA-1, secret "12345678901234567890"), 8 digits there; we compare the last 6.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const RFC_VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(RFC_VECTORS)('matches the RFC 6238 test vector at t=%i', (t, eight) => {
    expect(hotp(base32Decode(RFC_SECRET), Math.floor(t / 30), 8)).toBe(eight);
    expect(totpAt(RFC_SECRET, t * 1000)).toBe(eight.slice(-6));
  });

  it('base32 round-trips arbitrary bytes', () => {
    for (let n = 1; n < 40; n++) {
      const b = Buffer.alloc(n, n * 7);
      expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    }
    expect(() => base32Decode('not*base32')).toThrow();
  });

  it('generates distinct 160-bit secrets', () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(a);
  });

  it('verifies the current code and ±1 step, returns the matched step, rejects ±2', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30000);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 30000), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now + 30000), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 90000), now)).toBeNull();
  });

  it('rejects malformed codes without throwing', () => {
    for (const c of ['', '12345', '1234567', 'abcdef', '12 456', '１２３４５６']) {
      expect(verifyTotp(RFC_SECRET, c, 1_700_000_000_000)).toBeNull();
    }
  });

  it('builds a provisioning URI', () => {
    const u = new URL(otpauthUri({ secret: 'ABC', account: 'a+b@example.com', issuer: 'Pinpoint' }));
    expect(u.protocol).toBe('otpauth:');
    expect(u.searchParams.get('secret')).toBe('ABC');
    expect(u.searchParams.get('issuer')).toBe('Pinpoint');
    expect(u.searchParams.get('digits')).toBe('6');
    expect(decodeURIComponent(u.pathname)).toContain('a+b@example.com');
  });
});
