import { describe, it, expect } from 'vitest';

import { bucketIntoHeatmapCells, type HeatmapInput } from '../heatmap.utils.js';

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
