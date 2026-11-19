// OAuthLogin use case — exchanges auth code with provider, finds or creates
// user + oauth_account, issues JWT + CSRF token (same shape as Login output).
//
// Account-linking policy (F-16 — pre-hijack / account-takeover hardening):
//
//   * The provider must ASSERT that the profile email is verified
//     (`OAuthProfile.emailVerified === true`). Anything else — including a
//     provider adapter that doesn't report it — fails closed; we never link
//     to, create, or log into an account on an unverified provider email.
//   * An already-linked (provider, providerUserId) identity logs in as before.
//   * Email matches an existing, VERIFIED local account → link the identity
//     and log in (both sides have proven control of the mailbox).
//   * Email matches an existing, UNVERIFIED local account → this is the
//     classic pre-hijack setup (an attacker registered the victim's address
//     with a password they know, hoping the victim later signs in with
//     OAuth). Nobody has proven control of that mailbox except the provider
//     just now, so we TAKE THE ACCOUNT OVER: replace the password hash with
//     an unusable random one (the attacker's password stops working), bump
//     the token version (kills any session), void every outstanding
//     verify_email / reset_password token, mark the account verified, then
//     link. We chose takeover over refusing to link because refusing would
//     lock the real owner out of their own address until the attacker's row
//     expires, while takeover leaves the attacker with nothing.

import { randomBytes } from 'node:crypto';
import type { PasswordHasher } from '../ports/PasswordHasher.js';
import type { AuthTokenRepo } from '../ports/AuthTokenRepo.js';
import { Unauthorized, err, ok } from '../../shared/DomainError.js';
import type { DomainError, Result } from '../../shared/DomainError.js';
import type { TokenIssuer } from '../ports/TokenIssuer.js';
import type { MembershipRepo } from '../ports/MembershipRepo.js';
import type { UserRepo } from '../../user/ports/UserRepo.js';
import type { User } from '../../user/User.js';

// --- Port interfaces (co-located for minimal file count) -----------------

export interface OAuthProfile {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  /**
   * True only when the PROVIDER asserts it verified `email` (Google
   * `email_verified`, GitHub verified-primary). Adapters must set this; when
   * absent the login is rejected (fail closed).
   */
  emailVerified?: boolean;
}

export interface OAuthProvider {
  getAuthorizationUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  getProfile(accessToken: string): Promise<OAuthProfile>;
}

export interface OAuthAccount {
  id: string;
  userId: string;
  provider: string;
  providerUserId: string;
  email?: string;
  createdAt: string;
}

export interface OAuthAccountRepo {
  findByProviderAndId(provider: string, providerUserId: string): Promise<OAuthAccount | null>;
  insert(input: { userId: string; provider: string; providerUserId: string; email?: string }): Promise<OAuthAccount>;
}

// --- Use case ------------------------------------------------------------

export interface OAuthLoginInput {
  provider: 'google' | 'github';
  code: string;
  redirectUri: string;
}

export interface OAuthLoginOutput {
  user: User;
  token: string;
  csrfToken: string;
}

export interface OAuthLoginDeps {
  providers: Record<string, OAuthProvider>;
  oauthAccountRepo: OAuthAccountRepo;
  userRepo: UserRepo;
  tokenIssuer: TokenIssuer;
  membershipRepo: MembershipRepo;
  /** Hash a random value into an unusable password during pre-hijack takeover. */
  passwordHasher: PasswordHasher;
  /** Used to void outstanding verify/reset tokens during takeover. */
  authTokenRepo: AuthTokenRepo;
  /** Knex-level org+membership creation for new OAuth users. */
  createOrgAndMembership: (userId: string, userName: string) => Promise<string>;
}

export class OAuthLogin {
  constructor(private readonly deps: OAuthLoginDeps) {}

  async execute(input: OAuthLoginInput): Promise<Result<OAuthLoginOutput, DomainError>> {
    const { providers, oauthAccountRepo, userRepo, tokenIssuer, membershipRepo } = this.deps;

    const provider = providers[input.provider];
    if (!provider) {
      return err(new Unauthorized('OAuth provider not configured.'));
    }

    let accessToken: string;
    try {
      accessToken = await provider.exchangeCode(input.code, input.redirectUri);
    } catch {
      return err(new Unauthorized('Failed to exchange OAuth code.'));
    }

    let profile: OAuthProfile;
    try {
      profile = await provider.getProfile(accessToken);
    } catch {
      return err(new Unauthorized('Failed to fetch OAuth profile.'));
    }

    // 1. Check if this OAuth account is already linked
    const existing = await oauthAccountRepo.findByProviderAndId(input.provider, profile.id);
    if (existing) {
      return this.issueTokenForUser(existing.userId);
    }

    // Everything below links/creates by EMAIL, so the provider must vouch for it.
    if (profile.emailVerified !== true || !profile.email) {
      return err(new Unauthorized('OAuth provider did not verify the email address.'));
    }
    const email = profile.email.trim().toLowerCase();

    // 2. Check if a user with this email already exists → link (see policy above)
    const existingUser = await userRepo.findByEmail(email);
    if (existingUser) {
      const secret = await userRepo.findByIdWithSecret(existingUser.id);
      if (!secret) {
        return err(new Unauthorized('User not found.'));
      }
      if (!secret.verified) {
        await this.takeOverUnverifiedAccount(existingUser.id);
      }
      await oauthAccountRepo.insert({
        userId: existingUser.id,
        provider: input.provider,
        providerUserId: profile.id,
        email,
      });
      return this.issueTokenForUser(existingUser.id);
    }

    // 3. Create new user (verified, no password) + oauth_account + org
    const newUser = await userRepo.insert({
      email,
      name: profile.name,
      passwordHash: '', // placeholder — column is now nullable, PgUserRepo will store NULL
      verified: true,
    });

    // Create default org + membership
    await this.deps.createOrgAndMembership(newUser.id, newUser.name);

    await oauthAccountRepo.insert({
      userId: newUser.id,
      provider: input.provider,
      providerUserId: profile.id,
      email,
    });

    return this.issueTokenForUser(newUser.id);
  }

  /**
   * Pre-hijack neutralisation for a local account nobody has verified: make
   * the existing credentials and sessions worthless, then mark it verified.
   */
  private async takeOverUnverifiedAccount(userId: string): Promise<void> {
    const { userRepo, passwordHasher, authTokenRepo } = this.deps;
    const unusable = await passwordHasher.hash(randomBytes(32).toString('hex'));
    await userRepo.update(userId, { passwordHash: unusable });
    await userRepo.incrementTokenVersion(userId);
    await authTokenRepo.markAllUsedForUser(userId, 'verify_email');
    await authTokenRepo.markAllUsedForUser(userId, 'reset_password');
    await userRepo.markVerified(userId);
  }

  private async issueTokenForUser(userId: string): Promise<Result<OAuthLoginOutput, DomainError>> {
    const { userRepo, tokenIssuer, membershipRepo } = this.deps;

    const user = await userRepo.findById(userId);
    if (!user) {
      return err(new Unauthorized('User not found.'));
    }

    const membership = await membershipRepo.findDefaultForUser(userId);
    if (!membership) {
      return err(new Unauthorized('No organization membership found.'));
    }

    const secret = await userRepo.findByIdWithSecret(userId);
    const token = tokenIssuer.sign({
      userId: user.id,
      email: user.email,
      orgId: membership.orgId,
      role: membership.role,
      tokenVersion: secret?.tokenVersion ?? 0,
    });
    const csrfToken = randomBytes(32).toString('hex');

    return ok({ user, token, csrfToken });
  }
}
