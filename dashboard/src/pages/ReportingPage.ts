/**
 * ReportingPage — dashboard reporting widgets.
 *
 * Fetches GET /api/v1/reports/overview and renders three cards:
 * Feedback Volume, Resolution Rate, and Team Activity.
 */

import { registerTemplates } from '../lib/lazyTemplates';
import templatesHtml from './ReportingPage.templates.html?raw';
import { signal, el, BRAND_COLORS } from '@pinpoint/shared';
import { mountAppLayout } from '../components/AppLayout';
import { apiFetch as defaultApiFetch } from '../lib/api';
import { cloneTemplate, text } from '../lib/render';
import { createEmptyState } from '../components/EmptyState';
import { navigate } from '../lib/router';

interface VolumeEntry {
  date: string;
  count: number;
}

interface ResolutionData {
  /** Postgres counts arrive as strings. */
  total: number | string;
  resolved: number | string;
  /** null while nothing has been reported yet. */
  rate: number | null;
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
  registerTemplates('ReportingPage', templatesHtml);
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
      cardsContainer.style.display = 'block';
    }
  })();

  function renderCards(data: ReportOverview): void {
    const hasData =
      data.volume.some((v) => Number(v.count) > 0) ||
      Number(data.resolution.total) > 0 ||
      data.teamActivity.some((m) => Number(m.annotations) + Number(m.comments) > 0);
    if (!hasData) {
      cardsContainer.style.display = 'block';
      cardsContainer.replaceChildren(
        createEmptyState('no-reports', { onCta: () => navigate('/') }),
      );
      return;
    }
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
    text(rc.querySelector('[data-slot="value"]')!, data.resolution.rate == null ? '—' : `${data.resolution.rate}%`);
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
      // member.email is user-supplied — build via DOM so markup payloads
      // render as inert text, never parsed HTML.
      li.append(
        el('span', {}, member.email),
        el('span', {}, `${member.annotations}a / ${member.comments}c`),
      );
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
      bar.style.cssText = `width: 4px; height: ${h}px; background: ${BRAND_COLORS.primary}; border-radius: 1px;`;
      container.appendChild(bar);
    }
    return container;
  }

  return () => {
    teardownLayout();
    contentRoot.remove();
  };
}
