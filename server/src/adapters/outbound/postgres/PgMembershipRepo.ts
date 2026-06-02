import type { Knex } from 'knex';
import type { Membership, MembershipRepo } from '../../../domain/auth/ports/MembershipRepo.js';

export class PgMembershipRepo implements MembershipRepo {
  constructor(private readonly db: Knex) {}

  async findDefaultForUser(userId: string): Promise<Membership | null> {
    const row = await this.db('memberships')
      .where({ user_id: userId })
      .orderBy('created_at', 'asc')
      .first();
    if (!row) return null;
    return { orgId: row.org_id, userId: row.user_id, role: row.role };
  }

  async findByOrgAndUser(orgId: string, userId: string): Promise<Membership | null> {
    const row = await this.db('memberships').where({ org_id: orgId, user_id: userId }).first();
    if (!row) return null;
    return { orgId: row.org_id, userId: row.user_id, role: row.role };
  }

  async create(membership: Membership): Promise<void> {
    await this.db('memberships').insert({
      org_id: membership.orgId,
      user_id: membership.userId,
      role: membership.role,
      accepted_at: this.db.fn.now(),
    });
  }

  async listByOrg(orgId: string): Promise<Membership[]> {
    const rows = await this.db('memberships').where({ org_id: orgId });
    return rows.map((r: any) => ({ orgId: r.org_id, userId: r.user_id, role: r.role }));
  }

  async removeByOrgAndUser(orgId: string, userId: string): Promise<void> {
    await this.db('memberships').where({ org_id: orgId, user_id: userId }).del();
  }

  async updateRole(orgId: string, userId: string, role: string): Promise<void> {
    await this.db('memberships').where({ org_id: orgId, user_id: userId }).update({ role });
  }
}
