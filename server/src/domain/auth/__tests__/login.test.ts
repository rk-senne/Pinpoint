// Unit tests for the login use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakePasswordHasher,
  FakeTokenIssuer,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import { Login } from '../usecases/login.js';

async function buildSut(opts: { verified: boolean }) {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const passwordHasher = new FakePasswordHasher();
  const tokenIssuer = new FakeTokenIssuer(clock);

  const passwordHash = await passwordHasher.hash('correcthorsebatterystaple');
  const user = await userRepo.insert({
    email: 'alice@example.com',
    name: 'Alice',
    passwordHash,
    verified: opts.verified,
  });

  const usecase = new Login({ userRepo, passwordHasher, tokenIssuer });
  return { usecase, user, tokenIssuer };
}

describe('login use case', () => {
  it('returns user, token, and csrf for a verified user with valid credentials', async () => {
    const { usecase, user } = await buildSut({ verified: true });

    const result = await usecase.execute({
      email: 'alice@example.com',
      password: 'correcthorsebatterystaple',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.user.id).toBe(user.id);
    expect(result.value.token).toBeTypeOf('string');
    expect(result.value.csrfToken).toBeTypeOf('string');
    expect(result.value.token.length).toBeGreaterThan(0);
    expect(result.value.csrfToken.length).toBeGreaterThan(0);
  });

  it('returns Unauthorized when the password does not match', async () => {
    const { usecase } = await buildSut({ verified: true });

    const result = await usecase.execute({
      email: 'alice@example.com',
      password: 'wrong-password',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Unauthorized');
  });

  it('returns Unauthorized when the user is unverified', async () => {
    const { usecase } = await buildSut({ verified: false });

    const result = await usecase.execute({
      email: 'alice@example.com',
      password: 'correcthorsebatterystaple',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Unauthorized');
  });

  it('returns Unauthorized for an unknown email', async () => {
    const { usecase } = await buildSut({ verified: true });

    const result = await usecase.execute({
      email: 'nobody@example.com',
      password: 'whatever',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Unauthorized');
  });
});
