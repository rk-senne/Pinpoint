// login use case (Phase 1.5 / task 4.7.1).
//
// Implements `POST /api/auth/login`. Returns the authenticated `User`
// plus a freshly-minted access token
// (the JWT used for both the dashboard `fl_session` cookie and the
// extension Bearer header) and a fresh CSRF token. Cookie composition,
// `Set-Cookie` headers, and Express plumbing live in the inbound
// adapter — this layer just produces the values.
//
// Errors:
//   - `Unauthorized` when the user does not exist, the password
//     mismatches, or the account is unverified (Req 20.4 / task 6.4).
//     The same error class is used for "user not found" and "password
//     mismatch" so the inbound adapter cannot accidentally leak which
//     of the two failed and enable account enumeration.

import { randomBytes } from 'node:crypto';
import { Unauthorized, Validation, err, ok } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { PasswordHasher } from '../ports/PasswordHasher.js';
import type { TokenIssuer } from '../ports/TokenIssuer.js';
import type { MembershipRepo } from '../ports/MembershipRepo.js';
import type { UserRepo } from '../../user/ports/UserRepo.js';
import type { User } from '../../user/User.js';

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginOutput {
  user: User;
  /** JWT access token. The adapter renders it as both `fl_session` cookie and body bearer. */
  token: string;
  /** Per-session CSRF nonce paired with the `fl_csrf` cookie (double-submit pattern). */
  csrfToken: string;
}

export interface LoginDeps {
  userRepo: UserRepo;
  passwordHasher: PasswordHasher;
  tokenIssuer: TokenIssuer;
  membershipRepo: MembershipRepo;
}

export class Login {
  constructor(private readonly deps: LoginDeps) {}

  async execute(
    input: LoginInput,
  ): Promise<Result<LoginOutput, DomainError>> {
    const { userRepo, passwordHasher, tokenIssuer, membershipRepo } = this.deps;

    if (
      typeof input.email !== 'string' ||
      typeof input.password !== 'string' ||
      input.email.length === 0 ||
      input.password.length === 0
    ) {
      return err(new Validation('Email and password are required.'));
    }

    const record = await userRepo.findByEmailWithSecret(
      input.email.toLowerCase(),
    );
    if (!record) {
      return err(new Unauthorized('Invalid email or password.'));
    }

    const matches = await passwordHasher.verify(
      input.password,
      record.passwordHash,
    );
    if (!matches) {
      return err(new Unauthorized('Invalid email or password.'));
    }

    if (record.verified === false) {
      return err(
        new Unauthorized(
          'Please verify your email before logging in.',
        ),
      );
    }

    const membership = await membershipRepo.findDefaultForUser(record.id);
    if (!membership) {
      return err(new Unauthorized('No organization membership found.'));
    }

    const token = tokenIssuer.sign({
      userId: record.id,
      email: record.email,
      orgId: membership.orgId,
      role: membership.role,
      tokenVersion: record.tokenVersion ?? 0,
    });
    const csrfToken = randomBytes(32).toString('hex');

    // Strip the password hash before handing the user back to the adapter.
    const user: User = {
      id: record.id,
      email: record.email,
      name: record.name,
      avatarUrl: record.avatarUrl,
      notificationPreferences: record.notificationPreferences,
      createdAt: record.createdAt,
    };

    return ok({ user, token, csrfToken });
  }
}
