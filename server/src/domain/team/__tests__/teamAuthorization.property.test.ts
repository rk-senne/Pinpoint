// Feature: pinpoint-app, Property 3: Role-based access control enforcement
// **Validates: Requirements 9.4, 9.6**
//
// Domain-layer property test for role enforcement on the team
// management use cases (Phase 1.5 / task 4.11.3). Drives `InviteMember`,
// `UpdateMemberRole`, and `RemoveMember` through fakes — the same role
// matrix the legacy `isActionAllowed` table encoded is now distributed
// across the use cases, but the FSM is identical:
//
//   - owner: all three actions allowed
//   - admin: invite + update role allowed; remove not allowed
//   - viewer: none of the management actions allowed
//
// For each generated `actorRole`, the property asserts that:
//   * the success/Forbidden outcome of every gated use case matches the
//     expected matrix; and
//   * a Forbidden outcome leaves repository state unchanged (i.e., the
//     use cases do not partially apply when authorization fails).

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  FakeClock,
  FakeEventBus,
  FakeTeamMemberRepo,
  FakeTeamRepo,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import { InviteMember } from '../usecases/inviteMember.js';
import { UpdateMemberRole } from '../usecases/updateMemberRole.js';
import { RemoveMember } from '../usecases/removeMember.js';
import type { TeamRole } from '../TeamMember.js';

const ALL_ROLES: TeamRole[] = ['owner', 'admin', 'viewer'];

interface ExpectedPermissions {
  invite: boolean;
  updateRole: boolean;
  remove: boolean;
}

const EXPECTED: Record<TeamRole, ExpectedPermissions> = {
  owner: { invite: true, updateRole: true, remove: true },
  admin: { invite: true, updateRole: true, remove: false },
  viewer: { invite: false, updateRole: false, remove: false },
};

const arbRole = fc.constantFrom<TeamRole>(...ALL_ROLES);

interface Sut {
  teamId: string;
  actorUserId: string;
  victimUserId: string;
  inviteEmail: string;
  invite: InviteMember;
  updateRole: UpdateMemberRole;
  remove: RemoveMember;
  teamMemberRepo: FakeTeamMemberRepo;
}

async function buildSut(actorRole: TeamRole): Promise<Sut> {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const teamMemberRepo = new FakeTeamMemberRepo({ clock, userRepo });
  const teamRepo = new FakeTeamRepo({ clock, teamMemberRepo });
  const eventBus = new FakeEventBus();

  // Seed three users: actor (whose role we vary), victim (existing
  // member to remove/promote), and invitee (a free-floating user the
  // invite use case can target).
  const actor = await userRepo.insert({
    email: 'actor@example.com',
    name: 'Actor',
    passwordHash: 'hashed:secret',
  });
  const victim = await userRepo.insert({
    email: 'victim@example.com',
    name: 'Victim',
    passwordHash: 'hashed:secret',
  });
  const invitee = await userRepo.insert({
    email: 'invitee@example.com',
    name: 'Invitee',
    passwordHash: 'hashed:secret',
  });

  const team = await teamRepo.insert({ name: 'T', ownerId: actor.id });
  // The team needs a real owner so non-owner actors can be tested
  // without immediately running into the "owner missing" branch. When
  // the actor is the owner, we keep them as such; otherwise we mint a
  // synthetic owner so the actor can be admin/viewer.
  if (actorRole === 'owner') {
    await teamMemberRepo.add({
      teamId: team.id,
      userId: actor.id,
      role: 'owner',
    });
  } else {
    const trueOwner = await userRepo.insert({
      email: 'trueowner@example.com',
      name: 'TrueOwner',
      passwordHash: 'hashed:secret',
    });
    await teamMemberRepo.add({
      teamId: team.id,
      userId: trueOwner.id,
      role: 'owner',
    });
    await teamMemberRepo.add({
      teamId: team.id,
      userId: actor.id,
      role: actorRole,
    });
  }

  // Victim is always a viewer member of the team.
  await teamMemberRepo.add({
    teamId: team.id,
    userId: victim.id,
    role: 'viewer',
  });

  const invite = new InviteMember({
    teamRepo,
    teamMemberRepo,
    userRepo,
    eventBus,
  });
  const updateRole = new UpdateMemberRole({
    teamRepo,
    teamMemberRepo,
    eventBus,
  });
  const remove = new RemoveMember({ teamRepo, teamMemberRepo });

  return {
    teamId: team.id,
    actorUserId: actor.id,
    victimUserId: victim.id,
    inviteEmail: invitee.email,
    invite,
    updateRole,
    remove,
    teamMemberRepo,
  };
}

describe('Property 3: Role-based access control enforcement (use-case layer)', () => {
  it('invite/updateRole/remove enforce the canonical role matrix for every actor role', async () => {
    await fc.assert(
      fc.asyncProperty(arbRole, async (actorRole) => {
        const sut = await buildSut(actorRole);
        const expected = EXPECTED[actorRole];

        const before = sut.teamMemberRepo.members.size;

        // --- invite ---
        const inviteResult = await sut.invite.execute({
          actorUserId: sut.actorUserId,
          teamId: sut.teamId,
          email: sut.inviteEmail,
        });
        expect(inviteResult.ok).toBe(expected.invite);
        if (!inviteResult.ok) {
          expect(inviteResult.error.kind).toBe('Forbidden');
          // Forbidden outcomes must not partially apply.
          expect(sut.teamMemberRepo.members.size).toBe(before);
        }

        // --- updateRole ---
        const sizeBeforeUpdate = sut.teamMemberRepo.members.size;
        const beforeRow = sut.teamMemberRepo.members.get(
          `${sut.teamId}:${sut.victimUserId}`,
        );
        const updateResult = await sut.updateRole.execute({
          actorUserId: sut.actorUserId,
          teamId: sut.teamId,
          targetUserId: sut.victimUserId,
          role: 'admin',
        });
        expect(updateResult.ok).toBe(expected.updateRole);
        if (!updateResult.ok) {
          expect(updateResult.error.kind).toBe('Forbidden');
          // Forbidden outcomes leave the persisted role untouched.
          const afterRow = sut.teamMemberRepo.members.get(
            `${sut.teamId}:${sut.victimUserId}`,
          );
          expect(afterRow?.role).toBe(beforeRow?.role);
          expect(sut.teamMemberRepo.members.size).toBe(sizeBeforeUpdate);
        }

        // --- remove ---
        const sizeBeforeRemove = sut.teamMemberRepo.members.size;
        const removeResult = await sut.remove.execute({
          actorUserId: sut.actorUserId,
          teamId: sut.teamId,
          targetUserId: sut.victimUserId,
        });
        expect(removeResult.ok).toBe(expected.remove);
        if (!removeResult.ok) {
          expect(removeResult.error.kind).toBe('Forbidden');
          expect(sut.teamMemberRepo.members.size).toBe(sizeBeforeRemove);
        }
      }),
      { numRuns: 50 },
    );
  });
});
