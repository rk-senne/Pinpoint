/**
 * Feature: pinpoint-app, Property 16: Pin clustering is consistent
 *
 * For any set of annotation pin positions, the PinClusterer shall:
 *
 *   - Determinism: produce the same output for the same input on every
 *     invocation (pure function).
 *   - Bucket containment: place every input pin into exactly one cluster
 *     (no double-counting, no orphans). The multiset of pin ids across
 *     all returned clusters equals the multiset of input ids.
 *   - Distance invariant (intra-cluster): any two pins in the same
 *     cluster have center-to-center Euclidean distance <= 2 * radius
 *     (default 24 px so <= 48 px). This follows from bucketing on a
 *     `radius`-sided grid: |dx|, |dy| < radius for any two pins in the
 *     same bucket, so distance < sqrt(2) * radius < 2 * radius.
 *   - Distance invariant (inter-cluster partition): for any pin Q not in
 *     cluster X, Q's bucket key differs from X's bucket key — meaning Q
 *     and every pin in X differ by >= radius along at least one axis,
 *     confirming the bucketing correctly partitions the pin set.
 *   - Stability under permutation: clustering [p1, p2, p3] yields the
 *     same partition (modulo cluster/pin order) as clustering any
 *     permutation of the same pins. The partition is a property of the
 *     input set, not the input order — important so re-renders that
 *     re-emit pins in a different order do not visually shuffle the
 *     resulting cluster pins.
 *
 * **Validates: Requirements 52.1**
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  PinClusterer,
  DEFAULT_PIN_CLUSTER_RADIUS,
  type PinInput,
  type PinCluster,
} from '../../lib/PinClusterer';

/** Arbitrary for a single pin position in a 1000x1000 viewport. */
const arbPin: fc.Arbitrary<PinInput> = fc.record({
  id: fc.uuid(),
  x: fc.integer({ min: 0, max: 1000 }),
  y: fc.integer({ min: 0, max: 1000 }),
});

/**
 * Arbitrary for a list of pins with unique ids. fast-check `fc.uuid()`
 * collisions are vanishingly unlikely but not impossible; uniqueness
 * keeps the bucket-containment multiset checks unambiguous.
 */
const arbPins: fc.Arbitrary<readonly PinInput[]> = fc
  .array(arbPin, { minLength: 0, maxLength: 30 })
  .map((pins) => {
    const seen = new Set<string>();
    return pins.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  });

/** Build a normalized "partition signature" (sorted bucketKey -> sorted ids). */
function partitionSignature(clusters: readonly PinCluster[]): string {
  return clusters
    .map((c) => `${c.bucketKey}=${[...c.pinIds].sort().join(',')}`)
    .sort()
    .join('|');
}

function euclidean(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

describe('Property 16: Pin clustering is consistent', () => {
  it('is deterministic — same input produces the same output', () => {
    fc.assert(
      fc.property(arbPins, (pins) => {
        const clusterer = new PinClusterer();
        const a = clusterer.cluster(pins);
        const b = clusterer.cluster(pins);
        expect(a).toEqual(b);
      }),
      { numRuns: 100 },
    );
  });

  it('places every pin in exactly one cluster (bucket containment)', () => {
    fc.assert(
      fc.property(arbPins, (pins) => {
        const clusterer = new PinClusterer();
        const clusters = clusterer.cluster(pins);

        // Flatten all pin ids across clusters; expect a permutation of input ids.
        const flat = clusters.flatMap((c) => [...c.pinIds]);
        expect(flat).toHaveLength(pins.length);
        expect([...flat].sort()).toEqual(pins.map((p) => p.id).sort());

        // No id appears twice (no double-counting).
        const seen = new Set<string>();
        for (const id of flat) {
          expect(seen.has(id)).toBe(false);
          seen.add(id);
        }

        // Every input id appears in some cluster (no orphans).
        for (const p of pins) {
          expect(seen.has(p.id)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('respects distance invariants (intra- and inter-cluster)', () => {
    fc.assert(
      fc.property(arbPins, (pins) => {
        const clusterer = new PinClusterer();
        const radius = clusterer.getRadius();
        expect(radius).toBe(DEFAULT_PIN_CLUSTER_RADIUS);
        const clusters = clusterer.cluster(pins);

        // Index pins by id for O(1) lookup.
        const byId = new Map(pins.map((p) => [p.id, p]));

        // Intra-cluster: every pair within a cluster has distance <= 2 * radius.
        for (const cluster of clusters) {
          const pts = cluster.pinIds.map((id) => byId.get(id)!);
          for (let i = 0; i < pts.length; i++) {
            for (let j = i + 1; j < pts.length; j++) {
              expect(euclidean(pts[i], pts[j])).toBeLessThanOrEqual(
                2 * radius,
              );
            }
          }
        }

        // Inter-cluster: a pin Q not in cluster X has a bucket key that
        // differs from X's key — meaning every pin in X differs from Q
        // by >= radius along at least one axis. This is the partition
        // correctness check that the requirement codifies.
        for (const X of clusters) {
          const xKey = X.bucketKey;
          for (const Y of clusters) {
            if (Y.bucketKey === xKey) continue;
            for (const qid of Y.pinIds) {
              const q = byId.get(qid)!;
              for (const pid of X.pinIds) {
                const p = byId.get(pid)!;
                const sameXBucket =
                  Math.floor(p.x / radius) === Math.floor(q.x / radius);
                const sameYBucket =
                  Math.floor(p.y / radius) === Math.floor(q.y / radius);
                // Different cluster ⇒ at least one axis bucket differs.
                expect(sameXBucket && sameYBucket).toBe(false);
              }
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('is stable under permutation — partition does not depend on input order', () => {
    fc.assert(
      fc.property(
        arbPins.chain((pins) =>
          fc.tuple(fc.constant(pins), fc.shuffledSubarray([...pins], {
            minLength: pins.length,
            maxLength: pins.length,
          })),
        ),
        ([pins, shuffled]) => {
          // Sanity: shuffled has the same elements as pins.
          expect([...shuffled].map((p) => p.id).sort()).toEqual(
            pins.map((p) => p.id).sort(),
          );

          const clusterer = new PinClusterer();
          const a = clusterer.cluster(pins);
          const b = clusterer.cluster(shuffled);

          // The partition (which pins co-occupy which bucket) must be
          // identical, even if cluster iteration order or the within-
          // cluster pin order differs.
          expect(partitionSignature(a)).toEqual(partitionSignature(b));
        },
      ),
      { numRuns: 100 },
    );
  });
});
