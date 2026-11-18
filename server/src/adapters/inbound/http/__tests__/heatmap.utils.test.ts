import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  bucketIntoHeatmapCells,
  buildHeatmapAggregateSql,
  mapAggregateRows,
  aggregateLikeSql,
  FINITE_NUMERIC_REGEX,
  type HeatmapInput,
  type HeatmapCell,
} from '../heatmap.utils.js';

describe('bucketIntoHeatmapCells', () => {
  const CELL_SIZE = 50;

  it('returns empty array for empty input', () => {
    const cells = bucketIntoHeatmapCells([], CELL_SIZE);
    expect(cells).toEqual([]);
  });

  it('places a single annotation in the correct cell', () => {
    const rows: HeatmapInput[] = [{ pageX: 120, pageY: 230, severity: 'critical' }];
    const cells = bucketIntoHeatmapCells(rows, CELL_SIZE);

    expect(cells).toHaveLength(1);
    // floor(120/50)=2, 2*50=100; floor(230/50)=4, 4*50=200
    expect(cells[0]).toEqual({
      x: 100,
      y: 200,
      count: 1,
      severities: { critical: 1 },
    });
  });

  it('groups multiple annotations in the same cell', () => {
    const rows: HeatmapInput[] = [
      { pageX: 10, pageY: 10, severity: 'minor' },
      { pageX: 30, pageY: 40, severity: 'major' },
      { pageX: 25, pageY: 5, severity: 'minor' },
    ];
    const cells = bucketIntoHeatmapCells(rows, CELL_SIZE);

    // All fall in cell (0, 0) since all < 50
    expect(cells).toHaveLength(1);
    expect(cells[0]).toEqual({
      x: 0,
      y: 0,
      count: 3,
      severities: { minor: 2, major: 1 },
    });
  });

  it('distributes annotations across multiple cells', () => {
    const rows: HeatmapInput[] = [
      { pageX: 10, pageY: 10, severity: 'minor' },
      { pageX: 60, pageY: 10, severity: 'major' },
      { pageX: 110, pageY: 110, severity: 'critical' },
    ];
    const cells = bucketIntoHeatmapCells(rows, CELL_SIZE);

    expect(cells).toHaveLength(3);
    // All have count=1, so sort order by count desc is stable but all equal
    const cellCoords = cells.map((c) => ({ x: c.x, y: c.y }));
    expect(cellCoords).toContainEqual({ x: 0, y: 0 });
    expect(cellCoords).toContainEqual({ x: 50, y: 0 });
    expect(cellCoords).toContainEqual({ x: 100, y: 100 });
  });

  it('sorts cells by count descending (hottest first)', () => {
    const rows: HeatmapInput[] = [
      // Cell (0,0): 1 hit
      { pageX: 10, pageY: 10, severity: 'minor' },
      // Cell (50,0): 3 hits
      { pageX: 60, pageY: 10, severity: 'major' },
      { pageX: 70, pageY: 20, severity: 'critical' },
      { pageX: 80, pageY: 30, severity: 'major' },
      // Cell (100,0): 2 hits
      { pageX: 110, pageY: 10, severity: 'minor' },
      { pageX: 140, pageY: 40, severity: 'minor' },
    ];
    const cells = bucketIntoHeatmapCells(rows, CELL_SIZE);

    expect(cells).toHaveLength(3);
    expect(cells[0]!.count).toBe(3);
    expect(cells[0]!.x).toBe(50);
    expect(cells[1]!.count).toBe(2);
    expect(cells[1]!.x).toBe(100);
    expect(cells[2]!.count).toBe(1);
    expect(cells[2]!.x).toBe(0);
  });

  it('handles negative coordinates correctly', () => {
    const rows: HeatmapInput[] = [
      { pageX: -10, pageY: -80, severity: 'informational' },
    ];
    const cells = bucketIntoHeatmapCells(rows, CELL_SIZE);

    expect(cells).toHaveLength(1);
    // floor(-10/50) = -1, -1*50 = -50; floor(-80/50) = -2, -2*50 = -100
    expect(cells[0]).toEqual({
      x: -50,
      y: -100,
      count: 1,
      severities: { informational: 1 },
    });
  });

  it('handles a custom cell size', () => {
    const rows: HeatmapInput[] = [{ pageX: 75, pageY: 150, severity: 'minor' }];
    const cells = bucketIntoHeatmapCells(rows, 100);

    // floor(75/100)=0, 0*100=0; floor(150/100)=1, 1*100=100
    expect(cells).toHaveLength(1);
    expect(cells[0]).toEqual({
      x: 0,
      y: 100,
      count: 1,
      severities: { minor: 1 },
    });
  });

  it('aggregates severities correctly within a cell', () => {
    const rows: HeatmapInput[] = [
      { pageX: 5, pageY: 5, severity: 'critical' },
      { pageX: 10, pageY: 10, severity: 'critical' },
      { pageX: 20, pageY: 20, severity: 'major' },
      { pageX: 30, pageY: 30, severity: 'minor' },
      { pageX: 40, pageY: 40, severity: 'informational' },
      { pageX: 45, pageY: 45, severity: 'critical' },
    ];
    const cells = bucketIntoHeatmapCells(rows, CELL_SIZE);

    expect(cells).toHaveLength(1);
    expect(cells[0]!.severities).toEqual({
      critical: 3,
      major: 1,
      minor: 1,
      informational: 1,
    });
    expect(cells[0]!.count).toBe(6);
  });
});

