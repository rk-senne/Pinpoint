// Postgres adapter for PageRepo (Phase 1.5 / task 4.8.1).

import type { Knex } from 'knex';
import type { NewPage, Page } from '../../../domain/project/Page.js';
import type { PageRepo } from '../../../domain/project/ports/PageRepo.js';

interface PageRow {
  id: string;
  project_id: string;
  url: string;
  title: string | null;
  created_at: Date | string;
}

export class PgPageRepo implements PageRepo {
  constructor(private readonly db: Knex) {}

  /** The caller's transaction when given, else the pool. */
  private conn(tx?: unknown): Knex {
    return (tx as Knex | undefined) ?? this.db;
  }

  async findById(id: string): Promise<Page | null> {
    const row = await this.db<PageRow>('pages').where({ id }).first();
    return row ? this.mapRow(row) : null;
  }

  async findByProjectAndUrl(projectId: string, url: string, tx?: unknown): Promise<Page | null> {
    const row = await this.conn(tx)<PageRow>('pages')
      .where({ project_id: projectId, url })
      .first();
    return row ? this.mapRow(row) : null;
  }

  /**
   * Idempotent on (project_id, url): concurrent first submissions for a brand-new
   * URL (widget / extension) used to race find-then-insert and 500 on the unique
   * index. `ON CONFLICT DO NOTHING` waits for the competing transaction, then the
   * follow-up select (READ COMMITTED) sees the winner's row.
   */
  async insert(input: NewPage, tx?: unknown): Promise<Page> {
    const conn = this.conn(tx);
    const [created] = await conn<PageRow>('pages')
      .insert({
        project_id: input.projectId,
        url: input.url,
        title: input.title ?? null,
      })
      .onConflict(['project_id', 'url'])
      .ignore()
      .returning(['id', 'project_id', 'url', 'title', 'created_at']);
    if (created) return this.mapRow(created);
    const existing = await conn<PageRow>('pages').where({ project_id: input.projectId, url: input.url }).first();
    if (!existing) throw new Error('page insert conflicted but the existing row is not visible');
    return this.mapRow(existing);
  }

  async findAllByUrl(url: string): Promise<Page[]> {
    const rows = await this.db<PageRow>('pages').where({ url });
    return rows.map((r) => this.mapRow(r));
  }

  async listByProject(projectId: string): Promise<Page[]> {
    const rows = await this.db<PageRow>('pages').where({ project_id: projectId });
    return rows.map((r) => this.mapRow(r));
  }

  async delete(id: string): Promise<void> {
    await this.db('pages').where({ id }).del();
  }

  private mapRow(row: PageRow): Page {
    return {
      id: row.id,
      projectId: row.project_id,
      url: row.url,
      title: row.title ?? null,
      createdAt: toIso(row.created_at),
    };
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
