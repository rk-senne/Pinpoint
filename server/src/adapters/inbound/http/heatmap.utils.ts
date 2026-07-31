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
