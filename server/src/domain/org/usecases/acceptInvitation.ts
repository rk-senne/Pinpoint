import type { InvitationRepo } from '../ports/InvitationRepo.js';
import type { MembershipRepo, Membership } from '../../auth/ports/MembershipRepo.js';
import type { Clock } from '../../shared/ports/Clock.js';
import {
  NotFound,
  Unauthorized,
  Conflict,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

export interface AcceptInvitationInput {
  token: string;
  userId: string;
}

export interface AcceptInvitationOutput {
  membership: Membership;
}

export interface AcceptInvitationDeps {
  invitationRepo: InvitationRepo;
  membershipRepo: MembershipRepo;
  clock: Clock;
}

export class AcceptInvitation {
  constructor(private readonly deps: AcceptInvitationDeps) {}

  async execute(input: AcceptInvitationInput): Promise<Result<AcceptInvitationOutput, DomainError>> {
    const { invitationRepo, membershipRepo, clock } = this.deps;

    const invitation = await invitationRepo.findByToken(input.token);
    if (!invitation) {
      return err(new NotFound('Invitation not found or already used.'));
    }

    const now = clock.now();
    if (new Date(invitation.expiresAt) < now) {
      await invitationRepo.deleteById(invitation.id);
      return err(new Unauthorized('Invitation has expired.'));
    }

    const existing = await membershipRepo.findDefaultForUser(input.userId);
    if (existing && existing.orgId === invitation.orgId) {
      await invitationRepo.deleteById(invitation.id);
      return err(new Conflict('You are already a member of this organization.'));
    }

    const membership: Membership = {
      orgId: invitation.orgId,
      userId: input.userId,
      role: invitation.role,
    };

    await membershipRepo.create(membership);
    await invitationRepo.deleteById(invitation.id);

    return ok({ membership });
  }
}
