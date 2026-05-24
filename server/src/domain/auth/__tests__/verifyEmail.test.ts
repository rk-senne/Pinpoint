// Unit tests for the verifyEmail use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';

import {
  FakeAuthTokenRepo,
  FakeClock,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import { VerifyEmail } from '../usecases/verifyEmail.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const authTokenRepo = new FakeAuthTokenRepo(clock);
  const userRepo = new FakeUserRepo(clock);

  const user = await userRepo.insert({
    email: 'alice@example.com',
    name: 'Alice',
    passwordHash: 'hashed:correcthorsebatterystaple',
    verified: false,
  });

  const usecase = new VerifyEmail({ authTokenRepo, userRepo, clock });
  return { usecase, clock, authTokenRepo, userRepo, user };
}

describe('verifyEmail use case', () => {
  it('flips users.verified=true and marks the token used on a valid token', async () => {
    const { usecase, clock, authTokenRepo, userRepo, user } = await buildSut();

    const raw = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(clock.now().getTime() + 60_000).toISOString();
    const inserted = await authTokenRepo.insert({
      userId: user.id,
      kind: 'verify_email',
      tokenHash,
      expiresAt,
    });

    const result = await usecase.execute({ token: raw });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verified).toBe(true);

    const stored = authTokenRepo.tokens.get(inserted.id);
    expect(stored?.used).toBe(true);

    const refreshed = await userRepo.findByIdWithSecret(user.id);
    expect(refreshed?.verified).toBe(true);
  });

  it('returns Validation when the token is unknown', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({ token: 'never-issued' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });

  it('returns Validation when the token has expired', async () => {
    const { usecase, clock, authTokenRepo, user } = await buildSut();

    const raw = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(clock.now().getTime() - 1_000).toISOString();
    await authTokenRepo.insert({
      userId: user.id,
      kind: 'verify_email',
      tokenHash,
      expiresAt,
    });

    const result = await usecase.execute({ token: raw });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });
});
