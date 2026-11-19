// @vitest-environment jsdom
/**
 * IntegrationsPage.test.ts — Mission B1 (XSS) + B4/GAP-8 (theme tokens).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BRAND_COLORS, STATUS_PILL_COLORS } from '@pinpoint/shared';
import { mountIntegrationsPage, navigation } from './IntegrationsPage';
import * as toast from '../components/Toast';
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
    expect(grid.children.length).toBe(6); // github, jira, linear, clickup, asana, slack
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


// ---------------------------------------------------------------------------
// Connect → OAuth redirect, 501 message, Finish-setup picker
// ---------------------------------------------------------------------------

interface Call { method: string; url: string; body?: unknown }

/** Route-table fetch stub: `"METHOD /path"` → [status, json]. Records every call. */
function stubApi(table: Record<string, [number, unknown] | (() => [number, unknown])>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = (typeof input === 'string' ? input : input.toString()).replace('/api/v1', '');
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const hit = table[`${method} ${url}`];
      if (!hit) return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      const [status, json] = typeof hit === 'function' ? hit() : hit;
      return Promise.resolve(new Response(JSON.stringify(json), { status }));
    }),
  );
  return calls;
}

function mount(): { root: HTMLElement; grid: HTMLElement; teardown: () => void } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const teardown = mountIntegrationsPage(root);
  return { root, grid: root.querySelector('[data-role="integrations-grid"]') as HTMLElement, teardown };
}

describe('IntegrationsPage — connect starts the OAuth flow', () => {
  it('navigates to the provider redirectUrl and does NOT claim success', async () => {
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => {});
    const toastSpy = vi.spyOn(toast, 'showToast');
    stubApi({
      'GET /integrations': [200, { integrations: [] }],
      'POST /integrations/github/connect': [200, { redirectUrl: 'https://github.com/login/oauth/authorize?state=s' }],
    });
    const { grid, teardown } = mount();
    await flush();

    (grid.querySelector('[data-connect="github"]') as HTMLButtonElement).click();
    await flush();

    expect(assign).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?state=s');
    expect(toastSpy).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Integration connected' }));
    teardown();
  });

  it('shows a clear admin message on 501 INTEGRATION_NOT_CONFIGURED', async () => {
    const assign = vi.spyOn(navigation, 'assign').mockImplementation(() => {});
    stubApi({
      'GET /integrations': [200, { integrations: [] }],
      'POST /integrations/jira/connect': [501, { error: { code: 'INTEGRATION_NOT_CONFIGURED', message: 'not configured' } }],
    });
    const { grid, teardown } = mount();
    await flush();

    (grid.querySelector('[data-connect="jira"]') as HTMLButtonElement).click();
    await flush();

    const notice = grid.querySelector('[data-provider="jira"] [data-role="connect-not-configured"]');
    expect(notice?.textContent).toBe('Ask your admin to configure Jira — see INTEGRATIONS_SETUP.md');
    expect(assign).not.toHaveBeenCalled();
    teardown();
  });

  it('lists ClickUp and Asana, and Slack last', async () => {
    stubApi({ 'GET /integrations': [200, { integrations: [] }] });
    const { grid, teardown } = mount();
    await flush();
    const order = Array.from(grid.children).map((c) => (c as HTMLElement).dataset.provider);
    expect(order).toEqual(['github', 'jira', 'linear', 'clickup', 'asana', 'slack']);
    teardown();
  });
});

