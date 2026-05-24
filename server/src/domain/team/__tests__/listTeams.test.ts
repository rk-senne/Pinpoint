// Unit tests for the listTeams use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakeTeamMemberRepo,
  FakeTeamRepo,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import { ListTeams } from '../usecases/listTeams.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const teamMemberRepo = new FakeTeamMemberRepo({ clock, userRepo });
  const teamRepo = new FakeTeamRepo({ clock, teamMemberRepo });

  const owner = await userRepo.insert({
    email: 'owner@example.com',
    name: 'Owner',
    passwordHash: 'h',
    verified: true,
  });
  const team = await teamRepo.insert({ name: 'My Team', ownerId: owner.id });
  await teamMemberRepo.add({ teamId: team.id, userId: owner.id, role: 'owner' });

  const usecase = new ListTeams({ teamRepo, teamMemberRepo });
  return { usecase, owner, team };
}

describe('listTeams use case', () => {
  it('returns teams for the caller enriched with role and members', async () => {
    const { usecase, owner, team } = await buildSut();

    const result = await usecase.execute({ userId: owner.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.teams).toHaveLength(1);
    expect(result.value.teams[0]!.id).toBe(team.id);
    expect(result.value.teams[0]!.role).toBe('owner');
    expect(result.value.teams[0]!.members.map((m) => m.userId)).toEqual([owner.id]);
  });

  it('returns an empty list for a user with no team memberships', async () => {
    const { usecase } = await buildSut();

    const result = await usecase.execute({ userId: 'unknown-user' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.teams).toEqual([]);
  });
});
