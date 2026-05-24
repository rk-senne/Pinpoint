// Unit tests for the deleteProject use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakeEventBus,
  FakeProjectRepo,
  FakeTeamMemberRepo,
} from '../../../__tests__/fakes/index.js';
import { DeleteProject } from '../usecases/deleteProject.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const teamMemberRepo = new FakeTeamMemberRepo({ clock });
  const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo });
  const eventBus = new FakeEventBus();

  const project = await projectRepo.insert({
    name: 'Doomed Project',
    urls: ['https://example.com'],
    ownerId: 'owner-1',
  });

  const usecase = new DeleteProject({ projectRepo, teamMemberRepo, eventBus });
  return { usecase, project, projectRepo, eventBus };
}

describe('deleteProject use case', () => {
  it('deletes the project and emits project.deleted on the EventBus', async () => {
    const { usecase, project, projectRepo, eventBus } = await buildSut();

    const result = await usecase.execute({
      userId: 'owner-1',
      projectId: project.id,
      confirmationToken: project.name,
    });

    expect(result.ok).toBe(true);
    expect(projectRepo.projects.has(project.id)).toBe(false);
    expect(eventBus.events).toHaveLength(1);
    expect(eventBus.events[0]!.type).toBe('project.deleted');
  });

  it('returns Forbidden for a non-owner', async () => {
    const { usecase, project } = await buildSut();

    const result = await usecase.execute({
      userId: 'stranger',
      projectId: project.id,
      confirmationToken: project.name,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Forbidden');
  });

  it('returns Validation when the confirmation token does not match the project name', async () => {
    const { usecase, project } = await buildSut();

    const result = await usecase.execute({
      userId: 'owner-1',
      projectId: project.id,
      confirmationToken: 'wrong-name',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });
});
