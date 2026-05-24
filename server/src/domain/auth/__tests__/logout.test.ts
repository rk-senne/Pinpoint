// Unit tests for the logout use case (Phase 1.5 / task 4.11.2).
//
// `logout` is intentionally a near-no-op today (sliding-window JWTs have
// no server-side session row), but it does invalidate any outstanding
// `verify_email` / `reset_password` tokens for the caller as
// belt-and-braces protection (see use case docstring). The tests cover
// the success shape plus the anonymous no-op branch.

import { describe, it, expect } from 'vitest';

import {
  FakeAuthTokenRepo,
  FakeClock,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import { Logout } from '../usecases/logout.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const authTokenRepo = new FakeAuthTokenRepo(clock);
  const userRepo = new FakeUserRepo(clock);

  const user = await userRepo.insert({
    email: 'alice@example.com',
    name: 'Alice',
    passwordHash: 'hashed:correcthorsebatterystaple',
    verified: true,
  });

  // Pre-seed two single-use tokens for the user.
  await authTokenRepo.insert({
    userId: user.id,
    kind: 'reset_password',
    tokenHash: 'reset-hash',
    expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
  });
  await authTokenRepo.insert({
    userId: user.id,
    kind: 'verify_email',
    tokenHash: 'verify-hash',
    expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
  });

  const usecase = new Logout({ authTokenRepo });
  return { usecase, authTokenRepo, user };
}

describe('logout use case', () => {
  it('marks all outstanding verify_email and reset_password tokens used for the user', async () => {
    const { usecase, authTokenRepo, user } = await buildSut();

    const result = await usecase.execute({ userId: user.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.success).toBe(true);

    for (const t of authTokenRepo.tokens.values()) {
      expect(t.used).toBe(true);
    }
  });

  it('is a no-op success when userId is null (anonymous logout)', async () => {
    const { usecase, authTokenRepo } = await buildSut();

    const before = [...authTokenRepo.tokens.values()].map((t) => t.used);
    const result = await usecase.execute({ userId: null });
    const after = [...authTokenRepo.tokens.values()].map((t) => t.used);

    expect(result.ok).toBe(true);
    expect(after).toEqual(before);
  });
});
