// Unit tests for the refreshToken use case (Phase 1.5 / task 4.11.2).
//
// Exercises the sliding-window grace check by signing a token, advancing
// the clock past `exp` but inside / outside the grace window, and
// asserting on the result.

import { describe, it, expect } from 'vitest';

import { FakeClock, FakeMembershipRepo, FakeTokenIssuer, FakeUserRepo } from '../../../__tests__/fakes/index.js';
import { RefreshToken } from '../usecases/refreshToken.js';

const ACCESS_TTL_SECONDS = 60 * 60; // 1h
const GRACE_WINDOW_SECONDS = 7 * 24 * 60 * 60; // 7d

function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const tokenIssuer = new FakeTokenIssuer(clock, {
    accessTtlSeconds: ACCESS_TTL_SECONDS,
    graceWindowSeconds: GRACE_WINDOW_SECONDS,
  });
  const usecase = new RefreshToken({ tokenIssuer, clock });
  return { usecase, clock, tokenIssuer };
}

describe('refreshToken absolute session lifetime (PP-15)', () => {
  it('refuses to refresh once the session is older than maxSessionSeconds, even if each token was fresh', async () => {
    const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
    const tokenIssuer = new FakeTokenIssuer(clock, {
      accessTtlSeconds: ACCESS_TTL_SECONDS,
      graceWindowSeconds: GRACE_WINDOW_SECONDS,
      maxSessionSeconds: 3 * 24 * 60 * 60,
    });
    const usecase = new RefreshToken({ tokenIssuer, clock });
    let token = tokenIssuer.sign({ userId: 'u', email: 'a@b.c', orgId: 'o', role: 'owner', tokenVersion: 0 });
    // Refresh daily: every individual token is inside its grace window.
    for (let day = 1; day <= 3; day++) {
      clock.advance(24 * 60 * 60 * 1000 - 1000);
      const r = await usecase.execute({ token });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      token = r.value.token;
    }
    clock.advance(2 * 60 * 60 * 1000);
    expect((await usecase.execute({ token })).ok).toBe(false);
  });
});

describe('refreshToken use case', () => {
  it('mints a fresh token when the supplied one is still valid', async () => {
    const { usecase, tokenIssuer } = buildSut();
    const token = tokenIssuer.sign({
      userId: 'user-1',
      email: 'alice@example.com',
      orgId: 'org-1',
      role: 'owner',
      tokenVersion: 0,
    });

    const result = await usecase.execute({ token });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.token).toBeTypeOf('string');
    expect(result.value.csrfToken).toBeTypeOf('string');
  });

  it('mints a fresh token for a token expired but inside the grace window', async () => {
    const { usecase, clock, tokenIssuer } = buildSut();
    const token = tokenIssuer.sign({
      userId: 'user-1',
      email: 'alice@example.com',
      orgId: 'org-1',
      role: 'owner',
      tokenVersion: 0,
    });

    // Advance past `exp` but well inside the 7-day grace window.
    clock.advance((ACCESS_TTL_SECONDS + 60) * 1000);

    const result = await usecase.execute({ token });

    expect(result.ok).toBe(true);
  });

  it('returns Unauthorized when the token is past the grace window', async () => {
    const { usecase, clock, tokenIssuer } = buildSut();
    const token = tokenIssuer.sign({
      userId: 'user-1',
      email: 'alice@example.com',
      orgId: 'org-1',
      role: 'owner',
      tokenVersion: 0,
    });

    clock.advance((ACCESS_TTL_SECONDS + GRACE_WINDOW_SECONDS + 60) * 1000);

    const result = await usecase.execute({ token });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Unauthorized');
  });

  it('returns Unauthorized for a malformed token', async () => {
    const { usecase } = buildSut();

    const result = await usecase.execute({ token: 'not-a-valid-token' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Unauthorized');
  });

  describe('account re-validation (F-06)', () => {
    async function buildValidating() {
      const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
      const tokenIssuer = new FakeTokenIssuer(clock, {
        accessTtlSeconds: ACCESS_TTL_SECONDS,
        graceWindowSeconds: GRACE_WINDOW_SECONDS,
      });
      const userRepo = new FakeUserRepo(clock);
      const membershipRepo = new FakeMembershipRepo();
      const user = await userRepo.insert({ email: 'alice@example.com', name: 'Alice', passwordHash: 'x', verified: true });
      membershipRepo.seed({ orgId: 'org-1', userId: user.id, role: 'member' });
      const usecase = new RefreshToken({ tokenIssuer, clock, userRepo, membershipRepo });
      const sign = (over: Partial<{ role: string; tokenVersion: number; userId: string }> = {}) =>
        tokenIssuer.sign({ userId: user.id, email: user.email, orgId: 'org-1', role: 'owner', tokenVersion: 0, ...over });
      return { usecase, userRepo, membershipRepo, tokenIssuer, user, sign };
    }

    it('re-signs with the CURRENT membership role, not the claim in the old token', async () => {
      const { usecase, tokenIssuer, sign } = await buildValidating();
      const result = await usecase.execute({ token: sign({ role: 'owner' }) });
      expect(result.ok).toBe(true);
      if (result.ok) expect(tokenIssuer.verify(result.value.token).role).toBe('member');
    });

    it('rejects a token whose tokenVersion is lower than the account\'s', async () => {
      const { usecase, userRepo, user, sign } = await buildValidating();
      await userRepo.incrementTokenVersion(user.id);
      expect((await usecase.execute({ token: sign({ tokenVersion: 0 }) })).ok).toBe(false);
      expect((await usecase.execute({ token: sign({ tokenVersion: 1 }) })).ok).toBe(true);
    });

    it('rejects when the user was removed from the org', async () => {
      const { usecase, membershipRepo, user, sign } = await buildValidating();
      await membershipRepo.removeByOrgAndUser('org-1', user.id);
      const result = await usecase.execute({ token: sign() });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('Unauthorized');
    });

    it('rejects when the user no longer exists', async () => {
      const { usecase, userRepo, user, sign } = await buildValidating();
      userRepo.users.delete(user.id);
      expect((await usecase.execute({ token: sign() })).ok).toBe(false);
    });
  });
});
