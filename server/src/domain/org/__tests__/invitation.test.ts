import { describe, it, expect, beforeEach } from 'vitest';
import { FakeClock, FakeEventBus, FakeMembershipRepo } from '../../../__tests__/fakes/index.js';
import { InviteToOrg } from '../usecases/inviteToOrg.js';
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
    });

    expect(acceptResult.ok).toBe(false);
    if (acceptResult.ok) return;
    expect(acceptResult.error.kind).toBe('Unauthorized');
  });
});
