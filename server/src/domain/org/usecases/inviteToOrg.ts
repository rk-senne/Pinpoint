import { createHash, randomBytes } from 'node:crypto';
import type { InvitationRepo } from '../ports/InvitationRepo.js';
import type { MembershipRepo } from '../../auth/ports/MembershipRepo.js';
import type { Clock } from '../../shared/ports/Clock.js';
import type { EventBus } from '../../shared/ports/EventBus.js';
import type { Mailer } from '../../notification/ports/Mailer.js';
import { buildInvitationEmail } from './invitationEmail.js';
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
  /** Display names used only for the invitation email. */
  orgName?: string;
  inviterName?: string;
}

export interface InviteToOrgOutput {
  invitationId: string;
  /**
   * Raw invitation token. Exists only so the caller can deliver it (the use
   * case already emails it when a mailer is wired). Inbound adapters MUST NOT
   * put it in an API response — only its hash is stored.
   */
  token: string;
  email: string;
  role: string;
  expiresAt: string;
}

export interface InviteToOrgDeps {
  invitationRepo: InvitationRepo;
  membershipRepo: MembershipRepo;
  clock: Clock;
  eventBus: EventBus;
  /** When wired, the invitation link is delivered by email. */
  mailer?: Mailer;
  /** Base URL of the dashboard, used to build the accept link. */
  appUrl?: string;
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const INVITABLE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

/** Invitation tokens are stored as SHA-256 hex; the raw value only travels by email. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class InviteToOrg {
  constructor(private readonly deps: InviteToOrgDeps) {}

  async execute(input: InviteToOrgInput): Promise<Result<InviteToOrgOutput, DomainError>> {
    const { invitationRepo, clock, eventBus, mailer } = this.deps;

    if (input.actorRole !== 'owner' && input.actorRole !== 'admin') {
      return err(new Forbidden('Only owners and admins can invite members.'));
    }

    const email = input.email.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return err(new Validation('A valid email is required.'));
    }

    const role = input.role ?? 'member';
    if (!(INVITABLE_ROLES as readonly string[]).includes(role)) {
      return err(new Validation('Invalid role.'));
    }
    // Privilege ceiling: nobody can hand out a role above their own. Only an
    // owner may mint another owner.
    if (role === 'owner' && input.actorRole !== 'owner') {
      return err(new Forbidden('Only owners can invite someone as owner.'));
    }

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
      token: hashInvitationToken(token),
      expiresAt,
    });

    // Never put the raw token on the event bus (it fans out to sockets /
    // webhooks); delivery goes through the mailer below.
    eventBus.emit({
      type: 'org.invitation_created',
      room: `org:${input.orgId}`,
      payload: { orgId: input.orgId, email, role, invitationId: invitation.id },
    });

    if (mailer) {
      const base = (this.deps.appUrl ?? '').replace(/\/+$/, '');
      const { subject, html } = buildInvitationEmail({
        orgName: input.orgName ?? 'an organization',
        inviterName: input.inviterName ?? 'A teammate',
        role,
        acceptUrl: `${base}/invitations/accept?token=${token}`,
      });
      try {
        await mailer.send({ to: email, subject, body: html });
      } catch {
        // Delivery failure must not leak the token; the inviter can delete
        // the invitation and retry.
      }
    }

    return ok({ invitationId: invitation.id, token, email, role, expiresAt });
  }
}
