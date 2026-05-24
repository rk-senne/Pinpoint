// Unit tests for the updateNotificationPreferences use case.

import { describe, it, expect } from 'vitest';

import { FakeClock, FakeUserRepo } from '../../../__tests__/fakes/index.js';
import { UpdateNotificationPreferences } from '../usecases/updateNotificationPreferences.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const user = await userRepo.insert({
    email: 'alice@example.com',
    name: 'Alice',
    passwordHash: 'hash',
    verified: true,
  });
  const usecase = new UpdateNotificationPreferences({ userRepo });
  return { usecase, user };
}

describe('updateNotificationPreferences use case', () => {
  it('toggles a single preference and leaves the others untouched', async () => {
    const { usecase, user } = await buildSut();

    const result = await usecase.execute({
      userId: user.id,
      preferences: { newAnnotation: false },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notificationPreferences).toEqual({
      newAnnotation: false,
      newComment: true,
      promotedToOwner: true,
      projectDeleted: true,
    });
  });

  it('merges multiple boolean keys into the existing preferences', async () => {
    const { usecase, user } = await buildSut();

    const result = await usecase.execute({
      userId: user.id,
      preferences: { newComment: false, projectDeleted: false },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notificationPreferences).toEqual({
      newAnnotation: true,
      newComment: false,
      promotedToOwner: true,
      projectDeleted: false,
    });
  });

  it('returns Validation when a value is not a boolean', async () => {
    const { usecase, user } = await buildSut();

    const result = await usecase.execute({
      userId: user.id,
      preferences: {
        newAnnotation: 'yes' as unknown as boolean,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });

  it('returns Validation when no preferences are supplied', async () => {
    const { usecase, user } = await buildSut();

    const result = await usecase.execute({
      userId: user.id,
      preferences: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });

  it('returns NotFound when the user is missing', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({
      userId: '00000000-0000-0000-0000-000000000000',
      preferences: { newAnnotation: false },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });
});
