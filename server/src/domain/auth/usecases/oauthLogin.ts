// OAuthLogin use case — exchanges auth code with provider, finds or creates
// user + oauth_account, issues JWT + CSRF token (same shape as Login output).

import { randomBytes } from 'node:crypto';
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

    // 2. Check if a user with this email already exists → link
    const existingUser = await userRepo.findByEmail(profile.email);
    if (existingUser) {
      await oauthAccountRepo.insert({
        userId: existingUser.id,
        provider: input.provider,
        providerUserId: profile.id,
        email: profile.email,
      });
      // Auto-verify if they weren't already
      const secret = await userRepo.findByIdWithSecret(existingUser.id);
      if (secret && !secret.verified) {
        await userRepo.markVerified(existingUser.id);
      }
      return this.issueTokenForUser(existingUser.id);
    }

    // 3. Create new user (verified, no password) + oauth_account + org
    const newUser = await userRepo.insert({
      email: profile.email,
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
      email: profile.email,
    });

    return this.issueTokenForUser(newUser.id);
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
