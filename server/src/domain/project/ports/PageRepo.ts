// PageRepo outbound port (Phase 1.5 / task 4.6.2).

import type { NewPage, Page } from '../Page.js';

export interface PageRepo {
  findById(id: string): Promise<Page | null>;
  /** Lookup by (projectId, url); used during annotation create. */
  findByProjectAndUrl(projectId: string, url: string, tx?: unknown): Promise<Page | null>;
  /**
   * `tx` (opaque, as on `ProjectPinSequence.next`) runs the statement on the
   * caller's open transaction. Without it the statement takes a SECOND pooled
   * connection while the transaction still holds its own, which starves the
   * pool (deadlock once concurrent transactions >= pool size).
   */
  insert(input: NewPage, tx?: unknown): Promise<Page>;
  /** Look up every page matching a URL across projects (used by /by-url). */
  findAllByUrl(url: string): Promise<Page[]>;
  /** Pages belonging to a project (used for the (id → url) lookup map). */
  listByProject(projectId: string): Promise<Page[]>;
  /** Cascading delete with annotation count returned for the response. */
  delete(id: string): Promise<void>;
}
