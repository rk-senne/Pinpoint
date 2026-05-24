// @vitest-environment jsdom
/**
 * Unit tests for the vanilla `mountAppLayout` shell (task 18.5).
 *
 * Validates: Requirements 31.1
 *
 * Covers:
 * - Cloning the `#app-layout` template into the root.
 * - Mounting a caller-provided content node into the content slot.
 * - Mounting the project sidebar into the sidebar slot.
 * - Binding the top-bar current-user label to `authStore.currentUser`.
 * - Logout: calls `POST /api/v1/auth/logout`, clears the token, resets
 *   stores, and navigates to `/auth`.
 * - Logo click: navigates to `/` even when the router has not been started.
 * - The teardown function unsubscribes signal updates and removes the
 *   shell from the DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { User } from '@pinpoint/shared';

import { mountAppLayout } from './AppLayout';
import { authStore, resetStores, setCurrentUser } from '../lib/stores';
import { setToken, getToken } from '../lib/auth';

// --- Test fixtures ----------------------------------------------------------

/**
 * Mirror only the structure the components read from `index.html`. The
 * `data-action`/`data-slot` attributes are the public API; the wrapper
 * markup can be simpler than the production HTML.
 */
const TEMPLATES: Record<string, string> = {
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

const sampleUser: User = {
  id: 'user-1',
  email: 'alice@example.test',
  name: 'Alice',
  notificationPreferences: {
    newAnnotation: true,
    newComment: true,
    promotedToOwner: true,
    projectDeleted: true,
  },
  createdAt: '2024-01-01T00:00:00.000Z',
};

/**
 * Fetch stub. Returns an empty array for `GET /projects` (the sidebar
 * load) and an empty object for everything else. Tests that need to
 * inspect specific calls can override the default by stubbing again.
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

// --- Tests ------------------------------------------------------------------

describe('mountAppLayout', () => {
  it('mounts the layout template into the root element', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const content = document.createElement('section');
    content.id = 'page-body';

    mountAppLayout(root, content);

    expect(root.querySelector('.fl-app-layout')).not.toBeNull();
    expect(root.querySelector('header')).not.toBeNull();
    expect(root.querySelector('main')).not.toBeNull();
  });

  it('places the caller-provided content node into the content slot', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const content = document.createElement('section');
    content.id = 'page-body';
    content.textContent = 'route-content';

    mountAppLayout(root, content);

    const slot = root.querySelector('[data-slot="content"]')!;
    expect(slot.firstElementChild).toBe(content);
    expect(slot.textContent).toContain('route-content');
  });

  it('mounts the project sidebar into the sidebar slot', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    mountAppLayout(root, document.createElement('div'));

    const sidebarSlot = root.querySelector('[data-slot="sidebar"]')!;
    expect(sidebarSlot.querySelector('[data-role="root"]')).not.toBeNull();
    expect(sidebarSlot.querySelector('[data-role="search"]')).not.toBeNull();
  });

  it('binds the current-user label to authStore.currentUser', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    setCurrentUser(sampleUser);
    mountAppLayout(root, document.createElement('div'));

    const label = root.querySelector('[data-slot="currentUser"]')!;
    expect(label.textContent).toBe('Alice');

    // Change the user — label updates without re-mounting.
    setCurrentUser({ ...sampleUser, name: 'Alex' });
    expect(label.textContent).toBe('Alex');

    // Falls back to the email when the name is empty.
    setCurrentUser({ ...sampleUser, name: '' });
    expect(label.textContent).toBe('alice@example.test');

    // Renders empty when the user is signed out.
    setCurrentUser(null);
    expect(label.textContent).toBe('');
  });

  it('returns a teardown that removes the shell and stops user-label updates', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    setCurrentUser(sampleUser);
    const teardown = mountAppLayout(root, document.createElement('div'));

    const labelBefore = root.querySelector('[data-slot="currentUser"]')!;
    expect(labelBefore.textContent).toBe('Alice');

    teardown();
    expect(root.querySelector('.fl-app-layout')).toBeNull();

    // Setting the user after teardown must not reach the (now removed)
    // shell. Re-mount and confirm the new label receives updates so we
    // know the unsubscribe did not leak across mounts.
    setCurrentUser({ ...sampleUser, name: 'Bob' });

    mountAppLayout(root, document.createElement('div'));
    expect(root.querySelector('[data-slot="currentUser"]')!.textContent).toBe('Bob');
  });

  it('clicking the logo navigates to the root path', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    history.replaceState(null, '', '/projects/42');

    mountAppLayout(root, document.createElement('div'));

    const logo = root.querySelector('[data-action="goHome"]') as HTMLElement;
    logo.click();

    expect(location.pathname).toBe('/');
  });

  it('logout calls /auth/logout, clears the token, resets stores, and navigates to /auth', async () => {
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    const root = document.createElement('div');
    document.body.appendChild(root);
    setToken('jwt-token');
    setCurrentUser(sampleUser);

    mountAppLayout(root, document.createElement('div'));

    const button = root.querySelector('[data-action="logout"]') as HTMLButtonElement;
    button.click();

    // Wait a microtask cycle for the async logout handler to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const logoutCalls = fetchSpy.mock.calls.filter((call) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL).toString();
      return url.endsWith('/api/v1/auth/logout');
    });
    expect(logoutCalls).toHaveLength(1);
    const init = (logoutCalls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('POST');

    expect(getToken()).toBeNull();
    expect(authStore.currentUser.get()).toBeNull();
    expect(authStore.isAuthenticated.get()).toBe(false);
    expect(location.pathname).toBe('/auth');
  });

  it('logout still clears local state when the server call fails', async () => {
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 500 }),
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const root = document.createElement('div');
    document.body.appendChild(root);
    setToken('jwt-token');
    setCurrentUser(sampleUser);

    mountAppLayout(root, document.createElement('div'));

    const button = root.querySelector('[data-action="logout"]') as HTMLButtonElement;
    button.click();

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(getToken()).toBeNull();
    expect(authStore.currentUser.get()).toBeNull();
    expect(location.pathname).toBe('/auth');
  });

  it('throws a clear error when the template is missing', () => {
    document.getElementById('app-layout')!.remove();
    const root = document.createElement('div');
    document.body.appendChild(root);

    expect(() => mountAppLayout(root, document.createElement('div'))).toThrow(
      /no <template> element found with id "app-layout"/,
    );
  });
});
