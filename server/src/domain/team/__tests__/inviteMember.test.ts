// Unit tests for the inviteMember use case (Phase 1.5 / task 4.11.2).

import { describe, it, expect } from 'vitest';

import {
  FakeClock,
  FakeEventBus,
  FakeTeamMemberRepo,
  FakeTeamRepo,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import { InviteMember } from '../usecases/inviteMember.js';

async function buildSut() {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const teamMemberRepo = new FakeTeamMemberRepo({ clock, userRepo });
  const teamRepo = new FakeTeamRepo({ clock, teamMemberRepo });
  const eventBus = new FakeEventBus();

  const owner = await userRepo.insert({
    email: 'owner@example.com',
    name: 'Owner',
    passwordHash: 'h',
    verified: true,
  });
  const invitee = await userRepo.insert({
    email: 'invitee@example.com',
    name: 'Invitee',
    passwordHash: 'h',
    verified: true,
  });
  const team = await teamRepo.insert({ name: 'My Team', ownerId: owner.id });
  await teamMemberRepo.add({ teamId: team.id, userId: owner.id, role: 'owner' });

  const usecase = new InviteMember({ teamRepo, teamMemberRepo, userRepo, eventBus });
  return { usecase, owner, invitee, team, teamMemberRepo, eventBus };
}

describe('inviteMember use case', () => {
  it('adds the invitee as a viewer and emits team.member_invited', async () => {
    const { usecase, owner, invitee, team, teamMemberRepo, eventBus } = await buildSut();

    const result = await usecase.execute({
      actorUserId: owner.id,
      teamId: team.id,
      email: 'invitee@example.com',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.member.userId).toBe(invitee.id);
    expect(result.value.member.role).toBe('viewer');
    expect(teamMemberRepo.members.size).toBe(2);
    expect(eventBus.events).toHaveLength(1);
    expect(eventBus.events[0]!.type).toBe('team.member_invited');
  });

  it('returns Forbidden when the actor is not an owner or admin', async () => {
    const { usecase, team } = await buildSut();

    const result = await usecase.execute({
      actorUserId: 'stranger',
      teamId: team.id,
      email: 'invitee@example.com',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Forbidden');
  });

  it('returns NotFound when no user matches the email', async () => {
    const { usecase, owner, team } = await buildSut();

    const result = await usecase.execute({
      actorUserId: owner.id,
      teamId: team.id,
      email: 'no-user@example.com',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('NotFound');
  });

  it('returns Conflict when the user is already a member', async () => {
    const { usecase, owner, team } = await buildSut();

    // First invite succeeds.
    await usecase.execute({
      actorUserId: owner.id,
      teamId: team.id,
      email: 'invitee@example.com',
    });

    // Replay should conflict.
    const result = await usecase.execute({
      actorUserId: owner.id,
      teamId: team.id,
      email: 'invitee@example.com',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Conflict');
  });
});
