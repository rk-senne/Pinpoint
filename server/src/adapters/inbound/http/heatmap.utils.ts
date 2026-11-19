/**
 * Pure utility functions for heatmap grid bucketing.
 *
 * Extracted from heatmap.routes.ts so the logic is independently testable
 * without requiring a database or HTTP layer.
 */

export interface HeatmapInput {
  pageX: number;
  pageY: number;
  severity: string;
}

export interface HeatmapCell {
  x: number;
  y: number;
  count: number;
  severities: Record<string, number>;
}

/**
 * Bucket annotation positions into a grid of cells.
 *
 * Each annotation's `pageX`/`pageY` is floored to the nearest cell boundary.
 * Cells are returned sorted by count descending (hottest first).
 *
 * @param rows - Array of annotations with valid numeric pageX, pageY, and severity.
 * @param cellSize - The pixel width/height of each grid cell (e.g. 50).
 */
export function bucketIntoHeatmapCells(rows: HeatmapInput[], cellSize: number): HeatmapCell[] {
  const grid = new Map<string, { count: number; severities: Record<string, number> }>();

  for (const { pageX, pageY, severity } of rows) {
    const cellX = Math.floor(pageX / cellSize);
    const cellY = Math.floor(pageY / cellSize);
    const key = `${cellX}:${cellY}`;

    if (!grid.has(key)) grid.set(key, { count: 0, severities: {} });
    const cell = grid.get(key)!;
    cell.count++;
    cell.severities[severity] = (cell.severities[severity] ?? 0) + 1;
  }

  return Array.from(grid.entries())
    .map(([key, data]) => {
      const [cx, cy] = key.split(':').map(Number);
      return { x: cx! * cellSize, y: cy! * cellSize, ...data };
    })
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Postgres-side aggregation (GAP 6).
//
// Instead of streaming every matching annotation row into Node and bucketing
// in JS, the heatmap endpoint pushes the density aggregation into Postgres via
// a `GROUP BY floor((target->>'pageX')::numeric / :cell), floor(...pageY...)`.
// `bucketIntoHeatmapCells` above stays the reference oracle: the parity test
// asserts the SQL output matches it for arbitrary inputs, including rows with
// missing / non-numeric coordinates, which both paths exclude identically.
// ---------------------------------------------------------------------------

/** A raw row returned by the heatmap aggregate query (pre-mapping). */
export interface HeatmapAggregateRow {
  /** cellX * cellSize — top-left x of the bucket. */
  x: number;
  /** cellY * cellSize — top-left y of the bucket. */
  y: number;
  /** Total annotations in the bucket. */
  count: number;
  /**
   * Per-severity breakdown as a JSONB object (`{ critical: 3, minor: 1 }`).
   * The pg driver returns JSONB as an object; some test harnesses return a
   * string — `mapAggregateRows` normalizes both.
   */
  severities: Record<string, number> | string;
}

/**
 * Only accept coordinate strings that Postgres would floor the same way JS's
 * `Math.floor(Number(v) / cell)` does. The extracted JSON text (`target->>'k'`)
 * is a string; we require a finite decimal so `NaN`/`Infinity`/`null`/missing
 * keys and non-numeric junk are excluded — mirroring the JS guard
 * (`typeof === 'number' && isFinite`). This same predicate is applied in SQL
 * via a regex `~` filter, so the two paths exclude the same rows.
 */
export const FINITE_NUMERIC_REGEX = '^-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?$';

/**
 * SQL + bindings for the heatmap density aggregate. Extracted as a pure
 * builder so it can be unit-tested and run against a real DB without the
 * HTTP/auth layer.
 *
 * The query:
 *   1. Filters to the project/org, non-null `target`, and (optionally) the
 *      resolved `page_id`s for a given pageUrl.
 *   2. Keeps only rows whose `target->>'pageX'` and `target->>'pageY'` are
 *      finite decimals (excludes missing / non-numeric coords).
 *   3. Buckets by `floor(coord / :cell)` and aggregates per-severity counts
 *      into a JSONB object, summing to the cell total.
 *   4. Orders by count desc (hottest first) — same order as the oracle.
 *
 * `pageIds` is the already-resolved list of page ids (or `null` for no
 * pageUrl filter); resolving the URL → page ids stays in the route so the
 * sub-query shape is unchanged.
 */
export function buildHeatmapAggregateSql(params: {
  projectId: string;
  orgId: string;
  cellSize: number;
  pageIds: string[] | null;
}): { sql: string; bindings: Array<string | number> } {
  const { projectId, orgId, cellSize, pageIds } = params;
  const bindings: Array<string | number> = [];

  // Three-level query:
  //   coords  — extract pageX/pageY ONLY when they match the finite-numeric
  //             guard. The guard lives inside CASE because Postgres does not
  //             guarantee WHERE-clause evaluation order: a bare
  //             `regex AND x::numeric` could cast junk text first and abort
  //             the whole query. CASE evaluation order IS guaranteed.
  //   buckets — per (cell, severity) counts.
  //   outer   — per cell: total = sum of severity counts (NOT count(*), which
  //             would count severity groups), top-left coord = cell * size.
  // Bindings are positional (`?`) so values are always parameterized.
  const pageFilter =
    pageIds && pageIds.length > 0
      ? `AND page_id IN (${pageIds.map(() => '?').join(', ')})`
      : pageIds && pageIds.length === 0
        ? // pageUrl resolved to zero pages → match nothing.
          'AND 1 = 0'
        : '';

  const sql = `
    SELECT
      (cell_x * ?)::double precision AS x,
      (cell_y * ?)::double precision AS y,
      sum(sev_count)::int AS count,
      jsonb_object_agg(severity, sev_count) AS severities
    FROM (
      SELECT
        floor(px / ?) AS cell_x,
        floor(py / ?) AS cell_y,
        severity,
        count(*)::int AS sev_count
      FROM (
        SELECT
          CASE WHEN (target->>'pageX') ~ ? THEN (target->>'pageX')::numeric END AS px,
          CASE WHEN (target->>'pageY') ~ ? THEN (target->>'pageY')::numeric END AS py,
          severity
        FROM annotations
        WHERE project_id = ?
          AND org_id = ?
          AND target IS NOT NULL
          ${pageFilter}
      ) coords
      WHERE px IS NOT NULL AND py IS NOT NULL
      GROUP BY cell_x, cell_y, severity
    ) buckets
    GROUP BY cell_x, cell_y
    ORDER BY count DESC
  `;

  // Bindings in textual order of the `?` placeholders above:
  // outer x, y multipliers ; bucket cell_x, cell_y divisors
  bindings.push(cellSize, cellSize, cellSize, cellSize);
  // numeric regex guards for pageX, pageY (inside the coords CASE)
  bindings.push(FINITE_NUMERIC_REGEX, FINITE_NUMERIC_REGEX);
  // project_id, org_id
  bindings.push(projectId, orgId);
  // page_id IN (...) if present
  if (pageIds && pageIds.length > 0) bindings.push(...pageIds);

  return { sql, bindings };
}

/**
 * Normalize raw aggregate rows into the `HeatmapCell[]` shape returned by
 * `bucketIntoHeatmapCells`, parsing the JSONB `severities` object if the
 * driver handed it back as a string.
 */
export function mapAggregateRows(rows: HeatmapAggregateRow[]): HeatmapCell[] {
  return rows.map((r) => {
    const severities =
      typeof r.severities === 'string'
        ? (JSON.parse(r.severities) as Record<string, number>)
        : r.severities;
    return {
      x: Number(r.x),
      y: Number(r.y),
      count: Number(r.count),
      severities,
    };
  });
}

/**
 * Pure re-implementation of the SQL aggregate's semantics (floor-division
 * bucketing + finite-numeric coordinate filtering) over in-memory inputs.
 *
 * This is the SQL's contract expressed in TS: it lets the parity test assert
 * `bucketIntoHeatmapCells` ≡ the SQL path without a database, and it reuses
 * the exact `FINITE_NUMERIC_REGEX` guard the SQL applies so "missing /
 * non-numeric coords are excluded consistently" is checked by construction.
 *
 * Inputs mirror the raw DB rows: `pageX`/`pageY` arrive as the JSON-extracted
 * string (or null/missing), `severity` as the column value.
 */
export function aggregateLikeSql(
  rows: Array<{ pageX: unknown; pageY: unknown; severity: string }>,
  cellSize: number,
): HeatmapCell[] {
  const finite = new RegExp(FINITE_NUMERIC_REGEX);
  const grid = new Map<string, { count: number; severities: Record<string, number> }>();

  for (const { pageX, pageY, severity } of rows) {
    // `target->>'k'` yields text; emulate by stringifying numeric inputs and
    // rejecting anything the regex (and thus `::numeric`) would reject.
    const sx = coordToText(pageX);
    const sy = coordToText(pageY);
    if (sx === null || sy === null) continue;
    if (!finite.test(sx) || !finite.test(sy)) continue;

    const cellX = Math.floor(Number(sx) / cellSize);
    const cellY = Math.floor(Number(sy) / cellSize);
    const key = `${cellX}:${cellY}`;
    if (!grid.has(key)) grid.set(key, { count: 0, severities: {} });
    const cell = grid.get(key)!;
    cell.count++;
    cell.severities[severity] = (cell.severities[severity] ?? 0) + 1;
  }

  return Array.from(grid.entries())
    .map(([key, data]) => {
      const [cx, cy] = key.split(':').map(Number);
      return { x: cx! * cellSize, y: cy! * cellSize, ...data };
    })
    .sort((a, b) => b.count - a.count);
}

/**
 * Emulate Postgres JSONB `->>'key'` text extraction for a coordinate value:
 * numbers become their text form, strings pass through, and null/undefined
 * (missing key) become `null`. Non-finite JS numbers (`NaN`, `Infinity`)
 * stringify to `"NaN"`/`"Infinity"`, which the numeric regex rejects — the
 * same outcome as JSON, which can't even represent them.
 */
function coordToText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  return null;
}
