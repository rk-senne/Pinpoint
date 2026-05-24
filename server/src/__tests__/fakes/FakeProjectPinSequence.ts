// FakeProjectPinSequence — in-memory ProjectPinSequence fake
// (Phase 1.5 / task 4.11.1).
//
// Per-project counter starting at 1. The `tx` argument is ignored — the
// in-memory store doesn't need a transaction handle, but the port's
// signature is preserved so use-case code that passes one through still
// type-checks against the fake.

import type { ProjectPinSequence } from '../../domain/annotation/ports/ProjectPinSequence.js';

export class FakeProjectPinSequence implements ProjectPinSequence {
  private readonly counters = new Map<string, number>();

  // eslint-disable-next-line no-unused-vars
  async next(projectId: string, _tx: unknown): Promise<number> {
    const current = this.counters.get(projectId) ?? 0;
    const next = current + 1;
    this.counters.set(projectId, next);
    return next;
  }

  /** Inspect the current counter without advancing it. */
  peek(projectId: string): number {
    return this.counters.get(projectId) ?? 0;
  }
}
