/**
 * HeatmapOverlay — renders a grid of colored divs representing annotation
 * density by page coordinates. Fetches heatmap data from the server and
 * visualizes it with opacity-scaled, severity-colored cells.
 */

import { apiFetch } from '../lib/api';
import { cloneTemplate } from '../lib/render';
import { el } from '@pinpoint/shared';

export interface HeatmapCell {
  x: number;
  y: number;
  count: number;
  severities: Record<string, number>;
}

interface HeatmapResponse {
  cellSize: number;
  totalAnnotations: number;
  cells: HeatmapCell[];
}

const SEVERITY_PRIORITY: Record<string, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  informational: 1,
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: 'var(--pp-severity-critical)',
  major: 'var(--pp-severity-major)',
  minor: 'var(--pp-severity-minor)',
  informational: 'var(--pp-severity-info)',
};

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
  informational: 'Informational',
};

/** Smallest page backdrop so a single annotation still reads as "a page". */
const MIN_PAGE_WIDTH = 240;
const MIN_PAGE_HEIGHT = 180;

function worstSeverity(severities: Record<string, number>): string {
  let worst = 'informational';
  let worstPriority = 0;
  for (const [sev, count] of Object.entries(severities)) {
    if (count > 0 && (SEVERITY_PRIORITY[sev] ?? 0) > worstPriority) {
      worstPriority = SEVERITY_PRIORITY[sev]!;
      worst = sev;
    }
  }
  return worst;
}

/**
 * Page extent implied by the annotation coordinates: the far edge of the
 * furthest cell, floored at a minimum so the backdrop never collapses.
 */
export function pageExtent(cells: HeatmapCell[], cellSize: number): { width: number; height: number } {
  const maxX = Math.max(0, ...cells.map((c) => c.x + cellSize));
  const maxY = Math.max(0, ...cells.map((c) => c.y + cellSize));
  return { width: Math.max(maxX, MIN_PAGE_WIDTH), height: Math.max(maxY, MIN_PAGE_HEIGHT) };
}

/** Scale (<= 1) that fits a page of `pageWidth` into `available` px. */
export function fitScale(available: number, pageWidth: number): number {
  if (!(available > 0) || !(pageWidth > 0)) return 1;
  return Math.min(1, available / pageWidth);
}

function buildLegend(width: number, height: number): HTMLElement {
  const legend = el('ul', { class: 'pp-heatmap__legend', 'aria-label': 'Heatmap legend', 'data-role': 'heatmap-legend' });
  for (const sev of ['critical', 'major', 'minor', 'informational']) {
    const swatch = el('span', { class: 'pp-heatmap__swatch', 'aria-hidden': 'true' });
    swatch.style.background = SEVERITY_COLOR[sev]!;
    legend.appendChild(el('li', {}, [swatch, SEVERITY_LABEL[sev]!]));
  }
  legend.appendChild(
    el('li', {}, [
      'Fewer',
      el('span', { class: 'pp-heatmap__ramp', 'aria-hidden': 'true' }),
      'More annotations',
    ]),
  );
  legend.appendChild(el('li', { class: 'pp-heatmap__extent' }, `Page ≈ ${width} × ${height} px`));
  return legend;
}

export function mountHeatmapOverlay(container: HTMLElement, projectId: string): void {
  const fragment = cloneTemplate('tpl-heatmap-overlay');
  const root = fragment.firstElementChild as HTMLElement;
  container.replaceChildren(root);

  const grid = root.querySelector<HTMLElement>('[data-role="heatmap-grid"]')!;
  const status = root.querySelector<HTMLElement>('[data-slot="heatmap-status"]')!;

  status.textContent = 'Loading heatmap…';

  void apiFetch<HeatmapResponse>(`/projects/${projectId}/heatmap`).then((data) => {
    if (!data.cells.length) {
      status.textContent = 'No annotation position data available.';
      return;
    }
    status.textContent = `${data.totalAnnotations} annotations across ${data.cells.length} cells`;

    const maxCount = Math.max(...data.cells.map((c) => c.count));
    const { width, height } = pageExtent(data.cells, data.cellSize);

    // Page backdrop: faint chrome strip + coordinate grid sized to the page.
    grid.classList.add('pp-heatmap__page');
    grid.style.setProperty('--hm-cell', `${data.cellSize}px`);
    grid.appendChild(el('div', { class: 'pp-heatmap__grid', 'aria-hidden': 'true' }));

    for (const cell of data.cells) {
      const div = document.createElement('div');
      div.setAttribute('data-role', 'heatmap-cell');
      const color = SEVERITY_COLOR[worstSeverity(cell.severities)] ?? SEVERITY_COLOR.informational!;
      const opacity = Math.max(0.15, cell.count / maxCount);
      div.style.cssText = `position:absolute;left:${cell.x}px;top:${cell.y}px;width:${data.cellSize}px;height:${data.cellSize}px;background:${color};opacity:${opacity};border-radius:2px;`;
      div.title = `Count: ${cell.count}\n${Object.entries(cell.severities).map(([s, c]) => `${s}: ${c}`).join('\n')}`;
      grid.appendChild(div);
    }

    grid.style.width = `${width}px`;
    grid.style.height = `${height}px`;

    // Fit the page to the available width (phones) instead of scrolling sideways.
    const stage = el('div', { class: 'pp-heatmap__stage' });
    grid.replaceWith(stage);
    stage.appendChild(grid);
    const applyScale = (): void => {
      const available = (stage.parentElement?.clientWidth ?? 0) || root.clientWidth;
      const scale = fitScale(available, width);
      grid.style.transform = scale < 1 ? `scale(${scale})` : '';
      stage.style.width = `${Math.round(width * scale)}px`;
      stage.style.height = `${Math.round(height * scale)}px`;
    };
    applyScale();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(applyScale).observe(root);

    root.appendChild(buildLegend(width, height));
  }).catch(() => {
    status.textContent = 'Failed to load heatmap data.';
  });
}
