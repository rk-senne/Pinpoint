// Unit tests for the updateMemberRole use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakeEventBus,
  FakeTeamMemberRepo,
  FakeTeamRepo,
} from '../../../__tests__/fakes/index.js';
import { UpdateMemberRole } from '../usecases/updateMemberRole.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const teamMemberRepo = new FakeTeamMemberRepo({ clock });
  const teamRepo = new FakeTeamRepo({ clock, teamMemberRepo });
  const eventBus = new FakeEventBus();

  const team = await teamRepo.insert({ name: 'T', ownerId: 'owner-1' });
  await teamMemberRepo.add({ teamId: team.id, userId: 'owner-1', role: 'owner' });
  await teamMemberRepo.add({ teamId: team.id, userId: 'member-1', role: 'viewer' });

  const usecase = new UpdateMemberRole({ teamRepo, teamMemberRepo, eventBus });
  return { usecase, team, eventBus };
}

describe('updateMemberRole use case', () => {
  it('updates a viewer to admin (no promotion event)', async () => {
    const { usecase, team, eventBus } = await buildSut();

    const result = await usecase.execute({
      actorUserId: 'owner-1',
      teamId: team.id,
      targetUserId: 'member-1',
      role: 'admin',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.member.role).toBe('admin');
    expect(result.value.promotedToOwner).toBe(false);
    expect(eventBus.events).toHaveLength(0);
  });

  it('emits team.member_promoted_to_owner when promoting to owner', async () => {
    const { usecase, team, eventBus } = await buildSut();

    const result = await usecase.execute({
      actorUserId: 'owner-1',
      teamId: team.id,
      targetUserId: 'member-1',
      role: 'owner',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.promotedToOwner).toBe(true);
    expect(eventBus.events).toHaveLength(1);
    expect(eventBus.events[0]!.type).toBe('team.member_promoted_to_owner');
  });

  it('returns Forbidden when the actor is not an owner or admin', async () => {
    const { usecase, team } = await buildSut();

    const result = await usecase.execute({
      actorUserId: 'stranger',
      teamId: team.id,
      targetUserId: 'member-1',
      role: 'admin',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Forbidden');
  });

  it('returns NotFound when the target is not in the team', async () => {
    const { usecase, team } = await buildSut();

    const result = await usecase.execute({
      actorUserId: 'owner-1',
      teamId: team.id,
      targetUserId: 'never-joined',
      role: 'admin',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });
});
