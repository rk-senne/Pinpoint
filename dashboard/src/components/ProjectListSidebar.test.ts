// @vitest-environment jsdom
//
// Unit tests for the vanilla-TS `ProjectListSidebar` (task 18.6).
//
// The component reads its <template> blocks from `index.html`. The tests
// register the same templates dynamically so this file is independent of the
// production shell. Each test injects a fake `apiFetch` so we never touch the
// network and assert behaviour against the DOM and the projects store.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { Project } from '@pinpoint/shared';

import { mountProjectListSidebar } from './ProjectListSidebar';
import { projectsStore, resetStores } from '../lib/stores';

// ---- Template fixtures ----------------------------------------------
//
// We mirror only the structure the component reads from `index.html`. The
// inline styles from the production shell are dropped — `data-role` /
// `data-action` / `data-slot` attributes are the public API.

const TEMPLATES: Record<string, string> = {
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

interface FakeApi {
  /** All recorded calls in order. */
  calls: Array<{ path: string; init?: RequestInit }>;
  /** Convenience accessor for the last call. */
  last: () => { path: string; init?: RequestInit } | undefined;
  fetch: <T>(path: string, init?: RequestInit) => Promise<T>;
}

function makeFakeApi(
  responses: Record<string, unknown | ((init?: RequestInit) => unknown)> = {},
): FakeApi {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  return {
    calls,
    last: () => calls[calls.length - 1],
    fetch: async <T,>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      const method = init?.method ?? 'GET';
      const key = `${method} ${path}`;
      if (key in responses) {
        const value = responses[key];
        const out = typeof value === 'function' ? (value as (i?: RequestInit) => unknown)(init) : value;
        return out as T;
      }
      if (path in responses) {
        const value = responses[path];
        const out = typeof value === 'function' ? (value as (i?: RequestInit) => unknown)(init) : value;
        return out as T;
      }
      // Default: no-op response. Callers that depend on a payload must
      // configure it explicitly.
      return undefined as T;
    },
  };
}

let host: HTMLDivElement;

beforeEach(() => {
  installTemplates();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  resetStores();
  document.body.innerHTML = '';
});

describe('mountProjectListSidebar — initial render', () => {
  it('fetches `/projects` on mount and populates the active tab list', async () => {
    const projects = [
      makeProject({ id: 'p1', name: 'Active Alpha', status: 'active' }),
      makeProject({ id: 'p2', name: 'Archived Beta', status: 'archived' }),
    ];
    const api = makeFakeApi({ '/projects': projects });

    const handle = mountProjectListSidebar(host, {
      navigate: vi.fn(),
      apiFetch: api.fetch,
    });

    // Wait for the initial fetch microtask to resolve.
    await api.last();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.calls[0]?.path).toBe('/projects');

    const list = host.querySelector('[data-role="list"]')!;
    const names = Array.from(list.querySelectorAll('[data-slot="name"]')).map(
      (n) => n.textContent,
    );
    expect(names).toEqual(['Active Alpha']);

    handle.dispose();
  });

  it('renders an empty-state message when no projects match the active tab', async () => {
    const api = makeFakeApi({ '/projects': [] });

    const handle = mountProjectListSidebar(host, {
      navigate: vi.fn(),
      apiFetch: api.fetch,
    });

    await Promise.resolve();
    await Promise.resolve();

    const list = host.querySelector('[data-role="list"]')!;
    expect(list.textContent).toContain('No projects found.');

    handle.dispose();
  });
});

