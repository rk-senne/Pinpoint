// FakeSharedLinkRepo — in-memory SharedLinkRepo fake
// (Phase 1.5 / task 4.11.1).

import { randomUUID } from 'node:crypto';

import type {
  NewSharedLink,
  SharedLink,
  SharedLinkPatch,
} from '../../domain/sharedLink/SharedLink.js';
import type { SharedLinkRepo } from '../../domain/sharedLink/ports/SharedLinkRepo.js';
import type { Clock } from '../../domain/shared/ports/Clock.js';

export class FakeSharedLinkRepo implements SharedLinkRepo {
  /** Public for direct inspection in tests. */
  readonly links = new Map<string, SharedLink>();

  constructor(private readonly clock: Clock) {}

  async insert(input: NewSharedLink): Promise<SharedLink> {
    const id = randomUUID();
    const link: SharedLink = {
      id,
      projectId: input.projectId,
      passwordHash: input.passwordHash ?? null,
      createdAt: this.clock.now().toISOString(),
      failedAttempts: 0,
      lockedUntil: null,
    };
    this.links.set(id, link);
    return { ...link };
  }

  async findById(id: string): Promise<SharedLink | null> {
    const row = this.links.get(id);
    return row ? { ...row } : null;
  }

  async findByProjectId(projectId: string): Promise<SharedLink | null> {
    for (const row of this.links.values()) {
      if (row.projectId === projectId) return { ...row };
    }
    return null;
  }

  async update(id: string, patch: SharedLinkPatch): Promise<SharedLink> {
    const row = this.links.get(id);
    if (!row) {
      throw new Error(`FakeSharedLinkRepo.update: shared link ${id} not found`);
    }
    const next: SharedLink = { ...row };
    if (patch.passwordHash !== undefined) next.passwordHash = patch.passwordHash;
    if (patch.failedAttempts !== undefined) next.failedAttempts = patch.failedAttempts;
    if (patch.lockedUntil !== undefined) next.lockedUntil = patch.lockedUntil;
    this.links.set(id, next);
    return { ...next };
  }
}
