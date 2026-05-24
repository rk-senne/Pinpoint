// updateMemberRole use case (Phase 1.5 / task 4.7.5).
//
// Implements `PUT /api/v1/teams/:id/members/:userId`. Promotes /
// demotes a team member. Authorization: only Owners and Admins may
// change roles. When the change promotes a
// user to `owner`, a `team.member_promoted_to_owner` event is emitted
// so the inbound adapter can hand off the matching durable
// notification (Reqs 10.3, 28).

import type { TeamMember, TeamRole } from '../TeamMember.js';
import type { TeamRepo } from '../ports/TeamRepo.js';
import type { TeamMemberRepo } from '../ports/TeamMemberRepo.js';
import type { EventBus } from '../../shared/ports/EventBus.js';
import {
  Forbidden,
  NotFound,
  Validation,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

const VALID_ROLES: ReadonlySet<TeamRole> = new Set(['owner', 'admin', 'viewer']);

export interface UpdateMemberRoleInput {
  /** Caller's user id. Must be Owner or Admin of the team. */
  actorUserId: string;
  teamId: string;
  /** User whose role is being changed. */
  targetUserId: string;
  role: TeamRole;
}

export interface UpdateMemberRoleOutput {
  member: TeamMember;
  promotedToOwner: boolean;
}

export interface UpdateMemberRoleDeps {
  teamRepo: TeamRepo;
  teamMemberRepo: TeamMemberRepo;
  eventBus: EventBus;
}

export class UpdateMemberRole {
  constructor(private readonly deps: UpdateMemberRoleDeps) {}

  async execute(
    input: UpdateMemberRoleInput,
  ): Promise<Result<UpdateMemberRoleOutput, DomainError>> {
    const { teamRepo, teamMemberRepo, eventBus } = this.deps;

    if (!VALID_ROLES.has(input.role)) {
      return err(
        new Validation('Role must be "owner", "admin", or "viewer".'),
      );
    }

    const team = await teamRepo.findById(input.teamId);
    if (!team) {
      return err(new NotFound('Team not found.'));
    }

    const actorMembership = await teamMemberRepo.findByTeamAndUser(
      team.id,
      input.actorUserId,
    );
    if (
      !actorMembership ||
      (actorMembership.role !== 'owner' && actorMembership.role !== 'admin')
    ) {
      return err(
        new Forbidden('Only team owners and admins can update member roles.'),
      );
    }

    const targetMembership = await teamMemberRepo.findByTeamAndUser(
      team.id,
      input.targetUserId,
    );
    if (!targetMembership) {
      return err(new NotFound('Member not found in this team.'));
    }

    const updated = await teamMemberRepo.updateRole(
      team.id,
      input.targetUserId,
      input.role,
    );

    const promotedToOwner =
      input.role === 'owner' && targetMembership.role !== 'owner';

    if (promotedToOwner) {
      eventBus.emit({
        type: 'team.member_promoted_to_owner',
        payload: {
          teamId: team.id,
          teamName: team.name,
          promotedUserId: input.targetUserId,
        },
      });
    }

    return ok({ member: updated, promotedToOwner });
  }
}
