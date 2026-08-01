import type { Membership, MemberWithUser, MembershipRepo } from '../../domain/auth/ports/MembershipRepo.js';

export class FakeMembershipRepo implements MembershipRepo {
  private memberships: Membership[] = [];

  seed(membership: Membership): void {
    this.memberships.push(membership);
  }

  async findDefaultForUser(userId: string): Promise<Membership | null> {
    return this.memberships.find((m) => m.userId === userId) ?? null;
  }

  async findByOrgAndUser(orgId: string, userId: string): Promise<Membership | null> {
    return this.memberships.find((m) => m.orgId === orgId && m.userId === userId) ?? null;
  }

  async create(membership: Membership): Promise<void> {
    this.memberships.push(membership);
  }

  async listByOrg(orgId: string): Promise<Membership[]> {
    return this.memberships.filter((m) => m.orgId === orgId);
  }

  async listByOrgWithUsers(orgId: string): Promise<MemberWithUser[]> {
    return this.memberships
      .filter((m) => m.orgId === orgId)
      .map((m) => ({ userId: m.userId, role: m.role, email: '', name: '' }));
  }

  async removeByOrgAndUser(orgId: string, userId: string): Promise<void> {
    this.memberships = this.memberships.filter(
      (m) => !(m.orgId === orgId && m.userId === userId),
    );
  }

  async updateRole(orgId: string, userId: string, role: string): Promise<void> {
    const m = this.memberships.find((m) => m.orgId === orgId && m.userId === userId);
    if (m) m.role = role;
  }
}