// --- Helpers for parity comparison ----------------------------------------

// Both the oracle and the SQL path sort by count DESC, but ties are
// order-indeterminate (Map insertion order vs. Postgres row order). Normalize
// to a deterministic total order before comparing so parity is about cell
// *contents*, not tie-break order.
function normalize(cells: HeatmapCell[]): HeatmapCell[] {
  return [...cells].sort((a, b) => (a.x - b.x) || (a.y - b.y));
}

describe('buildHeatmapAggregateSql', () => {
  it('buckets by floor(coord / cell) and aggregates severities in SQL', () => {
    const { sql, bindings } = buildHeatmapAggregateSql({
      projectId: 'proj-1',
      orgId: 'org-1',
      cellSize: 50,
      pageIds: null,
    });

    // Guarded extraction: the numeric cast only runs inside CASE after the
    // regex matches (WHERE-order isn't guaranteed in Postgres).
    expect(sql).toContain("CASE WHEN (target->>'pageX') ~ ? THEN (target->>'pageX')::numeric END");
    expect(sql).toContain("CASE WHEN (target->>'pageY') ~ ? THEN (target->>'pageY')::numeric END");
    expect(sql).toContain('floor(px / ?) AS cell_x');
    expect(sql).toContain('floor(py / ?) AS cell_y');
    // Cell total sums severity counts (regression: count(*) counted groups).
    expect(sql).toContain('sum(sev_count)::int AS count');
    // Outer select only references bucket columns (regression: it referenced
    // `target`, which doesn't exist in the subquery → runtime SQL error).
    expect(sql).toContain('(cell_x * ?)::double precision AS x');
    expect(sql).toContain('jsonb_object_agg(severity, sev_count)');
    expect(sql).toContain('GROUP BY cell_x, cell_y');
    expect(sql).toContain('ORDER BY count DESC');
    // No pageUrl → no page_id filter branch.
    expect(sql).not.toContain('page_id IN');
    expect(sql).not.toContain('1 = 0');

    // project_id and org_id present; cell size used for floor division.
    expect(bindings).toContain('proj-1');
    expect(bindings).toContain('org-1');
    expect(bindings.filter((b) => b === 50).length).toBeGreaterThanOrEqual(4);
    // Finite-numeric regex guard applied for both coordinates.
    expect(bindings.filter((b) => b === FINITE_NUMERIC_REGEX)).toHaveLength(2);
  });

  it('adds a page_id IN (...) filter with one binding per resolved page', () => {
    const { sql, bindings } = buildHeatmapAggregateSql({
      projectId: 'proj-1',
      orgId: 'org-1',
      cellSize: 50,
      pageIds: ['page-a', 'page-b'],
    });

    expect(sql).toContain('page_id IN (?, ?)');
    expect(bindings).toContain('page-a');
    expect(bindings).toContain('page-b');
  });

  it('matches nothing (1 = 0) when pageIds resolves to an empty list', () => {
    const { sql } = buildHeatmapAggregateSql({
      projectId: 'proj-1',
      orgId: 'org-1',
      cellSize: 50,
      pageIds: [],
    });
    expect(sql).toContain('AND 1 = 0');
    expect(sql).not.toContain('page_id IN');
  });
});

