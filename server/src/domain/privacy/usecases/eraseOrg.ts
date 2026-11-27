// eraseOrg use case — deletes an organisation and everything it holds
// (projects, pages, annotations, comments, portals, rules, integrations,
// webhooks, API keys, memberships, …) plus the screenshot objects.
//
// Guards: owner role (checked against the LIVE membership role by the auth
// middleware), password re-authentication, the exact organisation name typed
// back, and no active paid subscription (cancel billing first so a customer
// is never left paying for a deleted workspace).

import { err, ok, Forbidden, NotFound } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { PasswordHasher } from '../../auth/ports/PasswordHasher.js';
import type { PrivacyRepo } from '../ports/PrivacyRepo.js';
import type { ScreenshotEraser } from '../ports/ScreenshotEraser.js';
import { ActiveSubscriptionBlocked, ConfirmationMismatch, InvalidReauthentication } from '../errors.js';

export interface EraseOrgInput {
  orgId: string;
  actorId: string;
  actorRole: string;
  password?: string | undefined;
  confirmEmail?: string | undefined;
  /** The organisation name, typed back by the owner. */
  confirmName: string;
}

export interface EraseOrgOutput {
  screenshotsDeleted: number;
  screenshotsFailed: number;
}

export interface EraseOrgDeps {
  repo: PrivacyRepo;
  passwordHasher: PasswordHasher;
  screenshotEraser: ScreenshotEraser;
}

export class EraseOrg {
  constructor(private readonly deps: EraseOrgDeps) {}

  async execute(input: EraseOrgInput): Promise<Result<EraseOrgOutput, DomainError>> {
    const { repo, passwordHasher, screenshotEraser } = this.deps;

    if (input.actorRole !== 'owner') {
      return err(new Forbidden('Only an organisation owner can delete the organisation.'));
    }
    const org = await repo.getOrg(input.orgId);
    if (!org) return err(new NotFound('Organisation not found.'));

    const auth = await repo.getUserAuth(input.actorId);
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

    if (input.confirmName.trim() !== org.name.trim()) {
      return err(new ConfirmationMismatch('The organisation name does not match.'));
    }
    if (org.hasActiveSubscription) {
      return err(new ActiveSubscriptionBlocked([{ orgId: org.id, orgName: org.name }]));
    }

    const outcome = await repo.eraseOrg(input.orgId, input.actorId);
    const erased = await screenshotEraser.deleteScreenshots(outcome.screenshotKeys);
    return ok({ screenshotsDeleted: erased.deleted, screenshotsFailed: erased.failed.length });
  }
}
