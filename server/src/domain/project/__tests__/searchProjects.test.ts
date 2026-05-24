// Unit tests for the searchProjects use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakeProjectRepo,
  FakeTeamMemberRepo,
} from '../../../__tests__/fakes/index.js';
import { SearchProjects } from '../usecases/searchProjects.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const teamMemberRepo = new FakeTeamMemberRepo({ clock });
  const projectRepo = new FakeProjectRepo({ clock, teamMemberRepo });

  await projectRepo.insert({ name: 'Alpha', urls: ['https://a.test'], ownerId: 'user-1' });
  await projectRepo.insert({ name: 'Bravo', urls: ['https://b.test'], ownerId: 'user-1' });
  await projectRepo.insert({ name: 'Charlie', urls: ['https://c.test'], ownerId: 'user-2' });

  const usecase = new SearchProjects({ projectRepo });
  return { usecase, projectRepo };
}

describe('searchProjects use case', () => {
  it('returns only projects owned by (or shared with) the caller', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({ userId: 'user-1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projects).toHaveLength(2);
    expect(result.value.projects.every((p) => p.ownerId === 'user-1')).toBe(true);
  });

  it('returns an empty list when the caller owns nothing matching the filter', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({ userId: 'user-1', search: 'no-match-string' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projects).toHaveLength(0);
  });

  it('honors the search term (case-insensitive substring match)', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({ userId: 'user-1', search: 'alph' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projects.map((p) => p.name)).toEqual(['Alpha']);
  });
});
