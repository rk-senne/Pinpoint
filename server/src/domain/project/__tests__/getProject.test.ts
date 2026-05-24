// Unit tests for the getProject use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakeProjectRepo,
  FakeTeamMemberRepo,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import { GetProject } from '../usecases/getProject.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const teamMemberRepo = new FakeTeamMemberRepo({ clock, userRepo });
  const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo, userRepo });

  const owner = await userRepo.insert({
    email: 'owner@example.com',
    name: 'Owner',
    passwordHash: 'h',
    verified: true,
  });
  const project = await projectRepo.insert({
    name: 'My Project',
    urls: ['https://example.com'],
    ownerId: owner.id,
  });

  const usecase = new GetProject({ projectRepo, teamMemberRepo });
  return { usecase, owner, project };
}

describe('getProject use case', () => {
  it('returns the project, annotation count, and member list for the owner', async () => {
    const { usecase, owner, project } = await buildSut();

    const result = await usecase.execute({ userId: owner.id, projectId: project.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.project.id).toBe(project.id);
    expect(result.value.annotationCount).toBe(0);
    expect(result.value.members.map((m) => m.userId)).toContain(owner.id);
  });

  it('returns NotFound when the project does not exist', async () => {
    const { usecase, owner } = await buildSut();

    const result = await usecase.execute({
      userId: owner.id,
      projectId: '00000000-0000-0000-0000-000000000000',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });

  it('returns Forbidden for a user with no access', async () => {
    const { usecase, project } = await buildSut();

    const result = await usecase.execute({
      userId: 'stranger',
      projectId: project.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Forbidden');
  });
});
