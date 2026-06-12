/**
 * ReportingPage — dashboard reporting widgets.
 *
 * Fetches GET /api/v1/reports/overview and renders three cards:
 * Feedback Volume, Resolution Rate, and Team Activity.
 */

import { signal } from '@pinpoint/shared';
import { mountAppLayout } from '../components/AppLayout';
import { apiFetch as defaultApiFetch } from '../lib/api';
import { cloneTemplate, text } from '../lib/render';

interface VolumeEntry {
  date: string;
  count: number;
}

interface ResolutionData {
  total: number;
  resolved: number;
  rate: number;
  avgHours: number | null;
}

interface TeamMember {
  user_id: string;
  email: string;
  annotations: number;
  comments: number;
}

interface ReportOverview {
  volume: VolumeEntry[];
  resolution: ResolutionData;
  teamActivity: TeamMember[];
}

export function mountReportingPage(
  rootEl: HTMLElement,
  _params: Record<string, string>,
  options: { apiFetch?: typeof defaultApiFetch } = {},
): () => void {
  const apiFetch = options.apiFetch ?? defaultApiFetch;

  const fragment = cloneTemplate('reporting-page');
  const contentRoot = fragment.firstElementChild as HTMLElement;
  const teardownLayout = mountAppLayout(rootEl, contentRoot);
  const cardsContainer = contentRoot.querySelector<HTMLElement>('[data-slot="cards"]')!;

  const loading = signal<boolean>(true);

  void (async () => {
    try {
      const data = await apiFetch<ReportOverview>('/reports/overview');
      loading.set(false);
      renderCards(data);
    } catch {
      loading.set(false);
      cardsContainer.textContent = 'Failed to load reports.';
    }
  })();

  function renderCards(data: ReportOverview): void {
    // Card 1: Feedback Volume
    const totalNew = data.volume.reduce((sum, v) => sum + Number(v.count), 0);
    const volumeCard = cloneTemplate('reporting-card');
    const vc = volumeCard.firstElementChild as HTMLElement;
    text(vc.querySelector('[data-slot="title"]')!, 'Feedback Volume');
    text(vc.querySelector('[data-slot="value"]')!, `${totalNew} new (last 30 days)`);
    // Simple inline bar spark
    const spark = buildBarSpark(data.volume.map((v) => Number(v.count)));
    vc.querySelector('[data-slot="detail"]')!.appendChild(spark);
    cardsContainer.appendChild(vc);

    // Card 2: Resolution Rate
    const resCard = cloneTemplate('reporting-card');
    const rc = resCard.firstElementChild as HTMLElement;
    text(rc.querySelector('[data-slot="title"]')!, 'Resolution Rate');
    text(rc.querySelector('[data-slot="value"]')!, `${data.resolution.rate}%`);
    const avgText = data.resolution.avgHours != null
      ? `Avg resolution: ${data.resolution.avgHours}h`
      : 'No resolved items yet';
    text(rc.querySelector('[data-slot="detail"]')!, avgText);
    cardsContainer.appendChild(rc);

    // Card 3: Team Activity
    const teamCard = cloneTemplate('reporting-card');
    const tc = teamCard.firstElementChild as HTMLElement;
    text(tc.querySelector('[data-slot="title"]')!, 'Team Activity');
    text(tc.querySelector('[data-slot="value"]')!, `Top ${Math.min(5, data.teamActivity.length)} members`);
    const list = document.createElement('ul');
    list.style.cssText = 'list-style: none; padding: 0; margin: 4px 0 0; font-size: 13px;';
    for (const member of data.teamActivity.slice(0, 5)) {
      const li = document.createElement('li');
      li.style.cssText = 'display: flex; justify-content: space-between; padding: 2px 0;';
      li.innerHTML = `<span>${member.email}</span><span>${member.annotations}a / ${member.comments}c</span>`;
      list.appendChild(li);
    }
    tc.querySelector('[data-slot="detail"]')!.appendChild(list);
    cardsContainer.appendChild(tc);
  }

  function buildBarSpark(values: number[]): HTMLElement {
    const max = Math.max(...values, 1);
    const container = document.createElement('div');
    container.style.cssText = 'display: flex; align-items: flex-end; gap: 1px; height: 24px;';
    for (const v of values) {
      const bar = document.createElement('div');
      const h = Math.max(2, Math.round((v / max) * 24));
      bar.style.cssText = `width: 4px; height: ${h}px; background: #4f46e5; border-radius: 1px;`;
      container.appendChild(bar);
    }
    return container;
  }

  return () => {
    teardownLayout();
    contentRoot.remove();
  };
}
