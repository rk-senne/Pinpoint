// updateProfile use case (Phase 1.5 / Wave 2 follow-up).
//
// Implements `PUT /api/v1/users/me`. Patches the authenticated user's
// `name`, `email`, and / or `avatarUrl`. At least one field must be
// supplied; each supplied field is validated independently.
//
// Errors:
//   - `Validation` when the patch is empty, when a string field is
//     blank, or when `avatarUrl` has the wrong type.
//   - `Conflict` when changing `email` collides with another account
//     (Req 1.5 — emails are unique).
//   - `NotFound` when the user disappeared between the auth check and
//     the patch (deleted account or stale token).

import { createHash, randomBytes } from 'node:crypto';
import {
  Forbidden,
  NotFound,
  Validation,
  err,
  ok,
} from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { UserRepo } from '../ports/UserRepo.js';
import type { PasswordHasher } from '../../auth/ports/PasswordHasher.js';
import type { AuthTokenRepo } from '../../auth/ports/AuthTokenRepo.js';
import type { Mailer } from '../../notification/ports/Mailer.js';
import type { Clock } from '../../shared/ports/Clock.js';
import type { Logger } from '../../shared/ports/Logger.js';
import type { User, UserPatch } from '../User.js';

export interface UpdateProfileInput {
  userId: string;
  name?: string;
  email?: string;
  avatarUrl?: string | null;
  /** Required whenever `email` differs from the current address (PP-06). */
  currentPassword?: string;
}

export interface UpdateProfileOutput {
  user: User;
  /** Set when an e-mail change was requested: the login e-mail has NOT changed yet. */
  emailChange?: { pendingEmail: string };
}

export interface UpdateProfileDeps {
  userRepo: UserRepo;
  /** PP-06 collaborators; without them an e-mail change is refused (fail closed). */
  passwordHasher?: PasswordHasher;
  authTokenRepo?: AuthTokenRepo;
  mailer?: Mailer;
  clock?: Clock;
  logger?: Logger;
  /** Builds the dashboard link the new address must open to confirm. */
  buildConfirmLink?: (rawToken: string) => string;
}

