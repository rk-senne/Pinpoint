// removeMember use case (Phase 1.5 / task 4.7.5).
//
// Implements `DELETE /api/v1/teams/:id/members/:userId`. Removes a
// member from a team; access to every project owned by the team is
// implicitly revoked because project access is gated on
// `team_members`.
//
// Authorization rules (mirrored from the legacy route):
//   - Only the team Owner may remove a member.
//   - The Owner cannot remove themselves; ownership transfer is a
//     separate operation (`updateMemberRole` → `owner`).

import type { TeamRepo } from '../ports/TeamRepo.js';
import type { TeamMemberRepo } from '../ports/TeamMemberRepo.js';
import {
  Forbidden,
  NotFound,
  Validation,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

export interface RemoveMemberInput {
  /** Caller's user id. Must be the team Owner. */
  actorUserId: string;
  teamId: string;
  targetUserId: string;
}

export interface RemoveMemberOutput {
  teamId: string;
  removedUserId: string;
}

export interface RemoveMemberDeps {
  teamRepo: TeamRepo;
  teamMemberRepo: TeamMemberRepo;
}

export class RemoveMember {
  constructor(private readonly deps: RemoveMemberDeps) {}

  async execute(
    input: RemoveMemberInput,
  ): Promise<Result<RemoveMemberOutput, DomainError>> {
    const { teamRepo, teamMemberRepo } = this.deps;

    const team = await teamRepo.findById(input.teamId);
    if (!team) {
      return err(new NotFound('Team not found.'));
    }

    const actorMembership = await teamMemberRepo.findByTeamAndUser(
      team.id,
      input.actorUserId,
    );
    if (!actorMembership || actorMembership.role !== 'owner') {
      return err(new Forbidden('Only team owners can remove members.'));
    }

    if (input.targetUserId === input.actorUserId) {
      return err(new Validation('Team owner cannot remove themselves.'));
    }

    const targetMembership = await teamMemberRepo.findByTeamAndUser(
      team.id,
      input.targetUserId,
    );
    if (!targetMembership) {
      return err(new NotFound('Member not found in this team.'));
    }

    await teamMemberRepo.remove(team.id, input.targetUserId);

    return ok({ teamId: team.id, removedUserId: input.targetUserId });
  }
}
