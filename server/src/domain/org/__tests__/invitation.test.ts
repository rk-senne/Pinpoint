import { describe, it, expect, beforeEach } from 'vitest';
import { FakeClock, FakeEventBus, FakeMailer, FakeMembershipRepo } from '../../../__tests__/fakes/index.js';
import { InviteToOrg, hashInvitationToken } from '../usecases/inviteToOrg.js';
import { AcceptInvitation } from '../usecases/acceptInvitation.js';
import type { InvitationRepo, Invitation, NewInvitation } from '../ports/InvitationRepo.js';

class FakeInvitationRepo implements InvitationRepo {
  private invitations: Invitation[] = [];
  private idCounter = 0;

  async insert(input: NewInvitation): Promise<Invitation> {
    const inv: Invitation = { id: `inv-${++this.idCounter}`, ...input, createdAt: new Date().toISOString() };
    this.invitations.push(inv);
    return inv;
  }
  async findByToken(token: string): Promise<Invitation | null> {
    return this.invitations.find((i) => i.token === token) ?? null;
  }
  async deleteById(id: string): Promise<void> {
    this.invitations = this.invitations.filter((i) => i.id !== id);
  }
  /** Test hook: what is actually stored. */
  all(): Invitation[] {
    return [...this.invitations];
  }
  async findByOrgAndEmail(orgId: string, email: string): Promise<Invitation | null> {
    return this.invitations.find((i) => i.orgId === orgId && i.email === email) ?? null;
  }
}

