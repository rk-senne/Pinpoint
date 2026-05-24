// Unit tests for the archiveProject use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakeProjectRepo,
  FakeTeamMemberRepo,
} from '../../../__tests__/fakes/index.js';
import { ArchiveProject } from '../usecases/archiveProject.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const teamMemberRepo = new FakeTeamMemberRepo({ clock });
  const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo });

  const project = await projectRepo.insert({
    name: 'My Project',
    urls: ['https://example.com'],
    ownerId: 'owner-1',
  });

  const usecase = new ArchiveProject({ projectRepo, teamMemberRepo });
  return { usecase, project, projectRepo };
}

describe('archiveProject use case', () => {
  it('flips status to archived for the owner', async () => {
    const { usecase, project, projectRepo } = await buildSut();

    const result = await usecase.execute({ userId: 'owner-1', projectId: project.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.project.status).toBe('archived');
    expect(projectRepo.projects.get(project.id)?.status).toBe('archived');
  });

  it('returns Forbidden for a non-owner without admin team membership', async () => {
    const { usecase, project } = await buildSut();

    const result = await usecase.execute({ userId: 'stranger', projectId: project.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Forbidden');
  });

  it('returns NotFound when the project is missing', async () => {
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
