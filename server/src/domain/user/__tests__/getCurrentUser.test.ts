// Unit tests for the getCurrentUser use case.

import { describe, it, expect } from 'vitest';

import { FakeClock, FakeUserRepo } from '../../../__tests__/fakes/index.js';
import { GetCurrentUser } from '../usecases/getCurrentUser.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const user = await userRepo.insert({
    email: 'alice@example.com',
    name: 'Alice',
    passwordHash: 'hash',
    verified: true,
  });
  const usecase = new GetCurrentUser({ userRepo });
  return { usecase, user };
}

describe('getCurrentUser use case', () => {
  it('returns the user when the id matches a stored row', async () => {
    const { usecase, user } = await buildSut();

    const result = await usecase.execute({ userId: user.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.user.id).toBe(user.id);
    expect(result.value.user.email).toBe('alice@example.com');
    expect(result.value.user.name).toBe('Alice');
    // The repo's safe projection never carries a password hash.
    expect(
      (result.value.user as unknown as { passwordHash?: string })
        .passwordHash,
    ).toBeUndefined();
  });

  it('returns NotFound when the id does not match any user', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({
      userId: '00000000-0000-0000-0000-000000000000',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });
});
