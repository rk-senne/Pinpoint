// Unit tests for the completePasswordReset use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';

import {
  FakeAuthTokenRepo,
  FakeClock,
  FakePasswordHasher,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import { CompletePasswordReset } from '../usecases/completePasswordReset.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const authTokenRepo = new FakeAuthTokenRepo(clock);
  const passwordHasher = new FakePasswordHasher();

  const user = await userRepo.insert({
    email: 'alice@example.com',
    name: 'Alice',
    passwordHash: await passwordHasher.hash('originalpassword!'),
    verified: true,
  });

  const usecase = new CompletePasswordReset({
    userRepo,
    authTokenRepo,
    passwordHasher,
    clock,
  });

  return { usecase, clock, authTokenRepo, userRepo, user };
}

describe('completePasswordReset use case', () => {
  it('updates the user password and marks the token used on a valid token', async () => {
    const { usecase, clock, authTokenRepo, userRepo, user } = await buildSut();

    const raw = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(clock.now().getTime() + 60_000).toISOString();
    const inserted = await authTokenRepo.insert({
      userId: user.id,
      kind: 'reset_password',
      tokenHash,
      expiresAt,
    });

    const result = await usecase.execute({
      token: raw,
      newPassword: 'correcthorsebatterystaple',
    });

    expect(result.ok).toBe(true);
    expect(authTokenRepo.tokens.get(inserted.id)?.used).toBe(true);

    const refreshed = await userRepo.findByIdWithSecret(user.id);
    expect(refreshed?.passwordHash).toBe('hashed:correcthorsebatterystaple');
  });

  it('returns Validation when the new password is in the blocklist', async () => {
    const { usecase, clock, authTokenRepo, user } = await buildSut();

    const raw = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    const expiresAt = new Date(clock.now().getTime() + 60_000).toISOString();
    await authTokenRepo.insert({
      userId: user.id,
      kind: 'reset_password',
      tokenHash,
      expiresAt,
    });

    const result = await usecase.execute({
      token: raw,
      newPassword: 'qwertyuiop',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });

  it('returns Validation when the token is unknown', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({
      token: 'never-issued',
      newPassword: 'correcthorsebatterystaple',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });
});
