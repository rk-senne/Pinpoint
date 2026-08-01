import { describe, it, expect } from 'vitest';
import { generateCodeVerifier, generateCodeChallenge } from '../src/pkce.js';

describe('PKCE helpers', () => {
  it('generateCodeVerifier returns string of correct length', () => {
    const v = generateCodeVerifier();
    expect(v.length).toBe(64);
    expect(/^[A-Za-z0-9\-._~]+$/.test(v)).toBe(true);
  });

  it('generateCodeVerifier respects custom length', () => {
    const v = generateCodeVerifier(43);
    expect(v.length).toBe(43);
  });

  it('generateCodeChallenge produces valid S256 hash', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await generateCodeChallenge(verifier);
    // Known test vector from RFC 7636 Appendix B
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('different verifiers produce different challenges', async () => {
    const v1 = generateCodeVerifier();
    const v2 = generateCodeVerifier();
    const c1 = await generateCodeChallenge(v1);
    const c2 = await generateCodeChallenge(v2);
    expect(c1).not.toBe(c2);
  });
});
