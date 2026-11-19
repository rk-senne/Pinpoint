// @vitest-environment jsdom
/**
 * Unit tests for `mountHeatmapOverlay` (GAP 2 — UI coverage).
 *
 * The overlay clones `#tpl-heatmap-overlay`, fetches
 * `GET /projects/:id/heatmap`, and renders one absolutely-positioned,
 * severity-coloured, opacity-scaled `<div>` per returned cell. These tests
 * cover mount/render, the primary interaction (cell rendering + intensity from
 * a sample `cells[]`), and the empty/error states.
 *
 * `apiFetch` is mocked at the module boundary so the component's fetch is a
 * controllable, synchronous-ish promise — no global `fetch` stub needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable apiFetch mock. Each test sets `apiFetchImpl`.
let apiFetchImpl: (path: string) => Promise<unknown>;
vi.mock('../lib/api', () => ({
  apiFetch: (path: string) => apiFetchImpl(path),
}));

import { fitScale, mountHeatmapOverlay, pageExtent } from './HeatmapOverlay';

const HEATMAP_TEMPLATE = `
  <div>
    <p data-slot="heatmap-status"></p>
    <div data-role="heatmap-grid"></div>
  </div>
`;

function installTemplate(): void {
  const tpl = document.createElement('template');
  tpl.id = 'tpl-heatmap-overlay';
  tpl.innerHTML = HEATMAP_TEMPLATE;
  document.body.appendChild(tpl);
}

/** Flush the microtask queue so the component's `.then`/`.catch` runs. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '';
  installTemplate();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('pageExtent / fitScale', () => {
  it('derives the page size from the furthest cell and floors it', () => {
    const cells = [
      { x: 0, y: 0, count: 1, severities: {} },
      { x: 800, y: 1200, count: 1, severities: {} },
    ];
    expect(pageExtent(cells, 40)).toEqual({ width: 840, height: 1240 });
    expect(pageExtent([{ x: 0, y: 0, count: 1, severities: {} }], 20)).toEqual({ width: 240, height: 180 });
  });

  it('scales down to fit but never up, and ignores unmeasured containers', () => {
    expect(fitScale(420, 840)).toBe(0.5);
    expect(fitScale(2000, 840)).toBe(1);
    expect(fitScale(0, 840)).toBe(1);
  });
});

describe('mountHeatmapOverlay', () => {
  describe('render', () => {
    it('clones the template and shows the loading status immediately', () => {
      apiFetchImpl = () => new Promise(() => {}); // never resolves
      const container = document.createElement('div');
      document.body.appendChild(container);

      mountHeatmapOverlay(container, 'proj-1');

      const status = container.querySelector('[data-slot="heatmap-status"]');
      expect(container.querySelector('[data-role="heatmap-grid"]')).not.toBeNull();
      expect(status?.textContent).toBe('Loading heatmap…');
    });

    it('requests the heatmap endpoint scoped to the project id', () => {
      const spy = vi.fn(() => new Promise<unknown>(() => {}));
      apiFetchImpl = spy;
      const container = document.createElement('div');
      document.body.appendChild(container);

      mountHeatmapOverlay(container, 'proj-42');

      expect(spy).toHaveBeenCalledWith('/projects/proj-42/heatmap');
    });
  });

  describe('cell rendering + intensity (primary interaction)', () => {
    it('renders one cell div per cell, colored by worst severity and scaled by count', async () => {
      apiFetchImpl = () =>
        Promise.resolve({
          cellSize: 20,
          totalAnnotations: 5,
          cells: [
            // worst severity = critical (#e53e3e), max count -> opacity 1
            { x: 0, y: 0, count: 4, severities: { critical: 1, minor: 3 } },
            // worst severity = informational (#3182ce), count 1/4 -> opacity 0.25
            { x: 40, y: 60, count: 1, severities: { informational: 1 } },
          ],
        });
      const container = document.createElement('div');
      document.body.appendChild(container);

      mountHeatmapOverlay(container, 'proj-1');
      await flush();

      const grid = container.querySelector('[data-role="heatmap-grid"]')!;
      const cells = grid.querySelectorAll('[data-role="heatmap-cell"]');
      expect(cells).toHaveLength(2);

      const first = cells[0] as HTMLElement;
      expect(first.style.left).toBe('0px');
      expect(first.style.top).toBe('0px');
      expect(first.style.width).toBe('20px');
      // Highest-priority severity present (critical) drives the colour.
      expect(first.style.background).toBe('var(--pp-severity-critical)');
      expect(first.style.opacity).toBe('1');
      // Tooltip summarises count + per-severity breakdown.
      expect(first.title).toContain('Count: 4');

      const second = cells[1] as HTMLElement;
      expect(second.style.left).toBe('40px');
      expect(second.style.background).toBe('var(--pp-severity-info)');
      expect(second.style.opacity).toBe('0.25');

      // Status line reflects the aggregate totals.
      const status = container.querySelector('[data-slot="heatmap-status"]');
      expect(status?.textContent).toBe('5 annotations across 2 cells');

      // The page backdrop is sized from the furthest cell (x/y + cellSize),
      // floored at the minimum backdrop size.
      expect((grid as HTMLElement).style.width).toBe('240px');
      expect((grid as HTMLElement).style.height).toBe('180px');
      expect(grid.classList.contains('pp-heatmap__page')).toBe(true);
      expect(grid.querySelector('.pp-heatmap__grid')).not.toBeNull();
      // A legend names the severities and the density ramp.
      const legend = container.querySelector('[data-role="heatmap-legend"]')!;
      expect(legend.textContent).toContain('Critical');
      expect(legend.textContent).toContain('More annotations');
    });

    it('floors opacity at 0.15 for the least-dense cell', async () => {
      apiFetchImpl = () =>
        Promise.resolve({
          cellSize: 10,
          totalAnnotations: 101,
          cells: [
            { x: 0, y: 0, count: 100, severities: { major: 100 } },
            { x: 10, y: 0, count: 1, severities: { major: 1 } }, // 1/100 < 0.15 -> 0.15
          ],
        });
      const container = document.createElement('div');
      document.body.appendChild(container);

      mountHeatmapOverlay(container, 'proj-1');
      await flush();

      const cells = container.querySelectorAll('[data-role="heatmap-cell"]');
      expect((cells[1] as HTMLElement).style.opacity).toBe('0.15');
    });
  });

  describe('empty / error state', () => {
    it('shows an empty-state message and renders no cells when cells[] is empty', async () => {
      apiFetchImpl = () =>
        Promise.resolve({ cellSize: 20, totalAnnotations: 0, cells: [] });
      const container = document.createElement('div');
      document.body.appendChild(container);

      mountHeatmapOverlay(container, 'proj-1');
      await flush();

      const status = container.querySelector('[data-slot="heatmap-status"]');
      expect(status?.textContent).toBe('No annotation position data available.');
      expect(container.querySelectorAll('[data-role="heatmap-cell"]')).toHaveLength(0);
    });

    it('shows a failure message when the fetch rejects', async () => {
      apiFetchImpl = () => Promise.reject(new Error('network'));
      const container = document.createElement('div');
      document.body.appendChild(container);

      mountHeatmapOverlay(container, 'proj-1');
      await flush();

      const status = container.querySelector('[data-slot="heatmap-status"]');
      expect(status?.textContent).toBe('Failed to load heatmap data.');
    });
  });
});