describe('mapAggregateRows', () => {
  it('normalizes object and stringified JSONB severities', () => {
    const cells = mapAggregateRows([
      { x: 0, y: 0, count: 2, severities: { minor: 2 } },
      { x: 50, y: 0, count: 1, severities: JSON.stringify({ major: 1 }) },
    ]);
    expect(cells).toEqual([
      { x: 0, y: 0, count: 2, severities: { minor: 2 } },
      { x: 50, y: 0, count: 1, severities: { major: 1 } },
    ]);
  });

  it('coerces numeric-string x/y/count (pg numeric → string) to numbers', () => {
    const cells = mapAggregateRows([
      { x: '100' as unknown as number, y: '200' as unknown as number, count: '3' as unknown as number, severities: { critical: 3 } },
    ]);
    expect(cells[0]).toEqual({ x: 100, y: 200, count: 3, severities: { critical: 3 } });
  });
});

describe('FINITE_NUMERIC_REGEX (coordinate filter)', () => {
  const re = new RegExp(FINITE_NUMERIC_REGEX);
  it('accepts finite decimals (incl. negative and exponent)', () => {
    for (const s of ['0', '10', '-10', '12.5', '-0.5', '1e3', '-2.5E-2']) {
      expect(re.test(s)).toBe(true);
    }
  });
  it('rejects non-finite / non-numeric text', () => {
    for (const s of ['', 'NaN', 'Infinity', '-Infinity', 'abc', 'not-a-number', '1,2', ' 1']) {
      expect(re.test(s)).toBe(false);
    }
  });
});

describe('GAP 6 parity: aggregateLikeSql (SQL semantics) ≡ bucketIntoHeatmapCells (oracle)', () => {
  it('excludes rows with missing / non-numeric coords consistently', () => {
    const raw = [
      { pageX: 50, pageY: 50, severity: 'minor' },        // kept
      { pageX: null, pageY: 50, severity: 'minor' },      // missing x
      { pageX: 'not-a-number', pageY: 50, severity: 'x' },// non-numeric
      { pageY: 50, severity: 'minor' } as any,            // missing key
      { pageX: NaN, pageY: 50, severity: 'minor' },        // non-finite
      { pageX: Infinity, pageY: 50, severity: 'minor' },   // non-finite
    ];
    const sqlCells = aggregateLikeSql(raw, 50);

    // Oracle receives only the rows the JS route guard would keep.
    const kept: HeatmapInput[] = raw
      .filter((r) => typeof r.pageX === 'number' && typeof r.pageY === 'number'
        && Number.isFinite(r.pageX) && Number.isFinite(r.pageY))
      .map((r) => ({ pageX: r.pageX as number, pageY: r.pageY as number, severity: r.severity }));
    const oracleCells = bucketIntoHeatmapCells(kept, 50);

    expect(normalize(sqlCells)).toEqual(normalize(oracleCells));
    expect(sqlCells.reduce((s, c) => s + c.count, 0)).toBe(1);
  });

  it('property: SQL-equivalent bucketing matches the oracle for arbitrary inputs', () => {
    const cellSizeArb = fc.integer({ min: 1, max: 200 });
    // Coordinates may be valid finite numbers OR invalid (null / non-numeric
    // string / non-finite) — both paths must drop the invalid ones identically.
    const coordArb = fc.oneof(
      fc.double({ min: -5000, max: 5000, noNaN: true, noDefaultInfinity: true }),
      fc.constantFrom(null as unknown as number, NaN, Infinity, -Infinity),
      fc.string(), // random non-numeric text
    );
    const severityArb = fc.constantFrom('critical', 'major', 'minor', 'informational');
    const rowArb = fc.record({ pageX: coordArb, pageY: coordArb, severity: severityArb });

    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 200 }), cellSizeArb, (rows, cellSize) => {
        const sqlCells = aggregateLikeSql(rows, cellSize);

        // Derive the oracle inputs the same way the route would: keep only
        // finite numeric coords, pass those (as numbers) to the oracle.
        const finite = new RegExp(FINITE_NUMERIC_REGEX);
        const kept: HeatmapInput[] = [];
        for (const r of rows) {
          const sx = r.pageX === null || r.pageX === undefined ? null
            : typeof r.pageX === 'number' ? String(r.pageX)
            : typeof r.pageX === 'string' ? r.pageX : null;
          const sy = r.pageY === null || r.pageY === undefined ? null
            : typeof r.pageY === 'number' ? String(r.pageY)
            : typeof r.pageY === 'string' ? r.pageY : null;
          if (sx === null || sy === null) continue;
          if (!finite.test(sx) || !finite.test(sy)) continue;
          kept.push({ pageX: Number(sx), pageY: Number(sy), severity: r.severity });
        }
        const oracleCells = bucketIntoHeatmapCells(kept, cellSize);

        expect(normalize(sqlCells)).toEqual(normalize(oracleCells));
      }),
      { numRuns: 300 },
    );
  });
});
