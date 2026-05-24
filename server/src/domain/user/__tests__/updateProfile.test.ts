// Unit tests for the updateProfile use case.

import { describe, it, expect } from 'vitest';

import { FakeClock, FakeUserRepo } from '../../../__tests__/fakes/index.js';
import { UpdateProfile } from '../usecases/updateProfile.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const user = await userRepo.insert({
    email: 'alice@example.com',
    name: 'Alice',
    passwordHash: 'hash',
    verified: true,
  });
  const usecase = new UpdateProfile({ userRepo });
  return { usecase, userRepo, user };
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

  it('lowercases and trims a new email', async () => {
    const { usecase, user } = await buildSut();

    const result = await usecase.execute({
      userId: user.id,
      email: '  Alice2@Example.com ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.user.email).toBe('alice2@example.com');
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

  it('returns Conflict when the email belongs to another user', async () => {
    const { usecase, userRepo, user } = await buildSut();
    await userRepo.insert({
      email: 'taken@example.com',
      name: 'Bob',
      passwordHash: 'hash2',
      verified: true,
    });

    const result = await usecase.execute({
      userId: user.id,
      email: 'taken@example.com',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Conflict');
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
