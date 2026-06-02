import { randomBytes } from 'node:crypto';
import type { InvitationRepo } from '../ports/InvitationRepo.js';
import type { MembershipRepo } from '../../auth/ports/MembershipRepo.js';
import type { Clock } from '../../shared/ports/Clock.js';
import type { EventBus } from '../../shared/ports/EventBus.js';
import {
  Conflict,
  Forbidden,
  Validation,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

export interface InviteToOrgInput {
  actorUserId: string;
  actorRole: string;
  orgId: string;
  email: string;
  role?: string;
}

export interface InviteToOrgOutput {
  invitationId: string;
  token: string;
}

export interface InviteToOrgDeps {
  invitationRepo: InvitationRepo;
  membershipRepo: MembershipRepo;
  clock: Clock;
  eventBus: EventBus;
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class InviteToOrg {
  constructor(private readonly deps: InviteToOrgDeps) {}

  async execute(input: InviteToOrgInput): Promise<Result<InviteToOrgOutput, DomainError>> {
    const { invitationRepo, clock, eventBus } = this.deps;

    if (input.actorRole !== 'owner' && input.actorRole !== 'admin') {
      return err(new Forbidden('Only owners and admins can invite members.'));
    }

    const email = input.email.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return err(new Validation('A valid email is required.'));
    }

    const role = input.role ?? 'member';

    const existing = await invitationRepo.findByOrgAndEmail(input.orgId, email);
    if (existing) {
      return err(new Conflict('An invitation for this email already exists.'));
    }

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(clock.now().getTime() + INVITATION_TTL_MS).toISOString();

    const invitation = await invitationRepo.insert({
      orgId: input.orgId,
      email,
      role,
      token,
      expiresAt,
    });

    eventBus.emit({
      type: 'org.invitation_created',
      payload: { orgId: input.orgId, email, role, token },
    });

    return ok({ invitationId: invitation.id, token });
  }
}
