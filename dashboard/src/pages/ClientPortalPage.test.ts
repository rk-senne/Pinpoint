// @vitest-environment jsdom
/**
 * ClientPortalPage.test.ts — rendering (XSS-inert, snake_case rows, brand colour
 * safety), empty/error states and the create / edit / toggle / delete flows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountClientPortalPage } from './ClientPortalPage';
import { _resetLazyTemplatesForTests } from '../lib/lazyTemplates';
import { resetStores, loadProjects } from '../lib/stores';

const SHELL_TEMPLATES: Record<string, string> = {
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
  'tpl-project-list-item': `
    <div data-role="row"><div data-role="body"><div data-slot="name" data-role="name"></div>
      <div data-slot="url" data-role="url"></div></div>
      <button type="button" data-action="menu" data-role="menu-button">…</button></div>`,
};

interface Call { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[];
let projectsFixture: unknown[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubApi(portals: unknown[], opts: { failList?: boolean; failPost?: number } = {}): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'GET' && /\/projects(\?|$)/.test(url)) {
        // The sidebar refreshes the project list on mount; keep the fixture.
        return Promise.resolve(json({ data: projectsFixture, pagination: { page: 1, pageSize: 25, total: projectsFixture.length, totalPages: 1 } }));
      }
      if (method === 'GET' && url.includes('/portals')) {
        return Promise.resolve(opts.failList ? json({ error: { message: 'nope' } }, 500) : json({ data: portals }));
      }
      if (method === 'POST' && opts.failPost) {
        return Promise.resolve(json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, opts.failPost));
      }
      if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(json({ portal: {} }, method === 'POST' ? 201 : 200));
    }),
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

function mount(): { root: HTMLElement; teardown: () => void } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return { root, teardown: mountClientPortalPage(root) };
}

const q = <T extends HTMLElement>(root: ParentNode, sel: string): T => root.querySelector(sel) as T;
const click = (el: Element | null): void => (el as HTMLElement).click();
const type = (root: ParentNode, sel: string, value: string): void => {
  const input = q<HTMLInputElement>(root, sel);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const submit = (root: ParentNode): void => {
  q<HTMLFormElement>(root, '[data-role="create-form"]').dispatchEvent(new Event('submit', { cancelable: true }));
};

const PORTAL = {
  id: 'p1',
  project_id: 'pr1',
  title: 'Acme Portal',
  slug: 'acme',
  brand_color: '#0f766e',
  logo_url: null,
  welcome_message: 'Hi',
  active: true,
};

beforeEach(() => {
  document.body.innerHTML = '';
  _resetLazyTemplatesForTests();
  for (const [id, html] of Object.entries(SHELL_TEMPLATES)) {
    const tpl = document.createElement('template');
    tpl.id = id;
    tpl.innerHTML = html;
    document.body.appendChild(tpl);
  }
  resetStores();
  projectsFixture = [];
  history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('ClientPortalPage — rendering', () => {
  it('renders malicious portal title/slug as inert text', async () => {
    const XSS = '<script>alert(1)</script>';
    stubApi([{ ...PORTAL, title: XSS, slug: XSS }]);
    const { root, teardown } = mount();
    await flush();
    const list = q(root, '[data-role="portal-list"]');
    expect(list.querySelector('script')).toBeNull();
    expect(list.textContent).toContain(XSS);
    teardown();
  });

  it('uses the snake_case brand_color for the dot, and falls back for hostile values', async () => {
    stubApi([PORTAL, { ...PORTAL, id: 'p2', brand_color: 'red;} body{display:none' }]);
    const { root, teardown } = mount();
    await flush();
    const dots = Array.from(root.querySelectorAll<HTMLElement>('.pp-dot'));
    expect(dots[0]!.style.background).toBe('rgb(15, 118, 110)');
    expect(dots[1]!.style.background).toBe('rgb(79, 70, 229)'); // #4f46e5 fallback
    expect(root.querySelectorAll('style').length).toBe(0);
    teardown();
  });

  it('shows the shared empty state whose CTA opens the create form', async () => {
    stubApi([]);
    const { root, teardown } = mount();
    await flush();
    const list = q(root, '[data-role="portal-list"]');
    expect(list.querySelector('.pp-empty-state svg[aria-hidden="true"]')).not.toBeNull();
    expect(list.textContent).toContain('No client portals');
    expect(q(root, '[data-role="portal-form"]').hidden).toBe(true);
    click(list.querySelector('.pp-empty-state__cta'));
    expect(q(root, '[data-role="portal-form"]').hidden).toBe(false);
    teardown();
  });

  it('shows a retryable error state', async () => {
    stubApi([], { failList: true });
    const { root, teardown } = mount();
    await flush();
    expect(q(root, '[data-role="portal-list"]').textContent).toContain('Couldn’t load portals.');
    teardown();
  });

  it('fills the project select when projects arrive after mount', async () => {
    stubApi([]);
    const { root, teardown } = mount();
    await flush();
    const select = q<HTMLSelectElement>(root, '[data-role="project-select"]');
    expect(select.options).toHaveLength(1);
    loadProjects([
      { id: 'pr1', name: 'Acme', status: 'active', urls: [] } as never,
      { id: 'pr2', name: 'Old', status: 'archived', urls: [] } as never,
    ]);
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Select a project', 'Acme']);
    teardown();
  });
});

describe('ClientPortalPage — flows', () => {
  it('suggests a slug from the title until the slug is edited by hand', async () => {
    stubApi([]);
    const { root, teardown } = mount();
    await flush();
    click(q(root, '[data-role="create-btn"]'));
    type(root, '#portal-title', 'Northwind: Client Review!');
    expect(q<HTMLInputElement>(root, '#portal-slug').value).toBe('northwind-client-review');
    type(root, '#portal-slug', 'nw');
    type(root, '#portal-title', 'Something else');
    expect(q<HTMLInputElement>(root, '#portal-slug').value).toBe('nw');
    teardown();
  });

  it('shows field errors without calling the API', async () => {
    stubApi([]);
    const { root, teardown } = mount();
    await flush();
    click(q(root, '[data-role="create-btn"]'));
    submit(root);
    await flush();
    expect(q(root, '[data-role="err-projectId"]').textContent).toContain('project');
    expect(q(root, '[data-role="err-title"]').textContent).toContain('title');
    expect(q(root, '[data-role="err-slug"]').textContent).toContain('slug');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    teardown();
  });

  it('creates a portal, omitting blank optional fields (the API rejects logoUrl "")', async () => {
    projectsFixture = [{ id: 'pr1', name: 'Acme', status: 'active', urls: [] }];
    stubApi([]);
    const { root, teardown } = mount();
    await flush();
    click(q(root, '[data-role="create-btn"]'));
    q<HTMLSelectElement>(root, '[data-role="project-select"]').value = 'pr1';
    type(root, '#portal-title', 'Acme Review');
    submit(root);
    await flush();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      projectId: 'pr1',
      title: 'Acme Review',
      slug: 'acme-review',
      brandColor: '#4f46e5',
    });
    expect(q(root, '[data-role="portal-form"]').hidden).toBe(true);
    teardown();
  });

  it('explains a likely duplicate slug when the API fails on the unique index', async () => {
    projectsFixture = [{ id: 'pr1', name: 'Acme', status: 'active', urls: [] }];
    stubApi([], { failPost: 500 });
    const { root, teardown } = mount();
    await flush();
    click(q(root, '[data-role="create-btn"]'));
    q<HTMLSelectElement>(root, '[data-role="project-select"]').value = 'pr1';
    type(root, '#portal-title', 'Dup');
    submit(root);
    await flush();
    const err = q(root, '[data-role="error"]');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain('slug may already be taken');
    expect(q(root, '[data-role="portal-form"]').hidden).toBe(false);
    teardown();
  });

  it('edits a portal via PATCH (slug locked, project hidden)', async () => {
    stubApi([PORTAL]);
    const { root, teardown } = mount();
    await flush();
    click(q(root, '[data-role="portal-edit"]'));
    expect(q(root, '[data-role="form-title"]').textContent).toContain('Acme Portal');
    expect(q<HTMLInputElement>(root, '#portal-slug').disabled).toBe(true);
    expect(q(root, '[data-role="project-field"]').hidden).toBe(true);
    type(root, '#portal-title', 'Acme Renamed');
    submit(root);
    await flush();
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('/portals/p1');
    expect(patch.body).toEqual({
      title: 'Acme Renamed',
      welcomeMessage: 'Hi',
      brandColor: '#0f766e',
      logoUrl: null,
    });
    teardown();
  });

  it('toggles active with PATCH', async () => {
    stubApi([PORTAL]);
    const { root, teardown } = mount();
    await flush();
    click(q(root, '[data-role="portal-toggle"]'));
    await flush();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ active: false });
    expect(q(root, '[data-role="portal-list"]').textContent).toContain('Inactive');
    teardown();
  });

  it('deletes after confirmation and falls back to the empty state', async () => {
    stubApi([PORTAL]);
    const { root, teardown } = mount();
    await flush();
    click(q(root, '[data-role="portal-delete"]'));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    click(q(root, '[data-role="portal-delete-confirm"]'));
    await flush();
    expect(calls.find((c) => c.method === 'DELETE')!.url).toContain('/portals/p1');
    expect(q(root, '[data-role="portal-list"]').textContent).toContain('No client portals');
    teardown();
  });
});
