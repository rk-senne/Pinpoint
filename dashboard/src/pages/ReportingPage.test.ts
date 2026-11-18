// @vitest-environment jsdom
/**
 * ReportingPage.test.ts — Mission B1 (XSS) + B4/GAP-8 (theme tokens).
 *
 * Proves the team-activity list renders member emails as inert text (an
 * `<img onerror>` / `<script>` payload never becomes live DOM) and that the
 * volume sparkline bars use the shared brand token rather than a hardcoded
 * hex literal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BRAND_COLORS } from '@pinpoint/shared';
import { mountReportingPage } from './ReportingPage';
import { resetStores } from '../lib/stores';

const TEMPLATES: Record<string, string> = {
  'reporting-page': `<div data-role="root"><div data-slot="cards"></div></div>`,
  'reporting-card': `
    <div data-role="card">
      <h3 data-slot="title"></h3>
      <div data-slot="value"></div>
      <div data-slot="detail"></div>
    </div>`,
  'app-layout': `
    <div class="fl-app-layout">
      <header><span data-slot="currentUser"></span>
        <button type="button" data-action="logout">Logout</button></header>
      <div><aside data-slot="sidebar"></aside><main data-slot="content"></main></div>
    </div>`,
  'tpl-project-list-sidebar': `
    <div data-role="root">
      <button type="button" data-action="selectActive" data-role="tab-active">active</button>
      <button type="button" data-action="selectArchived" data-role="tab-archived">archived</button>
      <input type="text" data-action="input:search" data-role="search" />
      <div data-role="list"></div>
      <button type="button" data-action="openCreate" data-role="create">+ Create</button>
    </div>`,
};

function installTemplates(): void {
  for (const [id, html] of Object.entries(TEMPLATES)) {
    const tpl = document.createElement('template');
    tpl.id = id;
    tpl.innerHTML = html;
    document.body.appendChild(tpl);
  }
}

function makeApiFetch(overview: unknown) {
  return vi.fn(async () => overview) as unknown as typeof import('../lib/api').apiFetch;
}

beforeEach(() => {
  document.body.innerHTML = '';
  installTemplates();
  resetStores();
  history.replaceState(null, '', '/');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const XSS_EMAIL = '<img src=x onerror=alert(1)>@evil.test';
const SCRIPT_EMAIL = '<script>alert(1)</script>@evil.test';

function sampleOverview(emails: string[]) {
  return {
    volume: [
      { date: '2026-11-01', count: 3 },
      { date: '2026-11-02', count: 7 },
    ],
    resolution: { total: 10, resolved: 4, rate: 40, avgHours: 12 },
    teamActivity: emails.map((email, i) => ({
      user_id: `u${i}`,
      email,
      annotations: i + 1,
      comments: i,
    })),
  };
}

describe('ReportingPage — team activity XSS safety', () => {
  it('renders a malicious member email as inert text, not live DOM', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const teardown = mountReportingPage(root, {}, {
      apiFetch: makeApiFetch(sampleOverview([XSS_EMAIL, SCRIPT_EMAIL])),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
    const text = root.textContent ?? '';
    expect(text).toContain(XSS_EMAIL);
    expect(text).toContain(SCRIPT_EMAIL);

    teardown();
  });
});

describe('ReportingPage — theme token for sparkline', () => {
  it('builds sparkline bars with the shared brand token, no hardcoded indigo', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const teardown = mountReportingPage(root, {}, {
      apiFetch: makeApiFetch(sampleOverview(['a@b.test'])),
    });
    await Promise.resolve();
    await Promise.resolve();

    const bars = Array.from(root.querySelectorAll('div')).filter((d) =>
      d.style.cssText.includes('width: 4px'),
    );
    expect(bars.length).toBeGreaterThan(0);
    const probe = document.createElement('div');
    probe.style.background = BRAND_COLORS.primary;
    const expectedBg = probe.style.background;
    for (const bar of bars) {
      expect(bar.style.background).toBe(expectedBg);
    }
    // No hardcoded indigo literal left in the rendered subtree.
    expect(root.innerHTML).not.toContain('#4f46e5');

    teardown();
  });
});

describe('ReportingPage — error state', () => {
  it('shows a failure message when the fetch rejects', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const failing = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof import('../lib/api').apiFetch;

    const teardown = mountReportingPage(root, {}, { apiFetch: failing });
    await Promise.resolve();
    await Promise.resolve();

    expect(root.textContent).toContain('Failed to load reports.');
    teardown();
  });
});

describe('ReportingPage — empty state', () => {
  it('shows the shared empty state (no "null%" card) when the org has no activity yet', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const teardown = mountReportingPage(root, {}, {
      apiFetch: makeApiFetch({
        volume: [],
        // Postgres counts arrive as strings; rate is null with nothing reported.
        resolution: { total: '0', resolved: '0', rate: null, avgHours: null },
        teamActivity: [{ user_id: 'u1', email: 'me@example.test', annotations: '0', comments: '0' }],
      }),
    });
    await Promise.resolve();
    await Promise.resolve();

    const cards = root.querySelector('[data-slot="cards"]')!;
    expect(cards.querySelector('.pp-empty-state')).not.toBeNull();
    expect(cards.textContent).toContain('No report data yet');
    expect(cards.textContent).not.toMatch(/null|NaN|undefined/);
    expect(cards.querySelector('[data-role="card"]')).toBeNull();
    teardown();
  });

  it('renders a dash instead of "null%" when data exists but no rate is available', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const teardown = mountReportingPage(root, {}, {
      apiFetch: makeApiFetch({
        volume: [{ date: '2026-11-01', count: 2 }],
        resolution: { total: '2', resolved: '0', rate: null, avgHours: null },
        teamActivity: [],
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(root.textContent).not.toContain('null');
    expect(root.textContent).toContain('—');
    teardown();
  });
});
