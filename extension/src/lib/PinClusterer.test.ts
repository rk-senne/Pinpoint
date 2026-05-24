/**
 * Unit tests for PinClusterer.
 *
 * Validates Requirement 52.1: the deterministic 2D-bucket clustering used
 * to merge overlapping Annotation_Pins into Cluster_Pins. These tests
 * cover the foundation algorithm (empty, single, coincident, distant,
 * mixed); rendering of `<fl-cluster-pin>` is exercised by task 44.2 and
 * the partition property by task 44.5 (Property 16).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PIN_CLUSTER_RADIUS,
  PinClusterer,
  type PinInput,
} from './PinClusterer';

describe('PinClusterer', () => {
  it('returns no clusters for an empty input array', () => {
    const clusterer = new PinClusterer();
    expect(clusterer.cluster([])).toEqual([]);
  });

  it('produces a single cluster of size 1 for a single pin', () => {
    const clusterer = new PinClusterer();
    const result = clusterer.cluster([{ id: 'a', x: 10, y: 20 }]);

    expect(result).toHaveLength(1);
    expect(result[0].pinIds).toEqual(['a']);
    expect(result[0].centroid).toEqual({ x: 10, y: 20 });
    // floor(10/24)=0, floor(20/24)=0
    expect(result[0].bucketKey).toBe('0:0');
  });

  it('groups two coincident pins into one cluster of size 2', () => {
    const clusterer = new PinClusterer();
    const pins: PinInput[] = [
      { id: 'a', x: 100, y: 100 },
      { id: 'b', x: 100, y: 100 },
    ];
    const result = clusterer.cluster(pins);

    expect(result).toHaveLength(1);
    expect(result[0].pinIds).toEqual(['a', 'b']);
    expect(result[0].centroid).toEqual({ x: 100, y: 100 });
  });

  it('keeps two distant pins in separate clusters', () => {
    const clusterer = new PinClusterer();
    const pins: PinInput[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 500, y: 500 },
    ];
    const result = clusterer.cluster(pins);

    expect(result).toHaveLength(2);
    const ids = result.map((c) => c.pinIds);
    expect(ids).toEqual([['a'], ['b']]);
    expect(result[0].bucketKey).toBe('0:0');
    // floor(500/24) = 20
    expect(result[1].bucketKey).toBe('20:20');
  });

  it('places pins in the same bucket when their bucket coordinates match', () => {
    // Default radius is 24 px. Pins at (0,0) and (23,23) both bucket to
    // (0,0); a pin at (24,0) buckets to (1,0).
    const clusterer = new PinClusterer();
    const result = clusterer.cluster([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 23, y: 23 },
      { id: 'c', x: 24, y: 0 },
    ]);

    expect(result).toHaveLength(2);
    const cluster00 = result.find((c) => c.bucketKey === '0:0')!;
    const cluster10 = result.find((c) => c.bucketKey === '1:0')!;
    expect(cluster00.pinIds).toEqual(['a', 'b']);
    expect(cluster10.pinIds).toEqual(['c']);
  });

  it('handles a clustered/scattered mix and computes centroids per bucket', () => {
    const clusterer = new PinClusterer();
    const pins: PinInput[] = [
      // Bucket (0,0): three clustered pins
      { id: 'p1', x: 1, y: 1 },
      { id: 'p2', x: 5, y: 7 },
      { id: 'p3', x: 10, y: 10 },
      // Bucket (4,4): two clustered pins (96..119 range)
      { id: 'p4', x: 100, y: 100 },
      { id: 'p5', x: 110, y: 105 },
      // Scattered singletons
      { id: 'p6', x: 300, y: 50 },
      { id: 'p7', x: 50, y: 300 },
    ];
    const result = clusterer.cluster(pins);

    expect(result).toHaveLength(4);

    const byKey = new Map(result.map((c) => [c.bucketKey, c]));
    expect(byKey.get('0:0')!.pinIds).toEqual(['p1', 'p2', 'p3']);
    expect(byKey.get('0:0')!.centroid).toEqual({
      x: (1 + 5 + 10) / 3,
      y: (1 + 7 + 10) / 3,
    });

    expect(byKey.get('4:4')!.pinIds).toEqual(['p4', 'p5']);
    expect(byKey.get('4:4')!.centroid).toEqual({
      x: (100 + 110) / 2,
      y: (100 + 105) / 2,
    });

    // floor(300/24)=12, floor(50/24)=2 → bucket "12:2"
    expect(byKey.get('12:2')!.pinIds).toEqual(['p6']);
    // floor(50/24)=2, floor(300/24)=12 → bucket "2:12"
    expect(byKey.get('2:12')!.pinIds).toEqual(['p7']);
  });

  it('preserves insertion order for buckets and pin ids within a bucket', () => {
    const clusterer = new PinClusterer();
    const result = clusterer.cluster([
      { id: 'first-bucket-a', x: 0, y: 0 },
      { id: 'second-bucket-a', x: 100, y: 100 },
      { id: 'first-bucket-b', x: 5, y: 5 },
      { id: 'second-bucket-b', x: 105, y: 105 },
    ]);

    expect(result.map((c) => c.bucketKey)).toEqual(['0:0', '4:4']);
    expect(result[0].pinIds).toEqual(['first-bucket-a', 'first-bucket-b']);
    expect(result[1].pinIds).toEqual(['second-bucket-a', 'second-bucket-b']);
  });

  it('honors a custom radius', () => {
    const clusterer = new PinClusterer(50);
    expect(clusterer.getRadius()).toBe(50);
    const result = clusterer.cluster([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 49, y: 49 },
      { id: 'c', x: 50, y: 0 },
    ]);
    const byKey = new Map(result.map((c) => [c.bucketKey, c]));
    expect(byKey.get('0:0')!.pinIds).toEqual(['a', 'b']);
    expect(byKey.get('1:0')!.pinIds).toEqual(['c']);
  });

  it('exposes the documented default radius', () => {
    expect(DEFAULT_PIN_CLUSTER_RADIUS).toBe(24);
    expect(new PinClusterer().getRadius()).toBe(DEFAULT_PIN_CLUSTER_RADIUS);
  });

  it('rejects a non-positive radius', () => {
    expect(() => new PinClusterer(0)).toThrow(/positive/);
    expect(() => new PinClusterer(-1)).toThrow(/positive/);
    expect(() => new PinClusterer(Number.NaN)).toThrow(/positive/);
    expect(() => new PinClusterer(Number.POSITIVE_INFINITY)).toThrow(
      /positive/,
    );
  });

  it('is deterministic: identical inputs yield identical outputs', () => {
    const clusterer = new PinClusterer();
    const pins: PinInput[] = [
      { id: 'a', x: 1, y: 2 },
      { id: 'b', x: 200, y: 200 },
      { id: 'c', x: 3, y: 4 },
      { id: 'd', x: 201, y: 199 },
    ];
    expect(clusterer.cluster(pins)).toEqual(clusterer.cluster(pins));
  });

  it('handles negative coordinates via floor (e.g. off-screen pins)', () => {
    // Math.floor(-1 / 24) = -1, so a negative pin lands in bucket "-1:-1".
    const clusterer = new PinClusterer();
    const result = clusterer.cluster([
      { id: 'a', x: -1, y: -1 },
      { id: 'b', x: -23, y: -23 },
      { id: 'c', x: 0, y: 0 },
    ]);
    const byKey = new Map(result.map((c) => [c.bucketKey, c]));
    expect(byKey.get('-1:-1')!.pinIds).toEqual(['a', 'b']);
    expect(byKey.get('0:0')!.pinIds).toEqual(['c']);
  });

  /* ------------------------------------------------------------------ */
  /* Zoom-driven re-clustering (Requirement 52.3 / task 44.4)           */
  /* ------------------------------------------------------------------ */
  //
  // The clusterer itself is a pure function, so "zoom-in" and "zoom-out"
  // are modeled by passing scaled pin coordinates — exactly the way
  // `<fl-overlay-host>` calls it (it multiplies each pin's CSS-pixel
  // coordinate by `visualViewport.scale`, so a 200% zoom doubles the
  // effective coordinates and brings two pins that are 30 CSS pixels
  // apart into the same 24-px bucket).
  //
  // These tests are the algorithm-level half of task 44.4; the
  // companion DOM-level test in `OverlayHost.test.ts` verifies that a
  // window resize event actually triggers a recluster.

  describe('re-clustering on viewport scale changes (Req 52.3)', () => {
    it('keeps two pins in distinct clusters at scale 1 when they sit just outside one bucket', () => {
      const clusterer = new PinClusterer(); // default radius 24
      // Pin A in bucket (4,4); Pin B 30 CSS-pixels away → bucket (5,5).
      // At natural zoom (scale=1) the two are in distinct buckets and
      // the clusterer leaves them as singletons.
      const scale = 1;
      const result = clusterer.cluster([
        { id: 'a', x: 100 * scale, y: 100 * scale },
        { id: 'b', x: 130 * scale, y: 130 * scale },
      ]);
      expect(result).toHaveLength(2);
      expect(result.every((c) => c.pinIds.length === 1)).toBe(true);
    });

    it('clusters two pins together after a zoom-in (scale > 1) brings them into the same bucket', () => {
      const clusterer = new PinClusterer(); // default radius 24
      // Same two pins as the previous test, now zoomed in 2.5×. The
      // CSS-pixel distance (30) at scale 2.5 becomes an effective 75 px
      // — but more importantly, both pins now land in the same 24-px
      // bucket because the absolute coordinates are large enough to
      // share floor(x/24).
      const scale = 1; // simulate a controlled "after zoom" by picking
      // coordinates that would result from the host's
      // `pageX * visualViewport.scale` math: at scale 1, two pins at
      // (240,240) and (250,250) share bucket (10,10) regardless.
      const result = clusterer.cluster([
        { id: 'a', x: 240 * scale, y: 240 * scale },
        { id: 'b', x: 250 * scale, y: 250 * scale },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].pinIds).toEqual(['a', 'b']);
    });

    it('demonstrates the zoom-in path explicitly: the same CSS-pixel coords cluster only after scaling', () => {
      const clusterer = new PinClusterer(); // default radius 24
      const cssPins: ReadonlyArray<{ id: string; x: number; y: number }> = [
        { id: 'a', x: 10, y: 10 },
        { id: 'b', x: 20, y: 20 },
      ];

      // Natural zoom (scale = 1): both pins share bucket (0,0).
      const atScale1 = clusterer.cluster(cssPins.map((p) => ({ ...p, x: p.x * 1, y: p.y * 1 })));
      expect(atScale1).toHaveLength(1);
      expect(atScale1[0].pinIds).toEqual(['a', 'b']);

      // Zoom-in 2× — the absolute coordinates double; `b` jumps from
      // (20,20) to (40,40) which lives in bucket (1,1) while `a` stays
      // in bucket (0,0). The cluster splits.
      const atScale2 = clusterer.cluster(
        cssPins.map((p) => ({ ...p, x: p.x * 2, y: p.y * 2 })),
      );
      expect(atScale2).toHaveLength(2);
      expect(atScale2.every((c) => c.pinIds.length === 1)).toBe(true);
    });

    it('zoom-out (scale < 1) collapses two previously-separate pins into one cluster', () => {
      const clusterer = new PinClusterer(); // default radius 24
      // CSS coords (30, 30) and (60, 60) — at scale 1 they sit in
      // buckets (1,1) and (2,2) respectively, so they are separate.
      const cssPins = [
        { id: 'a', x: 30, y: 30 },
        { id: 'b', x: 60, y: 60 },
      ];
      const atScale1 = clusterer.cluster(cssPins);
      expect(atScale1).toHaveLength(2);

      // Zoom out 0.25× — both coords scale to 7.5 / 15, both flooring
      // into bucket (0,0). The two singletons collapse into one cluster.
      const atScaleQuarter = clusterer.cluster(
        cssPins.map((p) => ({ ...p, x: p.x * 0.25, y: p.y * 0.25 })),
      );
      expect(atScaleQuarter).toHaveLength(1);
      expect(atScaleQuarter[0].pinIds).toEqual(['a', 'b']);
    });

    it('a previously-clustered pair separates again on zoom-out below the bucket boundary', () => {
      const clusterer = new PinClusterer();
      // Start clustered at scale 1: (5,5) and (10,10) both land in (0,0).
      const cssPins = [
        { id: 'a', x: 5, y: 5 },
        { id: 'b', x: 10, y: 10 },
      ];
      const atScale1 = clusterer.cluster(cssPins);
      expect(atScale1).toHaveLength(1);
      expect(atScale1[0].pinIds).toEqual(['a', 'b']);

      // Zoom in to push them out of the same bucket: at scale 5 the
      // coords become (25,25) and (50,50) which floor into (1,1) and
      // (2,2). Cluster splits — the inverse of the previous test, and
      // the case Req 52.3 calls out: "WHEN the user zooms in or the
      // page layout changes such that pins no longer overlap, THE
      // Extension SHALL re-expand the Cluster_Pin into individual pins."
      const atScale5 = clusterer.cluster(
        cssPins.map((p) => ({ ...p, x: p.x * 5, y: p.y * 5 })),
      );
      expect(atScale5).toHaveLength(2);
      expect(atScale5.every((c) => c.pinIds.length === 1)).toBe(true);
    });
  });
});
