// Account-linking policy tests for OAuthLogin (F-16).

import { describe, it, expect } from 'vitest';

import {
  FakeAuthTokenRepo,
  FakeClock,
  FakeMembershipRepo,
  FakePasswordHasher,
  FakeTokenIssuer,
  FakeUserRepo,
} from '../../../__tests__/fakes/index.js';
import {
  OAuthLogin,
  type OAuthAccount,
  type OAuthAccountRepo,
  type OAuthProfile,
} from '../usecases/oauthLogin.js';

class FakeOAuthAccountRepo implements OAuthAccountRepo {
  readonly rows: OAuthAccount[] = [];
  async findByProviderAndId(provider: string, providerUserId: string) {
    return this.rows.find((r) => r.provider === provider && r.providerUserId === providerUserId) ?? null;
  }
  async insert(input: { userId: string; provider: string; providerUserId: string; email?: string }) {
    const row: OAuthAccount = { id: `oa-${this.rows.length + 1}`, createdAt: new Date().toISOString(), ...input };
    this.rows.push(row);
    return row;
  }
}

function build(profile: OAuthProfile) {
  const clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
  const userRepo = new FakeUserRepo(clock);
  const authTokenRepo = new FakeAuthTokenRepo(clock);
  const membershipRepo = new FakeMembershipRepo();
  const oauthAccountRepo = new FakeOAuthAccountRepo();
  const passwordHasher = new FakePasswordHasher();
  const usecase = new OAuthLogin({
    providers: {
      google: {
        getAuthorizationUrl: () => '',
        exchangeCode: async () => 'access',
        getProfile: async () => profile,
      },
    },
    oauthAccountRepo,
    userRepo,
    tokenIssuer: new FakeTokenIssuer(clock),
    membershipRepo,
    passwordHasher,
    authTokenRepo,
    createOrgAndMembership: async (userId) => {
      membershipRepo.seed({ orgId: 'org-new', userId, role: 'owner' });
      return 'org-new';
    },
  });
  return { usecase, userRepo, authTokenRepo, membershipRepo, oauthAccountRepo, clock };
}

const run = (u: OAuthLogin) => u.execute({ provider: 'google', code: 'c', redirectUri: 'r' });
const PROFILE: OAuthProfile = { id: 'g-1', email: 'victim@example.com', name: 'Victim', emailVerified: true };

describe('OAuthLogin — F-16 account linking', () => {
  it('rejects (fail closed) when the provider does not assert a verified email', async () => {
    for (const emailVerified of [false, undefined]) {
      const { usecase, userRepo, oauthAccountRepo } = build({ ...PROFILE, emailVerified });
      const res = await run(usecase);
      expect(res.ok).toBe(false);
      expect(userRepo.users.size).toBe(0);
      expect(oauthAccountRepo.rows).toHaveLength(0);
    }
  });

  it('does not link/log in to an existing account on an unverified provider email', async () => {
    const { usecase, userRepo, oauthAccountRepo } = build({ ...PROFILE, emailVerified: false });
    await userRepo.insert({ email: 'victim@example.com', name: 'V', passwordHash: 'hashed:pw', verified: true });
    const res = await run(usecase);
    expect(res.ok).toBe(false);
    expect(oauthAccountRepo.rows).toHaveLength(0);
  });

  it('links to an existing VERIFIED account without touching its password', async () => {
    const { usecase, userRepo, membershipRepo, oauthAccountRepo } = build(PROFILE);
    const u = await userRepo.insert({ email: 'victim@example.com', name: 'V', passwordHash: 'hashed:pw', verified: true });
    membershipRepo.seed({ orgId: 'org-1', userId: u.id, role: 'owner' });

    const res = await run(usecase);
    expect(res.ok).toBe(true);
    expect(oauthAccountRepo.rows).toHaveLength(1);
    expect(oauthAccountRepo.rows[0]!.userId).toBe(u.id);
    expect(userRepo.users.get(u.id)!.passwordHash).toBe('hashed:pw');
  });

  it('pre-hijack: takes over an attacker-created UNVERIFIED account (password killed, sessions + tokens revoked, then verified)', async () => {
    const { usecase, userRepo, membershipRepo, authTokenRepo, oauthAccountRepo, clock } = build(PROFILE);
    // Attacker registered the victim's address with a password they know.
    const attacker = await userRepo.insert({
      email: 'victim@example.com',
      name: 'Mallory',
      passwordHash: 'hashed:attacker-password',
      verified: false,
    });
    membershipRepo.seed({ orgId: 'org-1', userId: attacker.id, role: 'owner' });
    await authTokenRepo.insert({
      userId: attacker.id,
      kind: 'reset_password',
      tokenHash: 'attacker-reset',
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    const versionBefore = userRepo.users.get(attacker.id)!.tokenVersion;

    const res = await run(usecase);
    expect(res.ok).toBe(true);

    const after = userRepo.users.get(attacker.id)!;
    expect(after.passwordHash).not.toBe('hashed:attacker-password');
    // The attacker's password no longer verifies.
    expect(await new FakePasswordHasher().verify('attacker-password', after.passwordHash)).toBe(false);
    expect(after.verified).toBe(true);
    expect(after.tokenVersion).toBe(versionBefore + 1);
    expect([...authTokenRepo.tokens.values()].every((t) => t.used)).toBe(true);
    expect(oauthAccountRepo.rows[0]!.userId).toBe(attacker.id);
  });

  it('creates a verified new user only when the provider verified the email', async () => {
    const { usecase, userRepo } = build({ ...PROFILE, email: 'Fresh@Example.com' });
    const res = await run(usecase);
    expect(res.ok).toBe(true);
    const [u] = [...userRepo.users.values()];
    expect(u!.email).toBe('fresh@example.com');
    expect(u!.verified).toBe(true);
  });

  it('an already-linked identity still logs in (no profile-email re-check needed)', async () => {
    const { usecase, userRepo, membershipRepo, oauthAccountRepo } = build({ ...PROFILE, emailVerified: undefined });
    const u = await userRepo.insert({ email: 'victim@example.com', name: 'V', passwordHash: 'x', verified: true });
    membershipRepo.seed({ orgId: 'org-1', userId: u.id, role: 'owner' });
    await oauthAccountRepo.insert({ userId: u.id, provider: 'google', providerUserId: 'g-1' });
    expect((await run(usecase)).ok).toBe(true);
  });
});
