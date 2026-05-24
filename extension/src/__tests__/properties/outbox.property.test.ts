/**
 * Feature: pinpoint-app, Property 14: Outbox replay preserves order
 *
 * For any sequence of offline mutations [m1, m2, …, mN] recorded into the
 * outbox while the Extension was offline, followed by a regaining of
 * connectivity, the syncer shall apply them in the same original order.
 * For every pair of indices i < j, the server-side effect of mi is
 * observed before the server-side effect of mj.
 *
 * **Validates: Requirements 44.3, 44.4**
 *
 * Strategy:
 *   1. Stub `chrome.storage.local` with an in-memory Map-backed shim so
 *      the Outbox runs entirely client-side under Node.
 *   2. Generate random sequences of OutboxEntry payloads via fast-check.
 *   3. Property A — FIFO preservation: enqueue then list; the read-out
 *      order equals the enqueue order.
 *   4. Property B — failure preserves order: simulate a "syncer" that
 *      processes the head, removes on success, but halts on the K-th
 *      entry to mimic a rejected upload. The unprocessed tail (entry K
 *      followed by K+1..N-1) is unchanged on retry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';

import {
  enqueue,
  list,
  remove,
  OUTBOX_STORAGE_KEY,
  type OutboxEntry,
  type OutboxKind,
} from '../../lib/Outbox';

// --- chrome.storage.local in-memory shim -----------------------------------

interface ChromeStorageStub {
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (entries: Record<string, unknown>) => Promise<void>;
      remove: (key: string) => Promise<void>;
    };
  };
}

let store: Map<string, unknown>;

function buildChromeStub(): ChromeStorageStub {
  return {
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          if (store.has(key)) return { [key]: store.get(key) };
          return {};
        }),
        set: vi.fn(async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) store.set(k, v);
        }),
        remove: vi.fn(async (key: string) => {
          store.delete(key);
        }),
      },
    },
  };
}

beforeEach(() => {
  store = new Map();
  vi.stubGlobal('chrome', buildChromeStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- arbitraries -----------------------------------------------------------

const arbKind: fc.Arbitrary<OutboxKind> = fc.constantFrom(
  'create-annotation',
  'create-comment',
  'change-status',
);

const arbPayload: fc.Arbitrary<unknown> = fc.oneof(
  fc.record({ body: fc.string({ maxLength: 40 }) }),
  fc.record({ status: fc.constantFrom('active', 'in_progress', 'resolved') }),
  fc.record({ annotationId: fc.uuid(), text: fc.string({ maxLength: 40 }) }),
);

const arbEntry: fc.Arbitrary<OutboxEntry> = fc.record({
  localUuid: fc.uuid(),
  kind: arbKind,
  payload: arbPayload,
  pendingSync: fc.constant(true as const),
  createdAt: fc
    .date({ min: new Date('2024-01-01'), max: new Date('2025-12-31') })
    .map((d) => d.toISOString()),
});

/** A sequence of N entries with locally unique UUIDs. */
const arbSequence: fc.Arbitrary<OutboxEntry[]> = fc
  .array(arbEntry, { minLength: 1, maxLength: 12 })
  .map((entries) =>
    // Make UUIDs unique by suffixing with index — the property is about
    // ordering, so the UUID values themselves only need to be distinct.
    entries.map((e, i) => ({ ...e, localUuid: `${e.localUuid}-${i}` })),
  );

// --- properties ------------------------------------------------------------

describe('Property 14: Outbox replay preserves order', () => {
  it('enqueue then list yields entries in original insertion order', async () => {
    await fc.assert(
      fc.asyncProperty(arbSequence, async (entries) => {
        // Reset storage between runs so previous sequences do not bleed in.
        store = new Map();

        for (const e of entries) {
          await enqueue(e);
        }

        const drained = await list();

        // Same length and same order.
        expect(drained).toHaveLength(entries.length);
        for (let i = 0; i < entries.length; i++) {
          expect(drained[i]).toEqual(entries[i]);
        }

        // The persisted slot also holds the same ordered array.
        expect(store.get(OUTBOX_STORAGE_KEY)).toEqual(entries);
      }),
      { numRuns: 100 },
    );
  });

  it('a failed sync at entry K leaves K..N-1 at the head in original order', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSequence,
        // Pick an index in [0, N-1] — the entry the syncer "fails" on.
        fc.integer({ min: 0, max: 11 }),
        async (entries, rawFailIndex) => {
          store = new Map();

          for (const e of entries) {
            await enqueue(e);
          }

          const failIndex = rawFailIndex % entries.length;

          // Simulate a syncer drain that succeeds on entries [0, failIndex)
          // and rejects entry failIndex. The Outbox API does not expose a
          // dedicated "drain" so we mirror the documented Syncer behaviour
          // (design §30, Req 44.3): read the head, POST it, on success
          // remove(localUuid); on failure leave the entry in place and
          // halt the run.
          const queueBefore = await list();
          for (let i = 0; i < failIndex; i++) {
            // Successful upload — remove from the queue.
            await remove(queueBefore[i].localUuid);
          }
          // Entry at `failIndex` is the one that "rejected"; we leave it in
          // place. We do not touch the tail.

          // After the partial drain, the queue must contain exactly the
          // entries from index `failIndex` onward in the original order.
          const remaining = await list();
          const expectedTail = entries.slice(failIndex);

          expect(remaining).toEqual(expectedTail);

          // Retrying the syncer must observe the same failed head and the
          // same tail — i.e., a re-read returns the identical sequence.
          const remainingAfterRetry = await list();
          expect(remainingAfterRetry).toEqual(expectedTail);

          // Specifically: entry K is still at index 0, and the relative
          // order of entries K+1..N-1 is unchanged.
          if (expectedTail.length > 0) {
            expect(remaining[0]).toEqual(entries[failIndex]);
            for (let i = 1; i < expectedTail.length; i++) {
              expect(remaining[i]).toEqual(entries[failIndex + i]);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('drain via successive head removals yields entries in enqueue order', async () => {
    await fc.assert(
      fc.asyncProperty(arbSequence, async (entries) => {
        store = new Map();

        for (const e of entries) {
          await enqueue(e);
        }

        // Drain by repeatedly reading the head and removing it — exactly
        // the FIFO contract the Syncer relies on for in-order replay.
        const drained: OutboxEntry[] = [];
        // Bound the loop to avoid runaway in case of a regression.
        for (let i = 0; i < entries.length; i++) {
          const queue = await list();
          if (queue.length === 0) break;
          const head = queue[0];
          drained.push(head);
          await remove(head.localUuid);
        }

        expect(drained).toEqual(entries);
        expect(await list()).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});
