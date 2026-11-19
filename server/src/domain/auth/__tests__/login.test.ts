// Unit tests for the login use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakeMembershipRepo,
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
  const membershipRepo = new FakeMembershipRepo();

  const passwordHash = await passwordHasher.hash('correcthorsebatterystaple');
  const user = await userRepo.insert({
    email: 'alice@example.com',
    name: 'Alice',
    passwordHash,
    verified: opts.verified,
  });

  membershipRepo.seed({ orgId: 'org-1', userId: user.id, role: 'owner' });

  const usecase = new Login({ userRepo, passwordHasher, tokenIssuer, membershipRepo });
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

describe('Login — personal org provisioning for self-registered users', () => {
  async function buildNoMembership(verified: boolean) {
    const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
    const userRepo = new FakeUserRepo(clock);
    const passwordHasher = new FakePasswordHasher();
    const tokenIssuer = new FakeTokenIssuer(clock);
    const membershipRepo = new FakeMembershipRepo();
    const user = await userRepo.insert({
      email: 'new@example.com',
      name: 'New',
      passwordHash: await passwordHasher.hash('correct-horse-9'),
      verified,
    });
    const calls: string[] = [];
    const provisionPersonalOrg = async (userId: string) => {
      calls.push(userId);
      membershipRepo.seed({ orgId: 'personal-org', userId, role: 'owner' });
      return 'personal-org';
    };
    const usecase = new Login({ userRepo, passwordHasher, tokenIssuer, membershipRepo, provisionPersonalOrg });
    return { usecase, user, calls };
  }

  it('provisions an org on first login when the user has none (regression)', async () => {
    const { usecase, user, calls } = await buildNoMembership(true);
    const result = await usecase.execute({ email: 'new@example.com', password: 'correct-horse-9' });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([user.id]);
  });

  it('never provisions for an unverified user or a wrong password', async () => {
    const unverified = await buildNoMembership(false);
    expect((await unverified.usecase.execute({ email: 'new@example.com', password: 'correct-horse-9' })).ok).toBe(false);
    expect(unverified.calls).toEqual([]);
    const wrong = await buildNoMembership(true);
    expect((await wrong.usecase.execute({ email: 'new@example.com', password: 'nope-nope-1' })).ok).toBe(false);
    expect(wrong.calls).toEqual([]);
  });
});

describe('Login — unverified accounts get a distinct machine code', () => {
  it('returns Unauthorized with code EMAIL_NOT_VERIFIED (documented contract)', async () => {
    const { usecase } = await buildSut({ verified: false });
    const result = await usecase.execute({ email: 'alice@example.com', password: 'correcthorsebatterystaple' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('Unauthorized');
      expect(result.error.code).toBe('EMAIL_NOT_VERIFIED');
    }
  });

  it('runs a bcrypt-equivalent compare for an unknown email so timing matches (F-17)', async () => {
    const { usecase, hasher } = await buildSutWithSpy();
    const before = hasher.verifyCalls;

    const unknown = await usecase.execute({ email: 'nobody@example.com', password: 'whatever' });
    expect(unknown.ok).toBe(false);
    expect(hasher.verifyCalls).toBe(before + 1);

    const wrong = await usecase.execute({ email: 'alice@example.com', password: 'wrong' });
    expect(wrong.ok).toBe(false);
    expect(hasher.verifyCalls).toBe(before + 2);

    // Identical error for both failure modes.
    if (!unknown.ok && !wrong.ok) {
      expect(unknown.error.message).toBe(wrong.error.message);
      expect(unknown.error.kind).toBe(wrong.error.kind);
    }
  });

  it('does not throw for an OAuth-only account with no local password hash', async () => {
    const { usecase, userRepo, hasher } = await buildSutWithSpy();
    await userRepo.insert({ email: 'oauth@example.com', name: 'O', passwordHash: '', verified: true });
    const res = await usecase.execute({ email: 'oauth@example.com', password: 'anything' });
    expect(res.ok).toBe(false);
    expect(hasher.verifyCalls).toBeGreaterThan(0);
  });
});

class SpyHasher extends FakePasswordHasher {
  verifyCalls = 0;
  override async verify(plain: string, hash: string): Promise<boolean> {
    this.verifyCalls++;
    return super.verify(plain, hash);
  }
}

async function buildSutWithSpy() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const hasher = new SpyHasher();
  const tokenIssuer = new FakeTokenIssuer(clock);
  const membershipRepo = new FakeMembershipRepo();
  const user = await userRepo.insert({
    email: 'alice@example.com',
    name: 'Alice',
    passwordHash: await hasher.hash('correcthorsebatterystaple'),
    verified: true,
  });
  membershipRepo.seed({ orgId: 'org-1', userId: user.id, role: 'owner' });
  const usecase = new Login({ userRepo, passwordHasher: hasher, tokenIssuer, membershipRepo });
  return { usecase, userRepo, hasher };
}