describe('IntegrationsPage — Finish setup', () => {
  const targets = [
    { id: 'a/one', label: 'acme/one', config: { owner: 'acme', repo: 'one' } },
    { id: 'a/two', label: 'acme/<b>two</b>', config: { owner: 'acme', repo: 'two' } },
  ];

  it('opens the picker automatically after ?connected=, saves the chosen target via PATCH, then reloads', async () => {
    history.replaceState(null, '', '/integrations?connected=github');
    let connectedConfig: Record<string, unknown> = { scope: 'repo' };
    const calls = stubApi({
      'GET /integrations': () => [200, { integrations: [{ id: 'i1', provider: 'github', enabled: true, config: connectedConfig }] }],
      'GET /integrations/github/targets': [200, { targets }],
      'PATCH /integrations/github': () => {
        connectedConfig = { scope: 'repo', owner: 'acme', repo: 'two' };
        return [200, {}];
      },
    });
    const { grid, teardown } = mount();
    await flush();
    await flush();

    // The one-shot query params are gone from the address bar.
    expect(window.location.search).toBe('');
    expect(calls.some((c) => c.method === 'GET' && c.url === '/integrations/github/targets')).toBe(true);

    const select = grid.querySelector('[data-role="target-select"]') as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    // Provider-supplied labels render as inert text.
    expect(select.options[1]!.textContent).toBe('acme/<b>two</b>');
    expect(grid.querySelector('option b')).toBeNull();

    select.value = '1';
    (grid.querySelector('[data-role="target-save"]') as HTMLButtonElement).click();
    await flush();
    await flush();

    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('/integrations/github');
    expect(patch.body).toEqual({ config: { owner: 'acme', repo: 'two' } });
    // After saving, the picker closes and the card offers "Change target" rather than "Finish setup".
    expect(grid.querySelector('[data-role="setup-panel"]')).toBeNull();
    expect((grid.querySelector('[data-setup="github"]') as HTMLElement).textContent).toBe('Change target');
    teardown();
  });

  it('a connected integration without a target offers "Finish setup" and loads targets on click', async () => {
    const calls = stubApi({
      'GET /integrations': [200, { integrations: [{ id: 'i1', provider: 'linear', enabled: true, config: {} }] }],
      'GET /integrations/linear/targets': [200, { targets: [{ id: 't', label: 'Core', config: { teamId: 't' } }] }],
    });
    const { grid, teardown } = mount();
    await flush();

    expect(grid.querySelector('[data-provider="linear"] [data-role="setup-hint"]')).not.toBeNull();
    const btn = grid.querySelector('[data-setup="linear"]') as HTMLButtonElement;
    expect(btn.textContent).toBe('Finish setup');
    btn.click();
    await flush();

    expect(calls.some((c) => c.url === '/integrations/linear/targets')).toBe(true);
    expect(grid.querySelector('[data-role="target-select"]')).not.toBeNull();
    teardown();
  });

  it('Slack has no Finish setup step; a fully configured integration shows "Change target"', async () => {
    stubApi({
      'GET /integrations': [200, { integrations: [
        { id: 'i1', provider: 'slack', enabled: true, config: {} },
        { id: 'i2', provider: 'jira', enabled: true, config: { cloudId: 'c', projectKey: 'WEB' } },
      ] }],
    });
    const { grid, teardown } = mount();
    await flush();
    expect(grid.querySelector('[data-provider="slack"] [data-setup]')).toBeNull();
    expect(grid.querySelector('[data-provider="jira"] [data-role="setup-hint"]')).toBeNull();
    expect(grid.querySelector('[data-provider="jira"] [data-setup]')?.textContent).toBe('Change target');
    teardown();
  });

  it('shows the provider error inside the picker when targets cannot be loaded', async () => {
    stubApi({
      'GET /integrations': [200, { integrations: [{ id: 'i1', provider: 'github', enabled: true, config: {} }] }],
      'GET /integrations/github/targets': [502, { error: { code: 'PROVIDER_ERROR', message: 'The provider rejected the stored token. Reconnect the integration.' } }],
    });
    const { grid, teardown } = mount();
    await flush();
    (grid.querySelector('[data-setup="github"]') as HTMLButtonElement).click();
    await flush();
    expect(grid.querySelector('[data-role="setup-error"]')?.textContent).toMatch(/Reconnect/);
    teardown();
  });

  it('an empty target list says so instead of rendering an empty select', async () => {
    stubApi({
      'GET /integrations': [200, { integrations: [{ id: 'i1', provider: 'asana', enabled: true, config: {} }] }],
      'GET /integrations/asana/targets': [200, { targets: [] }],
    });
    const { grid, teardown } = mount();
    await flush();
    (grid.querySelector('[data-setup="asana"]') as HTMLButtonElement).click();
    await flush();
    expect(grid.querySelector('[data-role="setup-empty"]')).not.toBeNull();
    expect(grid.querySelector('[data-role="target-select"]')).toBeNull();
    teardown();
  });
});

describe('IntegrationsPage — OAuth return messages', () => {
  it.each([
    ['OAUTH_DENIED', 'did not grant access'],
    ['OAUTH_EXCHANGE_FAILED', 'rejected the authorization'],
  ])('?error=%s toasts a readable message and clears the URL', async (code, fragment) => {
    history.replaceState(null, '', `/integrations?error=${code}&provider=github`);
    const toastSpy = vi.spyOn(toast, 'showToast');
    stubApi({ 'GET /integrations': [200, { integrations: [] }] });
    const { teardown } = mount();
    await flush();
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error', message: expect.stringContaining(fragment) }));
    expect(window.location.search).toBe('');
    teardown();
  });

  it('?error=INTEGRATION_NOT_CONFIGURED names the provider', async () => {
    history.replaceState(null, '', '/integrations?error=INTEGRATION_NOT_CONFIGURED&provider=asana');
    const toastSpy = vi.spyOn(toast, 'showToast');
    stubApi({ 'GET /integrations': [200, { integrations: [] }] });
    const { teardown } = mount();
    await flush();
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ message: 'Ask your admin to configure Asana — see INTEGRATIONS_SETUP.md' }));
    teardown();
  });
});
