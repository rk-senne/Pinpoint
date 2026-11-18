// Unit tests for the registerUser use case (Phase 1.5 / task 4.11.2).
//
// Wires every required port through the in-memory fakes and exercises
// both the happy path (new user persisted, verify_email token minted,
// queue row enqueued) and the duplicate-email guard (Conflict).

import { describe, it, expect } from 'vitest';

import {
  FakeAuthTokenRepo,
  FakeClock,
  FakeNotificationQueue,
  FakePasswordHasher,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import { RegisterUser } from '../usecases/registerUser.js';

const PASSWORD = 'correcthorsebatterystaple';

function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const authTokenRepo = new FakeAuthTokenRepo(clock);
  const passwordHasher = new FakePasswordHasher();
  const notificationQueue = new FakeNotificationQueue(clock);

  const usecase = new RegisterUser({
    userRepo,
    authTokenRepo,
    passwordHasher,
    notificationQueue,
    clock,
    buildVerifyEmailLink: (raw) => `https://app.test/verify/${raw}`,
  });

  return { usecase, clock, userRepo, authTokenRepo, notificationQueue };
}

describe('registerUser use case', () => {
  it('creates an unverified user and enqueues a verification email', async () => {
    const { usecase, userRepo, authTokenRepo, notificationQueue } = buildSut();

    const result = await usecase.execute({
      email: 'Alice@Example.com',
      password: PASSWORD,
      name: 'Alice',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.user.email).toBe('alice@example.com');
    expect(result.value.user.name).toBe('Alice');
    expect(userRepo.users.size).toBe(1);

    // Token + queue row both exist exactly once.
    expect(authTokenRepo.tokens.size).toBe(1);
    const token = [...authTokenRepo.tokens.values()][0]!;
    expect(token.kind).toBe('verify_email');
    expect(token.userId).toBe(result.value.user.id);
    expect(token.used).toBe(false);

    expect(notificationQueue.list()).toHaveLength(1);
    const queued = notificationQueue.list()[0]!;
    expect(queued.payload.kind).toBe('verify_email');
    expect(queued.payload.recipientUserId).toBe(result.value.user.id);
  });

  it('responds to a duplicate email exactly like a success but creates/sends nothing (F-17)', async () => {
    const { usecase, userRepo, authTokenRepo, notificationQueue } = buildSut();

    const first = await usecase.execute({
      email: 'alice@example.com',
      password: PASSWORD,
      name: 'Alice',
    });
    expect(first.ok).toBe(true);

    const result = await usecase.execute({
      email: 'Alice@example.com',
      password: 'another-long-password-9',
      name: 'Alice2',
    });

    // Same ok-shape as a fresh registration (no Conflict → no enumeration).
    expect(result.ok).toBe(true);
    if (!result.ok || !first.ok) return;
    expect(Object.keys(result.value.user).sort()).toEqual(Object.keys(first.value.user).sort());
    expect(result.value.user.email).toBe('alice@example.com');

    // …but no second account, token, or email, and the real account is untouched.
    expect(userRepo.users.size).toBe(1);
    expect(authTokenRepo.tokens.size).toBe(1);
    expect(notificationQueue.list()).toHaveLength(1);
    expect(result.value.user.id).not.toBe(first.value.user.id);
    const stored = [...userRepo.users.values()][0]!;
    expect(stored.name).toBe('Alice');
    expect(stored.passwordHash).toBe(`hashed:${PASSWORD}`);
  });

  it('returns Validation when the password is in the common-passwords blocklist', async () => {
    const { usecase } = buildSut();

    const result = await usecase.execute({
      email: 'bob@example.com',
      password: 'qwertyuiop',
      name: 'Bob',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });
});
