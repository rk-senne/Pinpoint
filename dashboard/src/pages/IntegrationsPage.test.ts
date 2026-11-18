// @vitest-environment jsdom
/**
 * IntegrationsPage.test.ts — Mission B1 (XSS) + B4/GAP-8 (theme tokens).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BRAND_COLORS, STATUS_PILL_COLORS } from '@pinpoint/shared';
import { mountIntegrationsPage } from './IntegrationsPage';
import { resetStores } from '../lib/stores';

const TEMPLATES: Record<string, string> = {
  'tpl-integrations-page': `<div data-role="root"><div data-role="integrations-grid"></div></div>`,
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

function stubFetch(integrations: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/integrations')) {
        return Promise.resolve(
          new Response(JSON.stringify({ integrations }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }),
  );
}

async function flush(): Promise<void> {
  // Let the async load()/apiFetch chain (fetch + .json()) settle, including
  // any macrotask boundary, before asserting on the rendered grid.
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

/** Normalise a CSS color the way jsdom reports it back from `style.*`. */
function cssColor(value: string): string {
  const probe = document.createElement('div');
  probe.style.background = value;
  return probe.style.background;
}

beforeEach(() => {
  document.body.innerHTML = '';
  installTemplates();
  resetStores();
  history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('IntegrationsPage — render + XSS', () => {
  it('renders one card per provider and marks connected ones', async () => {
    stubFetch([{ id: 'i1', provider: 'slack', enabled: true, config: {} }]);
    const root = document.createElement('div');
    document.body.appendChild(root);

    const teardown = mountIntegrationsPage(root);
    await flush();

    const grid = root.querySelector('[data-role="integrations-grid"]')!;
    expect(grid.children.length).toBe(4); // slack, jira, linear, github
    expect(grid.textContent).toContain('Connected');
    expect(grid.textContent).toContain('Disconnected');
    teardown();
  });

  it('renders malicious integration config keys as inert text', async () => {
    const payloadKey = '<img src=x onerror=alert(1)>';
    stubFetch([
      { id: 'i1', provider: 'jira', enabled: false, config: { [payloadKey]: 'v' } },
    ]);
    const root = document.createElement('div');
    document.body.appendChild(root);

    const teardown = mountIntegrationsPage(root);
    await flush();

    const grid = root.querySelector('[data-role="integrations-grid"]')!;
    expect(grid.querySelector('img')).toBeNull();
    expect(grid.textContent).toContain(payloadKey);
    teardown();
  });
});

describe('IntegrationsPage — theme tokens', () => {
  it('uses shared tokens for pills and buttons, no hardcoded hex', async () => {
    stubFetch([{ id: 'i1', provider: 'slack', enabled: true, config: {} }]);
    const root = document.createElement('div');
    document.body.appendChild(root);

    const teardown = mountIntegrationsPage(root);
    await flush();

    const grid = root.querySelector('[data-role="integrations-grid"]')!;
    const html = grid.innerHTML;
    // No hardcoded brand/status hex literals remain.
    for (const hex of ['#4f46e5', '#dc2626', '#16a34a', '#dcfce7', '#f3f4f6']) {
      expect(html.toLowerCase()).not.toContain(hex);
    }

    // Connect/disconnect button background resolves to a brand token.
    const btn = grid.querySelector('button')!;
    const bg = (btn as HTMLElement).style.background;
    expect([cssColor(BRAND_COLORS.primary), cssColor(BRAND_COLORS.danger)]).toContain(bg);

    // Connected pill bg is the positive-status token.
    const pill = Array.from(grid.querySelectorAll('span')).find((s) =>
      s.textContent === 'Connected',
    ) as HTMLElement;
    expect(pill.style.background).toBe(cssColor(STATUS_PILL_COLORS.positive.bg));
    teardown();
  });
});
