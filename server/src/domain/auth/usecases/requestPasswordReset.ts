// requestPasswordReset use case (Phase 1.5 / task 4.7.1).
//
// Implements `POST /api/auth/reset-password`. Issues a single-use
// `reset_password` token and mails the reset link via the `Mailer`
// port. The use case persists through `AuthTokenRepo` with
// `kind='reset_password'`.
//
// Per Req 1 (no email enumeration), the use case ALWAYS resolves with
// a successful `Result.ok` regardless of whether the email matched a
// real account. The inbound adapter therefore renders the same generic
// 200 response in either case.
//
// We mail directly through `Mailer` rather than enqueueing into the
// notification queue so that "I didn't get the email" issues are
// debuggable from a single SMTP log line during a reset incident; the
// dispatcher path is reserved for fan-out heavy events (annotations,
// comments, mentions). This matches the imperative implementation
// today (`sendResetEmail` is invoked inline, not via `enqueue`).

import { randomBytes, createHash } from 'node:crypto';
import { ok } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { Clock } from '../../shared/ports/Clock.js';
import type { AuthTokenRepo } from '../ports/AuthTokenRepo.js';
import type { UserRepo } from '../../user/ports/UserRepo.js';
import type { Mailer } from '../../notification/ports/Mailer.js';

/** TTL for the issued `reset_password` token. */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export interface RequestPasswordResetInput {
  email: string;
}

export interface RequestPasswordResetOutput {
  /** Always true. The use case never reveals whether `email` matched a real user. */
  emailDispatched: true;
}

export interface RequestPasswordResetDeps {
  userRepo: UserRepo;
  authTokenRepo: AuthTokenRepo;
  mailer: Mailer;
  clock: Clock;
  /** Composition root supplies the absolute reset link. */
  buildResetLink: (rawToken: string) => string;
}

export class RequestPasswordReset {
  constructor(private readonly deps: RequestPasswordResetDeps) {}

  async execute(
    input: RequestPasswordResetInput,
  ): Promise<Result<RequestPasswordResetOutput, DomainError>> {
    const { userRepo, authTokenRepo, mailer, clock, buildResetLink } =
      this.deps;

    // Bad input still resolves with the generic success shape; we just
    // skip the lookup. This keeps the no-enumeration property intact:
    // a malformed body and an unknown email are observably identical.
    if (typeof input.email !== 'string' || input.email.length === 0) {
      return ok({ emailDispatched: true });
    }

    const user = await userRepo.findByEmail(input.email.toLowerCase());
    if (!user) {
      return ok({ emailDispatched: true });
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(
      clock.now().getTime() + RESET_TOKEN_TTL_MS,
    ).toISOString();

    await authTokenRepo.insert({
      userId: user.id,
      kind: 'reset_password',
      tokenHash,
      expiresAt,
    });

    const link = buildResetLink(rawToken);
    await mailer.send({
      to: user.email,
      subject: 'Reset your Pinpoint password',
      body: `A password reset was requested for your account. Visit the following link within the next hour to choose a new password: ${link}`,
    });

    return ok({ emailDispatched: true });
  }
}