describe('Org invitation flow', () => {
  let invitationRepo: FakeInvitationRepo;
  let membershipRepo: FakeMembershipRepo;
  let clock: FakeClock;
  let eventBus: FakeEventBus;
  let invite: InviteToOrg;
  let accept: AcceptInvitation;

  beforeEach(() => {
    clock = new FakeClock(new Date('2024-06-01T00:00:00Z'));
    invitationRepo = new FakeInvitationRepo();
    membershipRepo = new FakeMembershipRepo();
    eventBus = new FakeEventBus();
    invite = new InviteToOrg({ invitationRepo, membershipRepo, clock, eventBus });
    accept = new AcceptInvitation({ invitationRepo, membershipRepo, clock });
  });

  it('owner can invite a user and they can accept', async () => {
    const result = await invite.execute({
      actorUserId: 'owner-1',
      actorRole: 'owner',
      orgId: 'org-1',
      email: 'new@example.com',
      role: 'member',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.token).toBeTruthy();

    // Accept
    const acceptResult = await accept.execute({
      token: result.value.token,
      userId: 'user-new',
      userEmail: 'new@example.com',
    });

    expect(acceptResult.ok).toBe(true);
    if (!acceptResult.ok) return;
    expect(acceptResult.value.membership.orgId).toBe('org-1');
    expect(acceptResult.value.membership.role).toBe('member');
  });

  it('rejects invitation from non-owner/admin', async () => {
    const result = await invite.execute({
      actorUserId: 'member-1',
      actorRole: 'member',
      orgId: 'org-1',
      email: 'new@example.com',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Forbidden');
  });

  it('rejects duplicate invitation', async () => {
    await invite.execute({
      actorUserId: 'owner-1',
      actorRole: 'owner',
      orgId: 'org-1',
      email: 'dup@example.com',
    });

    const result = await invite.execute({
      actorUserId: 'owner-1',
      actorRole: 'owner',
      orgId: 'org-1',
      email: 'dup@example.com',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Conflict');
  });

  it('rejects expired invitation', async () => {
    const result = await invite.execute({
      actorUserId: 'owner-1',
      actorRole: 'owner',
      orgId: 'org-1',
      email: 'expired@example.com',
    });
    if (!result.ok) return;

    // Advance clock past 7 days
    clock.advance(8 * 24 * 60 * 60 * 1000);

    const acceptResult = await accept.execute({
      token: result.value.token,
      userId: 'user-expired',
      userEmail: 'expired@example.com',
    });

    expect(acceptResult.ok).toBe(false);
    if (acceptResult.ok) return;
    expect(acceptResult.error.kind).toBe('Unauthorized');
  });

  describe('privilege ceiling (F-07)', () => {
    it('an admin cannot invite someone as owner', async () => {
      const result = await invite.execute({
        actorUserId: 'admin-1', actorRole: 'admin', orgId: 'org-1', email: 'x@example.com', role: 'owner',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('Forbidden');
    });

    it('an owner can invite someone as owner; an admin can invite admin/member/viewer', async () => {
      expect((await invite.execute({ actorUserId: 'o', actorRole: 'owner', orgId: 'org-1', email: 'o@example.com', role: 'owner' })).ok).toBe(true);
      for (const role of ['admin', 'member', 'viewer']) {
        const r = await invite.execute({ actorUserId: 'a', actorRole: 'admin', orgId: 'org-1', email: `${role}@example.com`, role });
        expect(r.ok).toBe(true);
      }
    });

    it('rejects an unknown role', async () => {
      const result = await invite.execute({
        actorUserId: 'o', actorRole: 'owner', orgId: 'org-1', email: 'x@example.com', role: 'superuser',
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('token handling (F-07)', () => {
    it('stores only a hash of the token (raw token is never persisted)', async () => {
      const result = await invite.execute({ actorUserId: 'o', actorRole: 'owner', orgId: 'org-1', email: 'h@example.com' });
      if (!result.ok) throw new Error('invite failed');
      const stored = invitationRepo.all()[0]!;
      expect(stored.token).not.toBe(result.value.token);
      expect(stored.token).toBe(hashInvitationToken(result.value.token));
      expect(stored.token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('does not put the raw token on the event bus', async () => {
      const result = await invite.execute({ actorUserId: 'o', actorRole: 'owner', orgId: 'org-1', email: 'e@example.com' });
      if (!result.ok) throw new Error('invite failed');
      expect(JSON.stringify(eventBus.events)).not.toContain(result.value.token);
    });

    it('delivers the raw token only by email, to the invited address', async () => {
      const mailer = new FakeMailer();
      const withMail = new InviteToOrg({ invitationRepo, membershipRepo, clock, eventBus, mailer, appUrl: 'https://app.test' });
      const result = await withMail.execute({
        actorUserId: 'o', actorRole: 'owner', orgId: 'org-1', email: 'Mail@Example.com', orgName: 'Acme <b>', inviterName: 'Olga',
      });
      if (!result.ok) throw new Error('invite failed');
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.to).toBe('mail@example.com');
      expect(mailer.sent[0]!.body).toContain(`token=${result.value.token}`);
      expect(mailer.sent[0]!.body).toContain('Acme &lt;b&gt;'); // HTML-escaped
    });

    it('accept is bound to the invited email (case-insensitive)', async () => {
      const result = await invite.execute({ actorUserId: 'o', actorRole: 'owner', orgId: 'org-1', email: 'invitee@example.com' });
      if (!result.ok) throw new Error('invite failed');

      const wrong = await accept.execute({ token: result.value.token, userId: 'attacker', userEmail: 'attacker@example.com' });
      expect(wrong.ok).toBe(false);
      if (!wrong.ok) expect(wrong.error.kind).toBe('NotFound');
      expect(await membershipRepo.findByOrgAndUser('org-1', 'attacker')).toBeNull();

      const right = await accept.execute({ token: result.value.token, userId: 'invitee', userEmail: 'Invitee@Example.COM' });
      expect(right.ok).toBe(true);
    });

    it('a stored hash cannot be replayed as a token', async () => {
      const result = await invite.execute({ actorUserId: 'o', actorRole: 'owner', orgId: 'org-1', email: 'r@example.com' });
      if (!result.ok) throw new Error('invite failed');
      const hash = invitationRepo.all()[0]!.token;
      const replay = await accept.execute({ token: hash, userId: 'u', userEmail: 'r@example.com' });
      expect(replay.ok).toBe(false);
    });

    it('rejects accept when already a member of that org (even if not the default org)', async () => {
      membershipRepo.seed({ orgId: 'other', userId: 'u2', role: 'owner' });
      membershipRepo.seed({ orgId: 'org-1', userId: 'u2', role: 'viewer' });
      const result = await invite.execute({ actorUserId: 'o', actorRole: 'owner', orgId: 'org-1', email: 'u2@example.com', role: 'admin' });
      if (!result.ok) throw new Error('invite failed');
      const r = await accept.execute({ token: result.value.token, userId: 'u2', userEmail: 'u2@example.com' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('Conflict');
    });
  });
});
