/**
 * HeatmapOverlay — renders a grid of colored divs representing annotation
 * density by page coordinates. Fetches heatmap data from the server and
 * visualizes it with opacity-scaled, severity-colored cells.
 */

import { apiFetch } from '../lib/api';
import { cloneTemplate } from '../lib/render';

interface HeatmapCell {
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
  critical: '#e53e3e',
  major: '#dd6b20',
  minor: '#d69e2e',
  informational: '#3182ce',
};

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

    for (const cell of data.cells) {
      const div = document.createElement('div');
      const color = SEVERITY_COLOR[worstSeverity(cell.severities)] ?? '#3182ce';
      const opacity = Math.max(0.15, cell.count / maxCount);
      div.style.cssText = `position:absolute;left:${cell.x}px;top:${cell.y}px;width:${data.cellSize}px;height:${data.cellSize}px;background:${color};opacity:${opacity};border-radius:2px;`;
      div.title = `Count: ${cell.count}\n${Object.entries(cell.severities).map(([s, c]) => `${s}: ${c}`).join('\n')}`;
      grid.appendChild(div);
    }

    // Size the grid to fit all cells
    const maxX = Math.max(...data.cells.map((c) => c.x + data.cellSize));
    const maxY = Math.max(...data.cells.map((c) => c.y + data.cellSize));
    grid.style.width = `${maxX}px`;
    grid.style.height = `${maxY}px`;
  }).catch(() => {
    status.textContent = 'Failed to load heatmap data.';
  });
}
