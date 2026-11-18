// inviteMember use case (Phase 1.5 / task 4.7.5).
//
// Implements `POST /api/v1/teams/:id/invite`. Adds an existing user to
// a team in the Viewer role (the simplified flow the previous route
// handler implements). Owner / Admin gating, target-user lookup by
// email, duplicate-membership rejection,
// and the membership insert all happen here. Sending the actual invite
// email is delegated to a `team.member_invited` event emitted on the
// EventBus so the inbound adapter / mailer can subscribe.

import type { TeamMember } from '../TeamMember.js';
import type { TeamRepo } from '../ports/TeamRepo.js';
import type { TeamMemberRepo } from '../ports/TeamMemberRepo.js';
import type { UserRepo } from '../../user/ports/UserRepo.js';
import type { MembershipRepo } from '../../auth/ports/MembershipRepo.js';
import type { EventBus } from '../../shared/ports/EventBus.js';
import {
  Conflict,
  Forbidden,
  NotFound,
  Validation,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

export interface InviteMemberInput {
  /** Caller's user id. Must be Owner or Admin of the team. */
  actorUserId: string;
  teamId: string;
  /** Email of the user to invite. */
  email: string;
  /** Caller's org. The team must belong to it and the invitee must be a member of it (PP-04). */
  orgId?: string;
}

export interface InviteMemberOutput {
  member: TeamMember & { email: string; name: string };
}

export interface InviteMemberDeps {
  teamRepo: TeamRepo;
  teamMemberRepo: TeamMemberRepo;
  userRepo: UserRepo;
  eventBus: EventBus;
  /** Used to require that the invitee belongs to the team's org (PP-04). */
  membershipRepo?: MembershipRepo;
}

export class InviteMember {
  constructor(private readonly deps: InviteMemberDeps) {}

  async execute(
    input: InviteMemberInput,
  ): Promise<Result<InviteMemberOutput, DomainError>> {
    const { teamRepo, teamMemberRepo, userRepo, eventBus } = this.deps;

    const trimmedEmail = input.email.trim().toLowerCase();
    if (trimmedEmail.length === 0) {
      return err(new Validation('Email is required.'));
    }

    const team = await teamRepo.findById(input.teamId);
    // A team of another org is indistinguishable from a missing one.
    if (!team || (input.orgId !== undefined && team.orgId !== input.orgId)) {
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
        new Forbidden('Only team owners and admins can invite members.'),
      );
    }

    // Unknown e-mail and "registered but in another org" return the SAME
    // error so the endpoint is not a cross-tenant account oracle (PP-04).
    const notInOrg = (): Result<InviteMemberOutput, DomainError> =>
      err(new NotFound('No member of your organization has that email.'));
    const invited = await userRepo.findByEmail(trimmedEmail);
    if (!invited) return notInOrg();
    if (input.orgId !== undefined) {
      const membership = await this.deps.membershipRepo?.findByOrgAndUser(input.orgId, invited.id);
      if (!membership) return notInOrg();
    }

    const existing = await teamMemberRepo.findByTeamAndUser(team.id, invited.id);
    if (existing) {
      return err(new Conflict('User is already a member of this team.'));
    }

    const member = await teamMemberRepo.add({
      teamId: team.id,
      userId: invited.id,
      role: 'viewer',
    });

    eventBus.emit({
      type: 'team.member_invited',
      room: `user:${invited.id}`,
      payload: {
        teamId: team.id,
        teamName: team.name,
        invitedUserId: invited.id,
        invitedEmail: invited.email,
      },
    });

    return ok({
      member: {
        ...member,
        email: invited.email,
        name: invited.name,
      },
    });
  }
}
