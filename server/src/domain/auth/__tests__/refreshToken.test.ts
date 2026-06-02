// Unit tests for the refreshToken use case (Phase 1.5 / task 4.11.2).
//
// Exercises the sliding-window grace check by signing a token, advancing
// the clock past `exp` but inside / outside the grace window, and
// asserting on the result.

import { describe, it, expect } from 'vitest';

import { FakeClock, FakeTokenIssuer } from '../../../__tests__/fakes/index.js';
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
});
