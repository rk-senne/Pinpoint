import type { InvitationRepo } from '../ports/InvitationRepo.js';
import type { MembershipRepo, Membership } from '../../auth/ports/MembershipRepo.js';
import type { Clock } from '../../shared/ports/Clock.js';
import { hashInvitationToken } from './inviteToOrg.js';
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
  /**
   * Email of the authenticated accepting user (from the DB, not the request).
   * The invitation is bound to the invited address: a different account that
   * somehow obtained the link cannot redeem it.
   */
  userEmail: string;
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

    const notFound = (): Result<AcceptInvitationOutput, DomainError> =>
      err(new NotFound('Invitation not found or already used.'));

    if (typeof input.token !== 'string' || input.token.length === 0) return notFound();

    // Only the hash is stored; look up by hash of the presented token.
    const invitation = await invitationRepo.findByToken(hashInvitationToken(input.token));
    if (!invitation) return notFound();

    // Bind to the invited email. Same response as "unknown token" so the
    // endpoint can't be used to probe which tokens exist.
    if (
      typeof input.userEmail !== 'string' ||
      input.userEmail.trim().toLowerCase() !== invitation.email.trim().toLowerCase()
    ) {
      return notFound();
    }

    const now = clock.now();
    if (new Date(invitation.expiresAt) < now) {
      await invitationRepo.deleteById(invitation.id);
      return err(new Unauthorized('Invitation has expired.'));
    }

    const existing = await membershipRepo.findByOrgAndUser(invitation.orgId, input.userId);
    if (existing) {
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
