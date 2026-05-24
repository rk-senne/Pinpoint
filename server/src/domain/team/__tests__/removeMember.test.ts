// Unit tests for the removeMember use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakeTeamMemberRepo,
  FakeTeamRepo,
} from '../../../__tests__/fakes/index.js';
import { RemoveMember } from '../usecases/removeMember.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const teamMemberRepo = new FakeTeamMemberRepo({ clock });
  const teamRepo = new FakeTeamRepo({ clock, teamMemberRepo });

  const team = await teamRepo.insert({ name: 'T', ownerId: 'owner-1' });
  await teamMemberRepo.add({ teamId: team.id, userId: 'owner-1', role: 'owner' });
  await teamMemberRepo.add({ teamId: team.id, userId: 'member-1', role: 'viewer' });

  const usecase = new RemoveMember({ teamRepo, teamMemberRepo });
  return { usecase, team, teamMemberRepo };
}

describe('removeMember use case', () => {
  it('removes a member when the actor is the team owner', async () => {
    const { usecase, team, teamMemberRepo } = await buildSut();

    const result = await usecase.execute({
      actorUserId: 'owner-1',
      teamId: team.id,
      targetUserId: 'member-1',
    });

    expect(result.ok).toBe(true);
    expect(teamMemberRepo.members.size).toBe(1);
    expect(await teamMemberRepo.findByTeamAndUser(team.id, 'member-1')).toBeNull();
  });

  it('returns Forbidden for a non-owner actor', async () => {
    const { usecase, team } = await buildSut();

    const result = await usecase.execute({
      actorUserId: 'member-1',
      teamId: team.id,
      targetUserId: 'owner-1',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Forbidden');
  });

  it('returns Validation when the owner tries to remove themselves', async () => {
    const { usecase, team } = await buildSut();

    const result = await usecase.execute({
      actorUserId: 'owner-1',
      teamId: team.id,
      targetUserId: 'owner-1',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Validation');
  });

  it('returns NotFound when the target is not in the team', async () => {
    const { usecase, team } = await buildSut();

    const result = await usecase.execute({
      actorUserId: 'owner-1',
      teamId: team.id,
      targetUserId: 'stranger',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });
});