describe('tabs and search', () => {
  it('switches to the archived tab and shows only archived projects (Req 2.2)', async () => {
    const projects = [
      makeProject({ id: 'p1', name: 'Active Alpha', status: 'active' }),
      makeProject({ id: 'p2', name: 'Archived Beta', status: 'archived' }),
    ];
    const api = makeFakeApi({ '/projects': projects });

    const handle = mountProjectListSidebar(host, {
      navigate: vi.fn(),
      apiFetch: api.fetch,
    });
    await Promise.resolve();
    await Promise.resolve();

    const archivedTab = host.querySelector<HTMLButtonElement>(
      '[data-role="tab-archived"]',
    )!;
    archivedTab.click();

    const names = Array.from(
      host.querySelectorAll('[data-role="list"] [data-slot="name"]'),
    ).map((n) => n.textContent);
    expect(names).toEqual(['Archived Beta']);
    expect(projectsStore.filter.get()).toBe('archived');

    handle.dispose();
  });

  it('filters the visible list by case-insensitive substring (Req 2.3)', async () => {
    const projects = [
      makeProject({ id: 'p1', name: 'Marketing Site', status: 'active' }),
      makeProject({ id: 'p2', name: 'Internal Tool', status: 'active' }),
      makeProject({ id: 'p3', name: 'Mobile App', status: 'active' }),
    ];
    const api = makeFakeApi({ '/projects': projects });

    const handle = mountProjectListSidebar(host, {
      navigate: vi.fn(),
      apiFetch: api.fetch,
    });
    await Promise.resolve();
    await Promise.resolve();

    const search = host.querySelector<HTMLInputElement>('[data-role="search"]')!;
    search.value = 'mark';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    const names = Array.from(
      host.querySelectorAll('[data-role="list"] [data-slot="name"]'),
    ).map((n) => n.textContent);
    expect(names).toEqual(['Marketing Site']);

    handle.dispose();
  });

  it('shows the empty state when the search filter excludes every project', async () => {
    const projects = [
      makeProject({ id: 'p1', name: 'Marketing Site', status: 'active' }),
    ];
    const api = makeFakeApi({ '/projects': projects });

    const handle = mountProjectListSidebar(host, {
      navigate: vi.fn(),
      apiFetch: api.fetch,
    });
    await Promise.resolve();
    await Promise.resolve();

    const search = host.querySelector<HTMLInputElement>('[data-role="search"]')!;
    search.value = 'zzz';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    const list = host.querySelector('[data-role="list"]')!;
    expect(list.textContent).toContain('No projects found.');

    handle.dispose();
  });
});

describe('row click navigation', () => {
  it('navigates to the project detail route on row click', async () => {
    const projects = [makeProject({ id: 'p1', name: 'Alpha' })];
    const api = makeFakeApi({ '/projects': projects });
    const navigate = vi.fn();

    const handle = mountProjectListSidebar(host, {
      navigate,
      apiFetch: api.fetch,
    });
    await Promise.resolve();
    await Promise.resolve();

    const row = host.querySelector<HTMLElement>('[data-role="list"] [data-role="row"]')!;
    row.click();

    expect(navigate).toHaveBeenCalledWith('/projects/p1');

    handle.dispose();
  });
});

