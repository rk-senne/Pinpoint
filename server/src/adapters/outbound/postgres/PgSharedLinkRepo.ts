// Postgres adapter for SharedLinkRepo (Phase 1.5 / task 4.8.1).

import type { Knex } from 'knex';
import type {
  NewSharedLink,
  SharedLink,
  SharedLinkPatch,
} from '../../../domain/sharedLink/SharedLink.js';
import type { SharedLinkRepo } from '../../../domain/sharedLink/ports/SharedLinkRepo.js';

interface SharedLinkRow {
  id: string;
  project_id: string;
  password_hash: string | null;
  failed_attempts: number;
  locked_until: Date | string | null;
  created_at: Date | string;
}

export class PgSharedLinkRepo implements SharedLinkRepo {
  constructor(private readonly db: Knex) {}

  async insert(input: NewSharedLink): Promise<SharedLink> {
    const [created] = await this.db<SharedLinkRow>('shared_links')
      .insert({
        project_id: input.projectId,
        password_hash: input.passwordHash ?? null,
        failed_attempts: 0,
        locked_until: null,
      })
      .returning([
        'id',
        'project_id',
        'password_hash',
        'failed_attempts',
        'locked_until',
        'created_at',
      ]);
    return this.mapRow(created);
  }

  async findById(id: string): Promise<SharedLink | null> {
    const row = await this.db<SharedLinkRow>('shared_links').where({ id }).first();
    return row ? this.mapRow(row) : null;
  }

  async findByProjectId(projectId: string): Promise<SharedLink | null> {
    const row = await this.db<SharedLinkRow>('shared_links')
      .where({ project_id: projectId })
      .first();
    return row ? this.mapRow(row) : null;
  }

  async update(id: string, patch: SharedLinkPatch): Promise<SharedLink> {
    const updates: Record<string, unknown> = {};
    if (patch.passwordHash !== undefined) updates.password_hash = patch.passwordHash;
    if (patch.failedAttempts !== undefined) updates.failed_attempts = patch.failedAttempts;
    if (patch.lockedUntil !== undefined) updates.locked_until = patch.lockedUntil;

    const [updated] = await this.db<SharedLinkRow>('shared_links')
      .where({ id })
      .update(updates)
      .returning([
        'id',
        'project_id',
        'password_hash',
        'failed_attempts',
        'locked_until',
        'created_at',
      ]);
    return this.mapRow(updated);
  }

  private mapRow(row: SharedLinkRow): SharedLink {
    const link: SharedLink = {
      id: row.id,
      projectId: row.project_id,
      passwordHash: row.password_hash ?? null,
      createdAt: toIso(row.created_at),
      failedAttempts: row.failed_attempts ?? 0,
      lockedUntil: row.locked_until ? toIso(row.locked_until) : null,
    };
    return link;
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
