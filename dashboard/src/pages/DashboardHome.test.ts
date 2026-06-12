// @vitest-environment jsdom
/**
 * Unit tests for the vanilla `mountDashboardHome` page (task 18.7).
 *
 * Validates: Requirements 31.1
 *
 * Covers:
 * - Cloning the home template into the layout's content slot (the layout
 *   shell from `mountAppLayout` wraps the home content).
 * - Empty state visible when `projectsStore.active` is `[]` and the
 *   recent-projects list hidden.
 * - Recent state visible when at least one project exists, listing the
 *   most recently updated projects first and capped at 5 rows.
 * - Recent rows render `data-route` links to `/projects/:id` and clicking
 *   a row navigates via `lib/router`.
 * - The empty-state CTA delegates to the sidebar's create-project button.
 * - Re-renders happen when `projectsStore.active` changes after mount.
 * - Teardown removes the page DOM and detaches every listener.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { Project } from '@pinpoint/shared';

import { mountDashboardHome } from './DashboardHome';
import { loadProjects, resetStores } from '../lib/stores';

// --- Template fixtures ----------------------------------------------------

const TEMPLATES: Record<string, string> = {
  'tpl-dashboard-home': `
    <div data-role="root">
      <h1>Dashboard</h1>
      <div data-role="view-toggle">
        <button data-action="selectList">List</button>
        <button data-action="selectCards">Cards</button>
      </div>
      <section data-section="empty" hidden>
        <h2>No projects yet</h2>
        <button type="button" data-action="createProject" data-role="empty-cta">+ Create Project</button>
      </section>
      <section data-section="recent" hidden>
        <h2>Recent projects</h2>
        <ul data-role="recent-list"></ul>
      </section>
      <div data-role="cards-grid" hidden></div>
    </div>
  `,
  'tpl-dashboard-home-recent-item': `
    <li data-role="recent-item">
      <a data-route data-action="openProject" data-role="recent-link" href="#">
        <span data-slot="name"></span>
        <span data-slot="url"></span>
      </a>
    </li>
  `,
  'app-layout': `
    <div class="fl-app-layout">
      <header>
        <a data-route data-action="goHome" href="/" class="fl-app-layout__logo">Pinpoint</a>
        <div>
          <span data-slot="currentUser"></span>
          <button type="button" data-action="logout">Logout</button>
        </div>
      </header>
      <div class="fl-app-layout__body">
        <aside data-slot="sidebar"></aside>
        <main data-slot="content"></main>
      </div>
    </div>
  `,
  'tpl-project-list-sidebar': `
    <div data-role="root">
      <div>
        <button type="button" data-action="selectActive" data-role="tab-active">active</button>
        <button type="button" data-action="selectArchived" data-role="tab-archived">archived</button>
      </div>
      <input type="text" data-action="input:search" data-role="search" />
      <div data-role="list"></div>
      <button type="button" data-action="openCreate" data-role="create">+ Create Project</button>
    </div>
  `,
  'tpl-project-list-item': `
    <div data-role="row">
      <div data-role="body">
        <div data-slot="name" data-role="name"></div>
        <div data-slot="url" data-role="url"></div>
      </div>
      <button type="button" data-action="menu" data-role="menu-button" aria-label="Actions">⋯</button>
    </div>
  `,
  'tpl-project-list-menu': `
    <div data-role="menu">
      <button type="button" data-action="rename">Rename</button>
      <button type="button" data-action="archive" data-slot="archiveLabel">Archive</button>
      <button type="button" data-action="delete">Delete</button>
      <button type="button" data-action="delete-page">Delete page</button>
      <button type="button" data-action="details">Project details</button>
      <button type="button" data-action="copy-link">Copy link</button>
      <button type="button" data-action="open">Open in app</button>
      <button type="button" data-action="export">Export project</button>
    </div>
  `,
  'tpl-create-project-dialog': `
    <div data-role="overlay" data-action="closeOverlay">
      <div data-role="panel">
        <form data-action="submit:submit" data-role="form">
          <input data-role="name" />
          <input data-role="url" />
          <p data-role="error" hidden></p>
          <button type="button" data-action="cancel">Cancel</button>
          <button type="submit" data-role="submit">Create</button>
        </form>
      </div>
    </div>
  `,
  'tpl-export-project-dialog': `
    <div data-role="overlay" data-action="closeOverlay">
      <div data-role="panel">
        <p data-slot="projectName" data-role="project-name"></p>
        <button type="button" data-action="formatPdf" data-role="format-pdf">pdf</button>
        <button type="button" data-action="formatCsv" data-role="format-csv">csv</button>
        <p data-role="error" hidden></p>
        <div data-role="download" hidden>
          <a data-role="download-link"></a>
        </div>
        <button type="button" data-action="close">Close</button>
        <button type="button" data-action="export" data-role="export-button">Export</button>
      </div>
    </div>
  `,
};

function installTemplates(): void {
  for (const [id, html] of Object.entries(TEMPLATES)) {
    const tpl = document.createElement('template');
    tpl.id = id;
    tpl.innerHTML = html;
    document.body.appendChild(tpl);
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'Project One',
    urls: overrides.urls ?? ['https://example.com'],
    status: overrides.status ?? 'active',
    ownerId: overrides.ownerId ?? 'u1',
    teamId: overrides.teamId,
    createdAt: overrides.createdAt ?? '2025-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2025-01-01T00:00:00.000Z',
  };
}

/**
 * Default fetch stub. The page does not fetch directly, but the
 * `mountAppLayout` shell mounts the project sidebar, which fetches
 * `/api/v1/projects` on mount. We answer it with `[]` so the sidebar
 * doesn't crash; tests that care about specific project data populate
 * `projectsStore` via `loadProjects` directly.
 */
function makeDefaultFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/v1/projects')) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  installTemplates();
  resetStores();
  history.replaceState(null, '', '/');
  vi.stubGlobal('fetch', makeDefaultFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetStores();
  history.replaceState(null, '', '/');
});

// --- Tests ----------------------------------------------------------------

describe('mountDashboardHome', () => {
  it('mounts the layout shell with the home content inside', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    mountDashboardHome(root);

    // Layout chrome from `mountAppLayout`.
    expect(root.querySelector('.fl-app-layout')).not.toBeNull();
    // Home content inside the layout's content slot.
    const contentSlot = root.querySelector('main[data-slot="content"]');
    expect(contentSlot).not.toBeNull();
    expect(
      contentSlot!.querySelector('section[data-section="empty"]'),
    ).not.toBeNull();
    expect(
      contentSlot!.querySelector('section[data-section="recent"]'),
    ).not.toBeNull();
  });

  it('shows the empty state when there are no active projects', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    mountDashboardHome(root);

    const empty = root.querySelector('[data-section="empty"]') as HTMLElement;
    const recent = root.querySelector('[data-section="recent"]') as HTMLElement;
    expect(empty.hidden).toBe(false);
    expect(recent.hidden).toBe(true);

    // The CTA is the recovery action — it must be wired to the sidebar's
    // create-project button.
    expect(empty.querySelector('[data-action="createProject"]')).not.toBeNull();
  });

  it('shows the recent list when projects exist and hides the empty state', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    loadProjects([
      makeProject({ id: 'p1', name: 'Alpha' }),
      makeProject({ id: 'p2', name: 'Beta' }),
    ]);

    mountDashboardHome(root);

    const empty = root.querySelector('[data-section="empty"]') as HTMLElement;
    const recent = root.querySelector('[data-section="recent"]') as HTMLElement;
    expect(empty.hidden).toBe(true);
    expect(recent.hidden).toBe(false);

    const rows = recent.querySelectorAll('[data-role="recent-item"]');
    expect(rows.length).toBe(2);

    // Each row links to /projects/:id with `data-route` so the router
    // intercepts clicks once started.
    const links = Array.from(
      recent.querySelectorAll('a[data-role="recent-link"]'),
    ) as HTMLAnchorElement[];
    const hrefs = links.map((a) => a.getAttribute('href')).sort();
    expect(hrefs).toEqual(['/projects/p1', '/projects/p2']);
    for (const link of links) {
      expect(link.hasAttribute('data-route')).toBe(true);
    }
  });

  it('orders rows by updatedAt descending and caps the list at 5', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    // Seven projects with distinct updatedAt — the most recent five
    // appear in descending order.
    loadProjects([
      makeProject({ id: 'p1', name: '1', updatedAt: '2025-01-01T00:00:00.000Z' }),
      makeProject({ id: 'p2', name: '2', updatedAt: '2025-01-02T00:00:00.000Z' }),
      makeProject({ id: 'p3', name: '3', updatedAt: '2025-01-03T00:00:00.000Z' }),
      makeProject({ id: 'p4', name: '4', updatedAt: '2025-01-04T00:00:00.000Z' }),
      makeProject({ id: 'p5', name: '5', updatedAt: '2025-01-05T00:00:00.000Z' }),
      makeProject({ id: 'p6', name: '6', updatedAt: '2025-01-06T00:00:00.000Z' }),
      makeProject({ id: 'p7', name: '7', updatedAt: '2025-01-07T00:00:00.000Z' }),
    ]);

    mountDashboardHome(root);

    const names = Array.from(
      root.querySelectorAll<HTMLElement>(
        '[data-role="recent-item"] [data-slot="name"]',
      ),
    ).map((el) => el.textContent);

    expect(names).toEqual(['7', '6', '5', '4', '3']);
  });

  it('re-renders when projectsStore.active changes after mount', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    mountDashboardHome(root);

    // Initially empty.
    expect(
      (root.querySelector('[data-section="empty"]') as HTMLElement).hidden,
    ).toBe(false);

    // Adding a project flips to recent.
    loadProjects([makeProject({ id: 'p1', name: 'New project' })]);
    expect(
      (root.querySelector('[data-section="empty"]') as HTMLElement).hidden,
    ).toBe(true);
    expect(
      (root.querySelector('[data-section="recent"]') as HTMLElement).hidden,
    ).toBe(false);
    expect(
      root.querySelector('[data-role="recent-item"] [data-slot="name"]')!
        .textContent,
    ).toBe('New project');

    // Going back to no projects flips back to empty.
    loadProjects([]);
    expect(
      (root.querySelector('[data-section="empty"]') as HTMLElement).hidden,
    ).toBe(false);
    expect(
      (root.querySelector('[data-section="recent"]') as HTMLElement).hidden,
    ).toBe(true);
  });

  it('archived projects do not appear in the recent list', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    loadProjects([
      makeProject({ id: 'p1', name: 'Active', status: 'active' }),
      makeProject({ id: 'p2', name: 'Archived', status: 'archived' }),
    ]);

    mountDashboardHome(root);

    const names = Array.from(
      root.querySelectorAll<HTMLElement>(
        '[data-role="recent-item"] [data-slot="name"]',
      ),
    ).map((el) => el.textContent);

    expect(names).toEqual(['Active']);
  });

  it('clicking a recent row navigates to /projects/:id', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    loadProjects([makeProject({ id: 'abc', name: 'Alpha' })]);
    mountDashboardHome(root);

    const link = root.querySelector(
      '[data-role="recent-link"]',
    ) as HTMLAnchorElement;
    link.click();

    expect(location.pathname).toBe('/projects/abc');
  });

  it('the empty-state CTA clicks the sidebar create-project button', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    mountDashboardHome(root);

    const sidebarCreate = root.querySelector(
      '[data-role="create"][data-action="openCreate"]',
    ) as HTMLButtonElement;
    expect(sidebarCreate).not.toBeNull();

    const clickSpy = vi.spyOn(sidebarCreate, 'click');

    const cta = root.querySelector(
      '[data-action="createProject"]',
    ) as HTMLButtonElement;
    cta.click();

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('teardown removes the page DOM', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    loadProjects([makeProject()]);
    const teardown = mountDashboardHome(root);

    expect(root.querySelector('.fl-app-layout')).not.toBeNull();
    expect(root.querySelector('[data-section="recent"]')).not.toBeNull();

    teardown();

    expect(root.querySelector('.fl-app-layout')).toBeNull();
    expect(root.querySelector('[data-section="recent"]')).toBeNull();
  });

  it('teardown stops further re-renders from changing the page', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const teardown = mountDashboardHome(root);
    teardown();

    // After teardown, mutating the store must not throw or re-render the
    // (now-removed) DOM.
    expect(() =>
      loadProjects([makeProject({ id: 'p1', name: 'After teardown' })]),
    ).not.toThrow();
    expect(root.querySelector('[data-role="recent-item"]')).toBeNull();
  });

  it('throws a clear error when the home template is missing', () => {
    document.getElementById('tpl-dashboard-home')!.remove();
    const root = document.createElement('div');
    document.body.appendChild(root);

    expect(() => mountDashboardHome(root)).toThrow(
      /no <template> element found with id "tpl-dashboard-home"/,
    );
  });
});
