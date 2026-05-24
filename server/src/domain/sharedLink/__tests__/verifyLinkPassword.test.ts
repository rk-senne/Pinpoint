// Unit tests for the verifyLinkPassword use case (Phase 1.5 / task 4.11.2).
//
// Exercises the lockout state machine described in
// `verifyLinkPassword.ts`: open links resolve immediately, the wrong
// password decrements the remaining-attempts counter and eventually
// triggers a 15-minute lock, the lock auto-expires after the window has
// passed, and a successful verify resets the counters.

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakePasswordHasher,
  FakeSharedLinkRepo,
} from '../../../__tests__/fakes/index.js';
import {
  LOCKOUT_MINUTES,
  MAX_FAILED_ATTEMPTS,
  VerifyLinkPassword,
  InvalidPassword,
  SharedLinkLocked,
  MissingPassword,
} from '../usecases/verifyLinkPassword.js';

async function buildSut(opts: { passwordHash: string | null }) {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const passwordHasher = new FakePasswordHasher();
  const sharedLinkRepo = new FakeSharedLinkRepo(clock);

  const link = await sharedLinkRepo.insert({
    projectId: 'project-1',
    passwordHash: opts.passwordHash,
  });

  const usecase = new VerifyLinkPassword({
    sharedLinkRepo,
    passwordHasher,
    clock,
  });
  return { usecase, clock, sharedLinkRepo, link };
}

describe('verifyLinkPassword use case', () => {
  it('resolves immediately for an open (no-password) link', async () => {
    const { usecase, link } = await buildSut({ passwordHash: null });

    const result = await usecase.execute({ linkId: link.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projectId).toBe('project-1');
    expect(result.value.attemptsRemaining).toBe(MAX_FAILED_ATTEMPTS);
  });

  it('returns NotFound when the link does not exist', async () => {
    const { usecase } = await buildSut({ passwordHash: null });

    const result = await usecase.execute({ linkId: 'no-such-link' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });

  it('returns MissingPassword (Validation) when no password is supplied to a protected link', async () => {
    const { usecase, link } = await buildSut({
      passwordHash: 'hashed:secret',
    });

    const result = await usecase.execute({ linkId: link.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(MissingPassword);
    expect(result.error.kind).toBe('Validation');
  });

  it('returns InvalidPassword with attempts countdown on a wrong password', async () => {
    const { usecase, link } = await buildSut({
      passwordHash: 'hashed:secret',
    });

    const result = await usecase.execute({
      linkId: link.id,
      password: 'wrong',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(InvalidPassword);
    const err = result.error as InvalidPassword;
    expect(err.attemptsRemaining).toBe(MAX_FAILED_ATTEMPTS - 1);
  });

  it('locks the link after MAX_FAILED_ATTEMPTS consecutive wrong passwords', async () => {
    const { usecase, sharedLinkRepo, link } = await buildSut({
      passwordHash: 'hashed:secret',
    });

    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) {
      const r = await usecase.execute({ linkId: link.id, password: 'wrong' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(InvalidPassword);
      }
    }

    const final = await usecase.execute({
      linkId: link.id,
      password: 'wrong',
    });
    expect(final.ok).toBe(false);
    if (final.ok) return;
    expect(final.error).toBeInstanceOf(SharedLinkLocked);

    // The persisted row should reflect the lock.
    const row = sharedLinkRepo.links.get(link.id)!;
    expect(row.failedAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(row.lockedUntil).toBeTruthy();
  });

  it('keeps returning Locked while the lock window is active', async () => {
    const { usecase, link } = await buildSut({
      passwordHash: 'hashed:secret',
    });

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await usecase.execute({ linkId: link.id, password: 'wrong' });
    }

    const result = await usecase.execute({
      linkId: link.id,
      password: 'secret',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Locked');
  });

  it('clears a stale lock and succeeds after the window has passed with the correct password', async () => {
    const { usecase, clock, link, sharedLinkRepo } = await buildSut({
      passwordHash: 'hashed:secret',
    });

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await usecase.execute({ linkId: link.id, password: 'wrong' });
    }

    // Advance the clock past the 15-minute lockout.
    clock.advance(LOCKOUT_MINUTES * 60 * 1000 + 1_000);

    const result = await usecase.execute({
      linkId: link.id,
      password: 'secret',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attemptsRemaining).toBe(MAX_FAILED_ATTEMPTS);

    const row = sharedLinkRepo.links.get(link.id)!;
    expect(row.failedAttempts).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it('resets the failure counter on a successful verify', async () => {
    const { usecase, sharedLinkRepo, link } = await buildSut({
      passwordHash: 'hashed:secret',
    });

    await usecase.execute({ linkId: link.id, password: 'wrong' });
    await usecase.execute({ linkId: link.id, password: 'wrong' });

    const ok = await usecase.execute({
      linkId: link.id,
      password: 'secret',
    });
    expect(ok.ok).toBe(true);

    const row = sharedLinkRepo.links.get(link.id)!;
    expect(row.failedAttempts).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });
});
