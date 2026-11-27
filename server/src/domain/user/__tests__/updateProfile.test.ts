// Unit tests for the updateProfile use case.

import { describe, it, expect } from 'vitest';

import {
  FakeAuthTokenRepo,
  FakeClock,
  FakeMailer,
  FakePasswordHasher,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import { UpdateProfile } from '../usecases/updateProfile.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const user = await userRepo.insert({
    email: 'alice@example.com',
    name: 'Alice',
    passwordHash: 'hashed:correct-horse-1',
    verified: true,
  });
  const authTokenRepo = new FakeAuthTokenRepo(clock);
  const mailer = new FakeMailer();
  const usecase = new UpdateProfile({
    userRepo,
    passwordHasher: new FakePasswordHasher(),
    authTokenRepo,
    mailer,
    clock,
    buildConfirmLink: (t) => `https://app.test/verify-email/${t}`,
  });
  return { usecase, userRepo, user, authTokenRepo, mailer };
}

describe('updateProfile use case', () => {
  it('updates the name and trims whitespace', async () => {
    const { usecase, user } = await buildSut();

    const result = await usecase.execute({
      userId: user.id,
      name: '  Alice Cooper  ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.user.name).toBe('Alice Cooper');
    expect(result.value.user.email).toBe('alice@example.com');
  });

  describe('e-mail change (PP-06)', () => {
    it('requires the current password', async () => {
      const { usecase, user, userRepo } = await buildSut();
      const r = await usecase.execute({ userId: user.id, email: 'new@example.com' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('Validation');
      expect((await userRepo.findById(user.id))!.email).toBe('alice@example.com');
    });

    it('rejects a wrong password without touching anything', async () => {
      const { usecase, user, userRepo, mailer } = await buildSut();
      const r = await usecase.execute({ userId: user.id, email: 'new@example.com', currentPassword: 'nope' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('Forbidden');
      expect((await userRepo.findByIdWithSecret(user.id))!.pendingEmail ?? null).toBeNull();
      expect(mailer.sent).toHaveLength(0);
    });

    it('keeps the login e-mail, stores pending_email and mails both addresses', async () => {
      const { usecase, user, userRepo, mailer, authTokenRepo } = await buildSut();
      const r = await usecase.execute({ userId: user.id, email: '  New@Example.com ', currentPassword: 'correct-horse-1' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.user.email).toBe('alice@example.com');
      expect(r.value.emailChange).toEqual({ pendingEmail: 'new@example.com' });
      expect((await userRepo.findByIdWithSecret(user.id))!.pendingEmail).toBe('new@example.com');
      expect(mailer.sent.map((m) => m.to).sort()).toEqual(['alice@example.com', 'new@example.com']);
      expect(mailer.sent.find((m) => m.to === 'new@example.com')!.body).toContain('https://app.test/verify-email/');
      expect([...authTokenRepo.tokens.values()].some((t) => t.kind === 'change_email')).toBe(true);
      // verified status and sessions untouched until confirmation
      expect((await userRepo.findByIdWithSecret(user.id))!.tokenVersion).toBe(0);
    });

    it('does not reveal that the address is taken (same shape, nothing sent)', async () => {
      const { usecase, userRepo, user, mailer } = await buildSut();
      await userRepo.insert({ email: 'taken@example.com', name: 'Bob', passwordHash: 'h', verified: true });
      const r = await usecase.execute({ userId: user.id, email: 'taken@example.com', currentPassword: 'correct-horse-1' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.emailChange).toEqual({ pendingEmail: 'taken@example.com' });
      expect(mailer.sent).toHaveLength(0);
      expect((await userRepo.findByIdWithSecret(user.id))!.pendingEmail ?? null).toBeNull();
    });

    it('rejects malformed addresses', async () => {
      const { usecase, user } = await buildSut();
      const r = await usecase.execute({ userId: user.id, email: 'notanemail', currentPassword: 'correct-horse-1' });
      expect(r.ok).toBe(false);
    });

    it('is refused when the re-auth collaborators are not wired (fail closed)', async () => {
      const clock = new FakeClock(new Date());
      const userRepo = new FakeUserRepo(clock);
      const u = await userRepo.insert({ email: 'a@b.test', name: 'A', passwordHash: 'h', verified: true });
      const r = await new UpdateProfile({ userRepo }).execute({ userId: u.id, email: 'c@d.test', currentPassword: 'x' });
      expect(r.ok).toBe(false);
    });
  });

  describe('avatar URL (PP-19)', () => {
    it.each(['javascript:alert(1)', 'data:text/html,<script>x</script>', 'http://x.test/a.png', 'https://u:p@x.test/a.png', 'https://x.test/' + 'a'.repeat(1100)])(
      'rejects %s',
      async (avatarUrl) => {
        const { usecase, user } = await buildSut();
        const r = await usecase.execute({ userId: user.id, avatarUrl });
        expect(r.ok).toBe(false);
      },
    );
    it('accepts https', async () => {
      const { usecase, user } = await buildSut();
      expect((await usecase.execute({ userId: user.id, avatarUrl: 'https://cdn.test/a.png' })).ok).toBe(true);
    });
  });

  it('rejects a 5000-character name instead of failing with a DB error (PP-13)', async () => {
    const { usecase, user } = await buildSut();
    expect((await usecase.execute({ userId: user.id, name: 'x'.repeat(5000) })).ok).toBe(false);
  });

  it('clears the avatar when avatarUrl is null', async () => {
    const { usecase, userRepo, user } = await buildSut();
    await userRepo.update(user.id, { avatarUrl: 'https://x/y.png' });

    const result = await usecase.execute({
      userId: user.id,
      avatarUrl: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.user.avatarUrl).toBeUndefined();
  });

  it('allows reusing the same email the user already owns', async () => {
    const { usecase, user } = await buildSut();

    const result = await usecase.execute({
      userId: user.id,
      email: 'alice@example.com',
    });

    expect(result.ok).toBe(true);
  });

  it('returns Validation when no fields are supplied', async () => {
    const { usecase, user } = await buildSut();

    const result = await usecase.execute({ userId: user.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });

  it('returns Validation when the name is blank', async () => {
    const { usecase, user } = await buildSut();

    const result = await usecase.execute({ userId: user.id, name: '   ' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });

  it('returns Validation when avatarUrl is the wrong type', async () => {
    const { usecase, user } = await buildSut();

    const result = await usecase.execute({
      userId: user.id,
      // Force the wrong type past the static check the use case re-validates.
      avatarUrl: 42 as unknown as string,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });

  it('returns NotFound when the user no longer exists', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({
      userId: '00000000-0000-0000-0000-000000000000',
      name: 'Ghost',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });
});