describe('context menu', () => {
  it('opens a context menu with the right action set', async () => {
    const projects = [makeProject({ id: 'p1', name: 'Alpha', status: 'active' })];
    const api = makeFakeApi({ '/projects': projects });

    const handle = mountProjectListSidebar(host, {
      navigate: vi.fn(),
      apiFetch: api.fetch,
    });
    await Promise.resolve();
    await Promise.resolve();

    const menuButton = host.querySelector<HTMLElement>(
      '[data-role="list"] [data-role="menu-button"]',
    )!;
    menuButton.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }),
    );

    const menu = document.body.querySelector<HTMLElement>('[data-role="menu"]')!;
    expect(menu).not.toBeNull();
    const labels = Array.from(menu.querySelectorAll('button')).map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).toEqual([
      'Rename',
      'Archive',
      'Delete',
      'Delete page',
      'Project details',
      'Copy link',
      'Open in app',
      'Export project',
    ]);

    handle.dispose();
  });

  it('toggles the archive button label for archived projects', async () => {
    const projects = [makeProject({ id: 'p1', name: 'Alpha', status: 'archived' })];
    const api = makeFakeApi({ '/projects': projects });

    const handle = mountProjectListSidebar(host, {
      navigate: vi.fn(),
      apiFetch: api.fetch,
    });
    // Switch to the archived tab so the row is visible.
    host
      .querySelector<HTMLButtonElement>('[data-role="tab-archived"]')!
      .click();
    await Promise.resolve();
    await Promise.resolve();

    host
      .querySelector<HTMLElement>(
        '[data-role="list"] [data-role="menu-button"]',
      )!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const archiveButton = document.body.querySelector<HTMLButtonElement>(
      '[data-action="archive"]',
    )!;
    expect(archiveButton.textContent).toBe('Unarchive');

    handle.dispose();
  });

  it('archives a project via PUT and refreshes the list (Req 2.5)', async () => {
    const initial = [makeProject({ id: 'p1', name: 'Alpha', status: 'active' })];
    const archived = [{ ...initial[0], status: 'archived' as const }];

    let projectsResponse = initial;
    const api = makeFakeApi({
      '/projects': () => projectsResponse,
      'PUT /projects/p1': () => {
        projectsResponse = archived;
        return undefined;
      },
    });

    const handle = mountProjectListSidebar(host, {
      navigate: vi.fn(),
      apiFetch: api.fetch,
    });
    await Promise.resolve();
    await Promise.resolve();

    host
      .querySelector<HTMLElement>(
        '[data-role="list"] [data-role="menu-button"]',
      )!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.body
      .querySelector<HTMLButtonElement>('[data-action="archive"]')!
      .click();

    // Wait for the chained PUT + refresh.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const putCall = api.calls.find((c) => c.init?.method === 'PUT');
    expect(putCall?.path).toBe('/projects/p1');
    expect(putCall?.init?.body).toBe(JSON.stringify({ status: 'archived' }));

    // The active tab should now be empty because the project moved.
    const list = host.querySelector('[data-role="list"]')!;
    expect(list.textContent).toContain('No projects found.');

    handle.dispose();
  });

  it('deletes a project after confirmation (Req 2.6)', async () => {
    const projects = [makeProject({ id: 'p1', name: 'Alpha' })];
    const api = makeFakeApi({ '/projects': projects });
    const confirmFn = vi.fn().mockReturnValue(true);

    const handle = mountProjectListSidebar(host, {
      navigate: vi.fn(),
      apiFetch: api.fetch,
      confirm: confirmFn,
    });
    await Promise.resolve();
    await Promise.resolve();

    host
      .querySelector<HTMLElement>(
        '[data-role="list"] [data-role="menu-button"]',
      )!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.body
      .querySelector<HTMLButtonElement>('[data-action="delete"]')!
      .click();

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(confirmFn).toHaveBeenCalledOnce();
    const deleteCall = api.calls.find((c) => c.init?.method === 'DELETE');
    expect(deleteCall?.path).toBe('/projects/p1');

    handle.dispose();
  });

  it('does not call DELETE when the user cancels the confirm dialog', async () => {
    const projects = [makeProject({ id: 'p1', name: 'Alpha' })];
    const api = makeFakeApi({ '/projects': projects });

    const handle = mountProjectListSidebar(host, {
      navigate: vi.fn(),
      apiFetch: api.fetch,
      confirm: () => false,
    });
    await Promise.resolve();
    await Promise.resolve();

    host
      .querySelector<HTMLElement>(
        '[data-role="list"] [data-role="menu-button"]',
      )!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.body
      .querySelector<HTMLButtonElement>('[data-action="delete"]')!
      .click();

    await Promise.resolve();

    const deleteCall = api.calls.find((c) => c.init?.method === 'DELETE');
    expect(deleteCall).toBeUndefined();

    handle.dispose();
  });

  it('copies the shareable URL on copy-link and shows a toast (Req 2.8)', async () => {
    const projects = [makeProject({ id: 'p1', name: 'Alpha' })];
    const api = makeFakeApi({ '/projects': projects });
    const writeClipboard = vi.fn().mockResolvedValue(undefined);
    const alertFn = vi.fn();

    const handle = mountProjectListSidebar(host, {
      navigate: vi.fn(),
      apiFetch: api.fetch,
      writeClipboard,
      alert: alertFn,
    });
    await Promise.resolve();
    await Promise.resolve();

    host
      .querySelector<HTMLElement>(
        '[data-role="list"] [data-role="menu-button"]',
      )!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.body
      .querySelector<HTMLButtonElement>('[data-action="copy-link"]')!
      .click();

    await Promise.resolve();
    await Promise.resolve();

    expect(writeClipboard).toHaveBeenCalledWith(
      `${window.location.origin}/projects/p1`,
    );
    expect(alertFn).toHaveBeenCalledWith('Project link copied to clipboard.');

    handle.dispose();
  });
});

