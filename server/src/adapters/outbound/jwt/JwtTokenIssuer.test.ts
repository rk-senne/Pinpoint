// PP-15: algorithm pinning and sessionStart propagation.
import jwt from 'jsonwebtoken';
import { describe, it, expect } from 'vitest';
import { JwtTokenIssuer } from './JwtTokenIssuer.js';

const secret = 'unit-test-secret-with-enough-entropy-0123456789';
const claims = { userId: 'u', email: 'a@b.c', orgId: 'o', role: 'owner', tokenVersion: 1 };

describe('JwtTokenIssuer', () => {
  const issuer = new JwtTokenIssuer({ secret, accessTtl: '1h' });

  it('signs HS256 and carries sessionStart', () => {
    const t = issuer.sign(claims);
    expect(jwt.decode(t, { complete: true })!.header.alg).toBe('HS256');
    expect(issuer.verify(t).sessionStart).toBeTypeOf('number');
    expect(issuer.verify(issuer.sign({ ...claims, sessionStart: 1000 })).sessionStart).toBe(1000);
  });

  it('rejects other algorithms even with the right secret, and alg=none', () => {
    const hs512 = jwt.sign(claims, secret, { algorithm: 'HS512', expiresIn: '1h' });
    expect(() => issuer.verify(hs512)).toThrow();
    expect(() => issuer.decodeIgnoreExpiration(hs512)).toThrow();
    const none = jwt.sign(claims, '', { algorithm: 'none' } as never);
    expect(() => issuer.verify(none)).toThrow();
  });
});
