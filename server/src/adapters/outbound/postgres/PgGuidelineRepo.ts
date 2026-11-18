// Postgres adapter for GuidelineRepo (Phase 1.5 / task 4.8.1).

import type { Knex } from 'knex';
import type { Guideline, NewGuideline } from '../../../domain/guideline/Guideline.js';
import type { GuidelineRepo } from '../../../domain/guideline/ports/GuidelineRepo.js';

interface GuidelineRow {
  id: string;
  name: string;
  description: string;
  is_default: boolean;
  created_by_user_id: string | null;
  org_id: string | null;
}

export class PgGuidelineRepo implements GuidelineRepo {
  constructor(private readonly db: Knex) {}

  async insert(input: NewGuideline): Promise<Guideline> {
    const [created] = await this.db<GuidelineRow>('guidelines')
      .insert({
        name: input.name,
        description: input.description,
        is_default: input.isDefault,
        created_by_user_id: input.createdByUserId ?? null,
        org_id: input.isDefault ? null : (input.orgId ?? null),
      })
      .returning(['id', 'name', 'description', 'is_default', 'created_by_user_id', 'org_id']);
    return this.mapRow(created);
  }

  async list(orgId: string): Promise<Guideline[]> {
    const rows = await this.db<GuidelineRow>('guidelines')
      .select('id', 'name', 'description', 'is_default', 'created_by_user_id', 'org_id')
      .where((qb) => qb.where('is_default', true).orWhere('org_id', orgId))
      .orderBy('is_default', 'desc')
      .orderBy('name', 'asc');
    return rows.map((r) => this.mapRow(r));
  }

  async hasDefaults(): Promise<boolean> {
    const existing = await this.db('guidelines').where({ is_default: true }).select('id');
    return existing.length > 0;
  }

  async insertMany(inputs: NewGuideline[]): Promise<void> {
    if (inputs.length === 0) return;
    const rows = inputs.map((g) => ({
      name: g.name,
      description: g.description,
      is_default: g.isDefault,
      created_by_user_id: g.createdByUserId ?? null,
      org_id: g.isDefault ? null : (g.orgId ?? null),
    }));
    await this.db('guidelines').insert(rows);
  }

  private mapRow(row: GuidelineRow): Guideline {
    const guideline: Guideline = {
      id: row.id,
      name: row.name,
      description: row.description,
      isDefault: row.is_default,
    };
    if (row.created_by_user_id) guideline.createdByUserId = row.created_by_user_id;
    if (row.org_id) guideline.orgId = row.org_id;
    return guideline;
  }
}
