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

  async findById(id: string): Promise<Page | null> {
    const row = await this.db<PageRow>('pages').where({ id }).first();
    return row ? this.mapRow(row) : null;
  }

  async findByProjectAndUrl(projectId: string, url: string): Promise<Page | null> {
    const row = await this.db<PageRow>('pages')
      .where({ project_id: projectId, url })
      .first();
    return row ? this.mapRow(row) : null;
  }

  async insert(input: NewPage): Promise<Page> {
    const [created] = await this.db<PageRow>('pages')
      .insert({
        project_id: input.projectId,
        url: input.url,
        title: input.title ?? null,
      })
      .returning(['id', 'project_id', 'url', 'title', 'created_at']);
    return this.mapRow(created);
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
