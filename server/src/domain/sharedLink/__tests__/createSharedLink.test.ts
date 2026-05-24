// Unit tests for the createSharedLink use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakePasswordHasher,
  FakeProjectRepo,
  FakeSharedLinkRepo,
  FakeTeamMemberRepo,
} from '../../../__tests__/fakes/index.js';
import { CreateSharedLink } from '../usecases/createSharedLink.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const teamMemberRepo = new FakeTeamMemberRepo({ clock });
  const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo });
  const sharedLinkRepo = new FakeSharedLinkRepo(clock);
  const passwordHasher = new FakePasswordHasher();

  const project = await projectRepo.insert({
    name: 'Site',
    urls: ['https://example.com'],
    ownerId: 'owner-1',
  });

  const usecase = new CreateSharedLink({
    projectRepo,
    sharedLinkRepo,
    passwordHasher,
  });
  return { usecase, project, sharedLinkRepo };
}

describe('createSharedLink use case', () => {
  it('creates a password-protected link for the project owner', async () => {
    const { usecase, project, sharedLinkRepo } = await buildSut();

    const result = await usecase.execute({
      userId: 'owner-1',
      projectId: project.id,
      password: 'secret123',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.passwordHash).toBe('hashed:secret123');
    expect(sharedLinkRepo.links.size).toBe(1);
  });

  it('rotates the password and clears lockout on a second call (idempotent)', async () => {
    const { usecase, project, sharedLinkRepo } = await buildSut();

    const first = await usecase.execute({
      userId: 'owner-1',
      projectId: project.id,
      password: 'secret123',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Manually flip the link into a locked state to verify it gets cleared.
    await sharedLinkRepo.update(first.value.id, {
      failedAttempts: 3,
      lockedUntil: new Date('2099-01-01T00:00:00Z').toISOString(),
    });

    const second = await usecase.execute({
      userId: 'owner-1',
      projectId: project.id,
      password: 'newsecret456',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.id).toBe(first.value.id);
    expect(second.value.passwordHash).toBe('hashed:newsecret456');
    expect(second.value.failedAttempts).toBe(0);
    expect(second.value.lockedUntil).toBeNull();
  });

  it('returns Forbidden when the caller is not the project owner', async () => {
    const { usecase, project } = await buildSut();

    const result = await usecase.execute({
      userId: 'stranger',
      projectId: project.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Forbidden');
  });

  it('returns NotFound for a missing project', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({
      userId: 'owner-1',
      projectId: '00000000-0000-0000-0000-000000000000',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });
});
