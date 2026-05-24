// PageRepo outbound port (Phase 1.5 / task 4.6.2).

import type { NewPage, Page } from '../Page.js';

export interface PageRepo {
  findById(id: string): Promise<Page | null>;
  /** Lookup by (projectId, url); used during annotation create. */
  findByProjectAndUrl(projectId: string, url: string): Promise<Page | null>;
  insert(input: NewPage): Promise<Page>;
  /** Look up every page matching a URL across projects (used by /by-url). */
  findAllByUrl(url: string): Promise<Page[]>;
  /** Pages belonging to a project (used for the (id → url) lookup map). */
  listByProject(projectId: string): Promise<Page[]>;
  /** Cascading delete with annotation count returned for the response. */
  delete(id: string): Promise<void>;
}
