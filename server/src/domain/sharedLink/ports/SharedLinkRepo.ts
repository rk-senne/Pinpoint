// SharedLinkRepo outbound port (Phase 1.5 / task 4.6.2).

import type { NewSharedLink, SharedLink, SharedLinkPatch } from '../SharedLink.js';

export interface SharedLinkRepo {
  insert(input: NewSharedLink): Promise<SharedLink>;
  findById(id: string): Promise<SharedLink | null>;
  findByProjectId(projectId: string): Promise<SharedLink | null>;
  update(id: string, patch: SharedLinkPatch): Promise<SharedLink>;
}
