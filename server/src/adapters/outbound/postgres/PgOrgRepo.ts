import type { Knex } from 'knex';
import type { Org, OrgPatch, OrgRepo } from '../../../domain/org/ports/OrgRepo.js';

export class PgOrgRepo implements OrgRepo {
  constructor(private readonly db: Knex) {}

  async findById(id: string): Promise<Org | null> {
    const row = await this.db('organizations').where({ id }).first();
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      plan: row.plan,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }

  async update(id: string, patch: OrgPatch): Promise<Org> {
    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.slug !== undefined) updates.slug = patch.slug;
    const [row] = await this.db('organizations').where({ id }).update(updates).returning('*');
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      plan: row.plan,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
  }
}
