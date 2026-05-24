// FakePageRepo — in-memory PageRepo fake (Phase 1.5 / task 4.11.1).

import { randomUUID } from 'node:crypto';

import type { NewPage, Page } from '../../domain/project/Page.js';
import type { PageRepo } from '../../domain/project/ports/PageRepo.js';
import type { Clock } from '../../domain/shared/ports/Clock.js';

export class FakePageRepo implements PageRepo {
  /** Public for direct inspection in tests. */
  readonly pages = new Map<string, Page>();

  constructor(private readonly clock: Clock) {}

  async findById(id: string): Promise<Page | null> {
    const row = this.pages.get(id);
    return row ? { ...row } : null;
  }

  async findByProjectAndUrl(projectId: string, url: string): Promise<Page | null> {
    for (const row of this.pages.values()) {
      if (row.projectId === projectId && row.url === url) {
        return { ...row };
      }
    }
    return null;
  }

  async insert(input: NewPage): Promise<Page> {
    const id = randomUUID();
    const page: Page = {
      id,
      projectId: input.projectId,
      url: input.url,
      title: input.title ?? null,
      createdAt: this.clock.now().toISOString(),
    };
    this.pages.set(id, page);
    return { ...page };
  }

  async findAllByUrl(url: string): Promise<Page[]> {
    const matches: Page[] = [];
    for (const row of this.pages.values()) {
      if (row.url === url) matches.push({ ...row });
    }
    return matches;
  }

  async listByProject(projectId: string): Promise<Page[]> {
    const matches: Page[] = [];
    for (const row of this.pages.values()) {
      if (row.projectId === projectId) matches.push({ ...row });
    }
    return matches;
  }

  async delete(id: string): Promise<void> {
    this.pages.delete(id);
  }
}