describe('create-project dialog', () => {
  it('submits a POST with the entered name and url (Req 2.1)', async () => {
    const api = makeFakeApi({
      'GET /projects': [],
      'POST /projects': { id: 'new', name: 'New One' },
    });

    const handle = mountProjectListSidebar(host, {
      navigate: vi.fn(),
      apiFetch: api.fetch,
    });
    await Promise.resolve();

    host.querySelector<HTMLButtonElement>('[data-role="create"]')!.click();

    const dialog = document.body.querySelector<HTMLElement>(
      '[data-role="overlay"]',
    )!;
    const nameInput = dialog.querySelector<HTMLInputElement>('[data-role="name"]')!;
    const urlInput = dialog.querySelector<HTMLInputElement>('[data-role="url"]')!;
    nameInput.value = 'New One';
    urlInput.value = 'https://example.com';

    dialog
      .querySelector<HTMLFormElement>('[data-role="form"]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    // Wait for submit handler to flush.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const post = api.calls.find((c) => c.init?.method === 'POST');
    expect(post?.path).toBe('/projects');
    expect(JSON.parse((post?.init?.body as string) ?? '{}')).toEqual({
      name: 'New One',
      urls: ['https://example.com'],
    });

    handle.dispose();
  });

  it('shows a validation error when name or url is missing', async () => {
    const api = makeFakeApi({ '/projects': [] });

    const handle = mountProjectListSidebar(host, {
      navigate: vi.fn(),
      apiFetch: api.fetch,
    });
    await Promise.resolve();

    host.querySelector<HTMLButtonElement>('[data-role="create"]')!.click();

    const dialog = document.body.querySelector<HTMLElement>(
      '[data-role="overlay"]',
    )!;
    dialog
      .querySelector<HTMLFormElement>('[data-role="form"]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await Promise.resolve();

    const error = dialog.querySelector<HTMLElement>('[data-role="error"]')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('required');

    // No POST should have fired.
    expect(api.calls.some((c) => c.init?.method === 'POST')).toBe(false);

    handle.dispose();
  });

  it('closes the dialog when Cancel is clicked', async () => {
    const api = makeFakeApi({ '/projects': [] });

    const handle = mountProjectListSidebar(host, {
      navigate: vi.fn(),
      apiFetch: api.fetch,
    });
    await Promise.resolve();

    host.querySelector<HTMLButtonElement>('[data-role="create"]')!.click();
    expect(document.body.querySelector('[data-role="overlay"]')).not.toBeNull();

    document.body
      .querySelector<HTMLButtonElement>('[data-action="cancel"]')!
      .click();
    expect(document.body.querySelector('[data-role="overlay"]')).toBeNull();

    handle.dispose();
  });
});

describe('dispose', () => {
  it('removes DOM, listeners, and store subscriptions', async () => {
    const projects = [makeProject({ id: 'p1', name: 'Alpha' })];
    const api = makeFakeApi({ '/projects': projects });
    const navigate = vi.fn();

    const handle = mountProjectListSidebar(host, {
      navigate,
      apiFetch: api.fetch,
    });
    await Promise.resolve();
    await Promise.resolve();

    handle.dispose();

    expect(host.children).toHaveLength(0);

    // Triggering a store change after dispose must not re-render anything.
    projectsStore.list.set([
      makeProject({ id: 'p2', name: 'Beta' }),
    ]);
    expect(host.querySelectorAll('[data-role="row"]')).toHaveLength(0);
  });
});
