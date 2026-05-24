// Unit tests for the createTeam use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakeTeamMemberRepo,
  FakeTeamRepo,
} from '../../../__tests__/fakes/index.js';
import { CreateTeam } from '../usecases/createTeam.js';

function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const teamMemberRepo = new FakeTeamMemberRepo({ clock });
  const teamRepo = new FakeTeamRepo({ clock, teamMemberRepo });
  const usecase = new CreateTeam({ teamRepo, teamMemberRepo });
  return { usecase, teamRepo, teamMemberRepo };
}

describe('createTeam use case', () => {
  it('creates the team and seeds the creator as owner', async () => {
    const { usecase, teamRepo, teamMemberRepo } = buildSut();

    const result = await usecase.execute({
      ownerUserId: 'user-1',
      name: 'My Team',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(teamRepo.teams.size).toBe(1);
    expect(teamMemberRepo.members.size).toBe(1);
    const member = [...teamMemberRepo.members.values()][0]!;
    expect(member.userId).toBe('user-1');
    expect(member.role).toBe('owner');
  });

  it('returns Validation when the name is empty after trim', async () => {
    const { usecase } = buildSut();

    const result = await usecase.execute({ ownerUserId: 'user-1', name: '   ' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });
});
