/**
 * PinClusterer — deterministic 2D bucket clustering for annotation pins.
 *
 * Foundation for Requirement 52.1: "WHEN two or more Annotation_Pins on a
 * page would overlap within an N-pixel radius (default 24 px) at the
 * current zoom level, THE Extension SHALL render a single Cluster_Pin
 * labeled with the count of contained Annotations."
 *
 * Algorithm
 * ---------
 * Each pin is assigned to a bucket whose key is
 *   `${floor(x / radius)}:${floor(y / radius)}`
 * using the configured `radius` (default 24 px). Pins whose bucket keys
 * match are in the same cluster. The result is an array of clusters, one
 * per non-empty bucket, each carrying the bucket key, the contained pin
 * ids, and the centroid (mean x, mean y) of the contained pins.
 *
 * Determinism
 * -----------
 * Insertion order is preserved end-to-end:
 *   - Buckets appear in the order their first pin was encountered.
 *   - Within a bucket, pin ids appear in the order they were encountered.
 * The same input array always produces the same output.
 *
 * Foundation for tasks
 *   44.2 (`<fl-cluster-pin>` Custom Element renders only clusters with
 *        `pinIds.length >= 2`)
 *   44.5 (Property 16: pin clustering is consistent — bucket assignment
 *        is a partition of the input pin set).
 */

export interface PinInput {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export interface PinCluster {
  /** `${bx}:${by}` at the configured radius. */
  readonly bucketKey: string;
  /** Ids of pins that fell into this bucket, in input order. */
  readonly pinIds: readonly string[];
  /** Mean of the contained pins' (x, y) coordinates. */
  readonly centroid: { readonly x: number; readonly y: number };
}

/** Default bucket side length, in CSS pixels. */
export const DEFAULT_PIN_CLUSTER_RADIUS = 24;

export class PinClusterer {
  private readonly radius: number;

  constructor(radius: number = DEFAULT_PIN_CLUSTER_RADIUS) {
    if (!Number.isFinite(radius) || radius <= 0) {
      throw new Error(
        `PinClusterer: radius must be a positive finite number, got ${String(radius)}`,
      );
    }
    this.radius = radius;
  }

  /** The bucket side length used by this clusterer. */
  getRadius(): number {
    return this.radius;
  }

  /**
   * Group pins into buckets of side `radius`. Returns one cluster per
   * non-empty bucket, including buckets that hold only a single pin.
   * Callers that only care about visually-merged pins should filter by
   * `cluster.pinIds.length >= 2`.
   */
  cluster(pins: readonly PinInput[]): PinCluster[] {
    // Use a Map so iteration order is deterministic and matches the
    // order in which buckets were first populated.
    const buckets = new Map<
      string,
      { ids: string[]; sumX: number; sumY: number }
    >();

    for (const pin of pins) {
      const bx = Math.floor(pin.x / this.radius);
      const by = Math.floor(pin.y / this.radius);
      const key = `${bx}:${by}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.ids.push(pin.id);
        existing.sumX += pin.x;
        existing.sumY += pin.y;
      } else {
        buckets.set(key, { ids: [pin.id], sumX: pin.x, sumY: pin.y });
      }
    }

    const clusters: PinCluster[] = [];
    for (const [bucketKey, { ids, sumX, sumY }] of buckets) {
      const n = ids.length;
      clusters.push({
        bucketKey,
        pinIds: ids,
        centroid: { x: sumX / n, y: sumY / n },
      });
    }
    return clusters;
  }
}

export default PinClusterer;