const EMAIL_CHANGE_TTL_MS = 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>",;:()[\]\\]+@[^\s@<>",;:()[\]\\]+\.[^\s@<>",;:()[\]\\]{2,}$/;
const MAX_NAME = 100;
const MAX_AVATAR_URL = 1024;

/** PP-19: avatars are https-only (no data:/javascript:/http: tracking or mixed content). */
export function isAllowedAvatarUrl(value: string): boolean {
  if (value.length > MAX_AVATAR_URL) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

export class UpdateProfile {
  constructor(private readonly deps: UpdateProfileDeps) {}

  async execute(
    input: UpdateProfileInput,
  ): Promise<Result<UpdateProfileOutput, DomainError>> {
    const { userRepo } = this.deps;
    const patch: UserPatch = {};

    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || input.name.trim().length === 0) {
        return err(new Validation('Name must be a non-empty string.'));
      }
      if (input.name.trim().length > MAX_NAME) {
        return err(new Validation(`Name must be at most ${MAX_NAME} characters.`));
      }
      patch.name = input.name.trim();
    }

    // PP-06: the login e-mail is never changed here. A different address is
    // stored as `pending_email`, confirmed via a link mailed to the NEW address
    // and announced to the OLD one; it takes effect (and revokes sessions) only
    // on confirmation. Requires the current password (re-authentication).
    let pendingEmail: string | null = null;
    let emailRequest: { current: User; normalized: string; secret: { passwordHash: string } } | null = null;
    if (input.email !== undefined) {
      if (typeof input.email !== 'string' || input.email.trim().length === 0) {
        return err(new Validation('Email must be a non-empty string.'));
      }
      const normalizedEmail = input.email.toLowerCase().trim();
      if (normalizedEmail.length > 254 || !EMAIL_RE.test(normalizedEmail)) {
        return err(new Validation('Email address is not valid.'));
      }
      const current = await userRepo.findByIdWithSecret(input.userId);
      if (!current) return err(new NotFound('User not found.'));
      if (normalizedEmail !== current.email.toLowerCase()) {
        const { passwordHasher, authTokenRepo, mailer } = this.deps;
        if (!passwordHasher || !authTokenRepo || !mailer) {
          return err(new Forbidden('Email changes are not available.'));
        }
        if (typeof input.currentPassword !== 'string' || input.currentPassword.length === 0) {
          return err(new Validation('Your current password is required to change your email.'));
        }
        if (!current.passwordHash || !(await passwordHasher.verify(input.currentPassword, current.passwordHash))) {
          return err(new Forbidden('Current password is incorrect.'));
        }
        emailRequest = { current, normalized: normalizedEmail, secret: current };
        pendingEmail = normalizedEmail;
      }
    }

    if (input.avatarUrl !== undefined) {
      if (input.avatarUrl !== null && typeof input.avatarUrl !== 'string') {
        return err(new Validation('Avatar URL must be a string or null.'));
      }
      if (input.avatarUrl !== null && !isAllowedAvatarUrl(input.avatarUrl)) {
        return err(new Validation('Avatar URL must be an https:// URL of at most 1024 characters.'));
      }
      patch.avatarUrl = input.avatarUrl;
    }

    if (Object.keys(patch).length === 0 && !emailRequest) {
      // `email` equal to the current address is a no-op, not an error, so the
      // dashboard can keep sending the whole profile form.
      if (input.email === undefined) {
        return err(new Validation('No valid fields provided for update.'));
      }
    }

    // Confirm the user exists before issuing the update so we can return
    // a meaningful `NotFound` instead of relying on the repo throwing.
    const existing = await userRepo.findById(input.userId);
    if (!existing) {
      return err(new NotFound('User not found.'));
    }

    const user = Object.keys(patch).length > 0 ? await userRepo.update(input.userId, patch) : existing;

    if (emailRequest && pendingEmail) {
      await this.requestEmailChange(emailRequest.current, pendingEmail);
      return ok({ user, emailChange: { pendingEmail } });
    }
    return ok({ user });
  }

  /**
   * Mint the confirmation token and mail both addresses. An address that already
   * belongs to another account is NOT reported (no account oracle): the request
   * silently does nothing, exactly like the success path from the caller's view.
   */
  private async requestEmailChange(current: User, newEmail: string): Promise<void> {
    const { userRepo, authTokenRepo, mailer, clock, logger, buildConfirmLink } = this.deps;
    if (!authTokenRepo || !mailer) return;
    const taken = await userRepo.findByEmail(newEmail);
    if (taken && taken.id !== current.id) return;

    const now = clock ? clock.now() : new Date();
    await authTokenRepo.markAllUsedForUser(current.id, 'change_email');
    await userRepo.setPendingEmail(current.id, newEmail);
    const rawToken = randomBytes(32).toString('hex');
    await authTokenRepo.insert({
      userId: current.id,
      kind: 'change_email',
      tokenHash: createHash('sha256').update(rawToken).digest('hex'),
      expiresAt: new Date(now.getTime() + EMAIL_CHANGE_TTL_MS).toISOString(),
    });
    const link = buildConfirmLink ? buildConfirmLink(rawToken) : rawToken;
    // Plain text only; CR/LF stripped from anything interpolated into headers.
    const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ');
    try {
      await mailer.send({
        to: newEmail,
        subject: 'Confirm your new Pinpoint email address',
        body: `Someone requested to change the Pinpoint login email of ${oneLine(current.email)} to this address. Open the following link within one hour to confirm: ${link}\n\nIf this was not you, ignore this message.`,
      });
      await mailer.send({
        to: current.email,
        subject: 'A change of your Pinpoint email was requested',
        body: `A change of your login email to ${oneLine(newEmail)} was requested. Nothing changes until that address confirms. If this was not you, change your password now.`,
      });
    } catch (error: unknown) {
      logger?.error({ err: error, userId: current.id }, 'Failed to send email-change messages');
    }
  }
}
