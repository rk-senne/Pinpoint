// resendVerification use case (F-17).
//
// Implements `POST /api/v1/auth/resend-verification`. For an existing,
// still-unverified account it invalidates outstanding `verify_email` tokens,
// mints a fresh single-use token and enqueues a `verify_email` notification
// through the durable queue. For every other input (unknown email, already
// verified, malformed) it does nothing visible. The result is ALWAYS
// `ok({ requested: true })` so the endpoint is not an account-enumeration
// oracle; the unknown-email path performs a comparable token-table read to
// keep timing close.

import { randomBytes, createHash } from 'node:crypto';
import { ok } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { Clock } from '../../shared/ports/Clock.js';
import type { AuthTokenRepo } from '../ports/AuthTokenRepo.js';
import type { NotificationQueue } from '../../notification/ports/NotificationQueue.js';
import type { UserRepo } from '../../user/ports/UserRepo.js';
import { VERIFY_EMAIL_TOKEN_TTL_MS } from './registerUser.js';

export interface ResendVerificationInput {
  email: string;
}

export interface ResendVerificationOutput {
  /** Always true; never reveals whether an email was actually sent. */
  requested: true;
}

export interface ResendVerificationDeps {
  userRepo: UserRepo;
  authTokenRepo: AuthTokenRepo;
  notificationQueue: NotificationQueue;
  clock: Clock;
  buildVerifyEmailLink: (rawToken: string) => string;
}

export class ResendVerification {
  constructor(private readonly deps: ResendVerificationDeps) {}

  async execute(
    input: ResendVerificationInput,
  ): Promise<Result<ResendVerificationOutput, DomainError>> {
    const { userRepo, authTokenRepo, notificationQueue, clock, buildVerifyEmailLink } = this.deps;

    if (typeof input.email !== 'string' || input.email.length === 0) {
      return ok({ requested: true });
    }

    const record = await userRepo.findByEmailWithSecret(input.email.trim().toLowerCase());
    if (!record || record.verified) {
      await authTokenRepo.findValid(
        createHash('sha256').update(randomBytes(32)).digest('hex'),
        'verify_email',
        clock.now(),
      );
      return ok({ requested: true });
    }

    // Only the newest link should work.
    await authTokenRepo.markAllUsedForUser(record.id, 'verify_email');

    const rawToken = randomBytes(32).toString('hex');
    await authTokenRepo.insert({
      userId: record.id,
      kind: 'verify_email',
      tokenHash: createHash('sha256').update(rawToken).digest('hex'),
      expiresAt: new Date(clock.now().getTime() + VERIFY_EMAIL_TOKEN_TTL_MS).toISOString(),
    });

    await notificationQueue.enqueue(
      {
        kind: 'verify_email',
        recipientUserId: record.id,
        recipientEmail: record.email,
        link: buildVerifyEmailLink(rawToken),
      },
      clock.now(),
    );

    return ok({ requested: true });
  }
}
