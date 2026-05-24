// Unit tests for the resolveProjectByUrl use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakePageRepo,
  FakeProjectRepo,
  FakeTeamMemberRepo,
} from '../../../__tests__/fakes/index.js';
import { ResolveProjectByUrl } from '../usecases/resolveProjectByUrl.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const teamMemberRepo = new FakeTeamMemberRepo({ clock });
  const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo });
  const pageRepo = new FakePageRepo(clock);

  const project = await projectRepo.insert({
    name: 'Site',
    urls: ['https://example.com'],
    ownerId: 'owner-1',
  });
  const page = await pageRepo.insert({
    projectId: project.id,
    url: 'https://example.com/dashboard',
  });

  const usecase = new ResolveProjectByUrl({ projectRepo, pageRepo, teamMemberRepo });
  return { usecase, project, page };
}

describe('resolveProjectByUrl use case', () => {
  it('returns the project + page id for an exact-match URL the user can access', async () => {
    const { usecase, project, page } = await buildSut();

    const result = await usecase.execute({
      userId: 'owner-1',
      url: 'https://example.com/dashboard',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projectId).toBe(project.id);
    expect(result.value.pageId).toBe(page.id);
  });

  it('returns Validation when the url query is empty after trim', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({ userId: 'owner-1', url: '   ' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });

  it('returns NotFound when no accessible project matches the URL', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({
      userId: 'stranger',
      url: 'https://example.com/dashboard',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });
});
