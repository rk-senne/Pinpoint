import { describe, it, expect } from 'vitest';
import { MfaService, generateRecoveryCode, MFA_CHALLENGE_TTL_MS } from './MfaService.js';

function svc(nowRef: { t: number }, secret = 'jwt-secret-for-tests-0123456789abcdef') {
  return new MfaService({
    mfaRepo: {} as never,
    userRepo: {} as never,
    passwordHasher: {} as never,
    clock: { now: () => new Date(nowRef.t) },
    challengeSecret: secret,
  });
}

describe('MfaService login challenge', () => {
  it('round-trips a user id and expires after 5 minutes', () => {
    const now = { t: 1_800_000_000_000 };
    const s = svc(now);
    const tok = s.createChallenge('user-1');
    expect(s.verifyChallenge(tok)).toBe('user-1');
    now.t += MFA_CHALLENGE_TTL_MS - 1;
    expect(s.verifyChallenge(tok)).toBe('user-1');
    now.t += 2;
    expect(s.verifyChallenge(tok)).toBeNull();
  });

  it('rejects tampering, other keys, wrong shapes and oversized input', () => {
    const now = { t: 1_800_000_000_000 };
    const s = svc(now);
    const tok = s.createChallenge('user-1');
    const [payload, sig] = tok.split('.') as [string, string];
    const evil = Buffer.from(JSON.stringify({ u: 'user-2', e: now.t + 60_000, p: 'mfa' })).toString('base64url');
    expect(s.verifyChallenge(`${evil}.${sig}`)).toBeNull();
    expect(s.verifyChallenge(`${payload}.${sig}.x`)).toBeNull();
    expect(svc(now, 'another-secret-another-secret-123456').verifyChallenge(tok)).toBeNull();
    for (const bad of [undefined, null, 5, '', 'a', 'a.b', 'x'.repeat(600)]) expect(s.verifyChallenge(bad)).toBeNull();
  });

  it('a session JWT / other-purpose payload is not accepted as a challenge', () => {
    const now = { t: 1_800_000_000_000 };
    const s = svc(now);
    expect(s.verifyChallenge('eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ1MSJ9.c2ln')).toBeNull();
  });
});

describe('recovery codes', () => {
  it('are 10 base32 chars (50 bits) formatted XXXXX-XXXXX and unique', () => {
    const set = new Set(Array.from({ length: 200 }, generateRecoveryCode));
    expect(set.size).toBe(200);
    for (const c of set) expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  });
});
