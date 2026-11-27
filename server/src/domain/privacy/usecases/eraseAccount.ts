// eraseAccount use case — GDPR Art. 17 / UK GDPR / POPIA s.24 / CCPA §1798.105.
//
// Pipeline (all preconditions BEFORE anything is deleted):
//   1. Re-authenticate: the account password (or, for password-less OAuth
//      accounts, the account e-mail typed back).
//   2. Refuse when the user is the only owner of an org that still has other
//      members (they must transfer ownership first) or when an org that would
//      be deleted with the account still has an active paid subscription.
//   3. Erase in one DB transaction (PrivacyRepo.eraseAccount).
//   4. After commit, delete the screenshots of orgs that were deleted with the
//      account. Content the user authored in orgs that remain is anonymised
//      and RETAINED for that org (processor-retained record).

import { err, ok, NotFound } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { PasswordHasher } from '../../auth/ports/PasswordHasher.js';
import type { PrivacyRepo } from '../ports/PrivacyRepo.js';
import type { ScreenshotEraser } from '../ports/ScreenshotEraser.js';
import { ActiveSubscriptionBlocked, ConfirmationMismatch, InvalidReauthentication, SoleOwnerBlocked } from '../errors.js';

export interface EraseAccountInput {
  userId: string;
  password?: string | undefined;
  /** Only for accounts without a password (OAuth sign-in). */
  confirmEmail?: string | undefined;
}

export interface EraseAccountOutput {
  orgsDeleted: number;
  orgsLeft: number;
  screenshotsDeleted: number;
  /** Object keys that could not be deleted (operator follow-up). */
  screenshotsFailed: number;
}

export interface EraseAccountDeps {
  repo: PrivacyRepo;
  passwordHasher: PasswordHasher;
  screenshotEraser: ScreenshotEraser;
}

export class EraseAccount {
  constructor(private readonly deps: EraseAccountDeps) {}

  async execute(input: EraseAccountInput): Promise<Result<EraseAccountOutput, DomainError>> {
    const { repo, passwordHasher, screenshotEraser } = this.deps;

    const auth = await repo.getUserAuth(input.userId);
    if (!auth) return err(new NotFound('Account not found.'));

    if (auth.passwordHash) {
      if (!input.password || !(await passwordHasher.verify(input.password, auth.passwordHash))) {
        return err(new InvalidReauthentication());
      }
    } else if (
      !input.confirmEmail ||
      input.confirmEmail.trim().toLowerCase() !== auth.email.trim().toLowerCase()
    ) {
      return err(new ConfirmationMismatch('Type your account e-mail address to confirm.'));
    }

    const memberships = await repo.getUserMemberships(input.userId);
    const blocked = memberships.filter((m) => m.role === 'owner' && m.ownerCount <= 1 && m.memberCount > 1);
    if (blocked.length > 0) {
      return err(
        new SoleOwnerBlocked(
          blocked.map((m) => ({ orgId: m.orgId, orgName: m.orgName, memberCount: m.memberCount })),
        ),
      );
    }
    const wouldDelete = memberships.filter((m) => m.memberCount <= 1 && m.role === 'owner');
    const paid = wouldDelete.filter((m) => m.hasActiveSubscription);
    if (paid.length > 0) {
      return err(new ActiveSubscriptionBlocked(paid.map((m) => ({ orgId: m.orgId, orgName: m.orgName }))));
    }

    const outcome = await repo.eraseAccount(input.userId);
    if ('blockedOrgs' in outcome) {
      const orgs = memberships.filter((m) => outcome.blockedOrgs.includes(m.orgId));
      return err(
        new SoleOwnerBlocked(
          orgs.map((m) => ({ orgId: m.orgId, orgName: m.orgName, memberCount: m.memberCount })),
        ),
      );
    }

    const erased = await screenshotEraser.deleteScreenshots(outcome.screenshotKeys);
    return ok({
      orgsDeleted: outcome.orgsDeleted.length,
      orgsLeft: outcome.orgsLeft.length,
      screenshotsDeleted: erased.deleted,
      screenshotsFailed: erased.failed.length,
    });
  }
}
