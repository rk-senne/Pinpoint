import type { Knex } from 'knex';
import type { Invitation, InvitationRepo, NewInvitation } from '../../../domain/org/ports/InvitationRepo.js';

export class PgInvitationRepo implements InvitationRepo {
  constructor(private readonly db: Knex) {}

  async insert(input: NewInvitation): Promise<Invitation> {
    const [row] = await this.db('invitations').insert({
      org_id: input.orgId,
      email: input.email,
      role: input.role,
      token: input.token,
      expires_at: input.expiresAt,
    }).returning('*');
    return this.map(row);
  }

  async findByToken(token: string): Promise<Invitation | null> {
    const row = await this.db('invitations').where({ token }).first();
    return row ? this.map(row) : null;
  }

  async deleteById(id: string): Promise<void> {
    await this.db('invitations').where({ id }).del();
  }

  async findByOrgAndEmail(orgId: string, email: string): Promise<Invitation | null> {
    const row = await this.db('invitations').where({ org_id: orgId, email }).first();
    return row ? this.map(row) : null;
  }

  private map(row: any): Invitation {
    return {
      id: row.id,
      orgId: row.org_id,
      email: row.email,
      role: row.role,
      token: row.token,
      expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }
}
