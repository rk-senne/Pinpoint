// @vitest-environment jsdom
/**
 * Unit tests for the vanilla `mountSettingsPage` page (task 18.9).
 *
 * Validates: Requirements 31.1
 *
 * Covers:
 * - Cloning the settings template into the layout's content slot.
 * - Tab switching between Profile, Notifications, and Guidelines.
 * - Profile tab: lazy-load on activation, populate inputs, save via
 *   `PUT /users/me`, surface success and error messages.
 * - Notifications tab: lazy-load preferences, render one toggle per key,
 *   PUT to `/users/me/notifications` on toggle, revert on failure.
 * - Guidelines tab: lazy-load list, render with default badge, create
 *   custom guidelines via `POST /guidelines` and refresh the list.
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

import type { Guideline, NotificationPreferences, User } from '@pinpoint/shared';

import { mountSettingsPage } from './SettingsPage';
import { resetStores } from '../lib/stores';

// --- Template fixtures ----------------------------------------------------
//
// Mirror only the structure the page reads from `index.html`. The
// `data-section`/`data-role`/`data-action`/`data-slot` attributes are the
// public API so tests can drop styling and keep the markup terse.

const TEMPLATES: Record<string, string> = {
  'tpl-settings-page': `
    <div data-role="root">
      <h1>Settings</h1>
      <div data-role="tabs">
        <button type="button" data-action="selectProfile" data-role="tab-profile">Profile</button>
        <button type="button" data-action="selectNotifications" data-role="tab-notifications">Notifications</button>
        <button type="button" data-action="selectGuidelines" data-role="tab-guidelines">Guidelines</button>
        <button type="button" data-action="selectTeams" data-role="tab-teams">Teams</button>
      </div>
      <section data-section="profile" hidden>
        <p data-role="profile-loading">Loading…</p>
        <form data-action="submit:saveProfile" data-role="profile-form" hidden>
          <input type="text" data-role="profile-name" />
          <input type="email" data-role="profile-email" />
          <input type="text" data-role="profile-avatar" />
          <p data-role="profile-message" hidden></p>
          <button type="submit" data-role="profile-submit">Save</button>
        </form>
      </section>
      <section data-section="notifications" hidden>
        <p data-role="notifications-loading">Loading…</p>
        <p data-role="notifications-error" hidden></p>
        <div data-role="notifications-content" hidden>
          <div data-role="notifications-list"></div>
        </div>
      </section>
      <section data-section="guidelines" hidden>
        <p data-role="guidelines-loading">Loading…</p>
        <p data-role="guidelines-error" hidden></p>
        <div data-role="guidelines-content" hidden>
          <h3>All Guidelines</h3>
          <p data-role="guidelines-empty" hidden>No guidelines found.</p>
          <div data-role="guidelines-list"></div>
          <h3>Create Custom Guideline</h3>
          <form data-action="submit:createGuideline" data-role="guideline-form">
            <input type="text" data-role="guideline-name" />
            <textarea data-role="guideline-desc"></textarea>
            <button type="submit" data-role="guideline-submit" disabled>Create Guideline</button>
          </form>
        </div>
      </section>
      <section data-section="teams" hidden>
        <div data-role="teams-container"></div>
      </section>
    </div>
  `,
  'tpl-settings-notification-row': `
    <div data-role="notification-row">
      <span data-slot="label"></span>
      <button
        type="button"
        data-action="toggle"
        data-role="notification-toggle"
        role="switch"
        aria-checked="false"
      >
        <span data-role="notification-knob"></span>
      </button>
    </div>
  `,
  'tpl-settings-guideline-row': `
    <div data-role="guideline-row">
      <div>
        <span data-slot="name"></span>
        <span data-role="default-badge" hidden>Default</span>
      </div>
      <div data-role="description" data-slot="description" hidden></div>
    </div>
  `,
  // The settings page mounts the AppLayout shell which clones these
  // templates as well. We supply minimal versions so the shell mounts.
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

// --- Helpers --------------------------------------------------------------

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: overrides.id ?? 'u1',
    email: overrides.email ?? 'me@test.com',
    name: overrides.name ?? 'Me',
    avatarUrl: overrides.avatarUrl,
    notificationPreferences: overrides.notificationPreferences ?? {
      newAnnotation: true,
      newComment: true,
      promotedToOwner: true,
      projectDeleted: true,
    },
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00.000Z',
  };
}

function makeGuideline(overrides: Partial<Guideline> = {}): Guideline {
  return {
    id: overrides.id ?? 'g1',
    name: overrides.name ?? 'Visibility of system status',
    description: overrides.description ?? 'Keep users informed.',
    isDefault: overrides.isDefault ?? true,
    createdByUserId: overrides.createdByUserId,
  };
}

interface FakeApi {
  /** All recorded calls in order. */
  calls: Array<{ path: string; init?: RequestInit }>;
  fetch: <T>(path: string, init?: RequestInit) => Promise<T>;
}

type ApiResponse = unknown | ((init?: RequestInit) => unknown);

function makeFakeApi(responses: Record<string, ApiResponse> = {}): FakeApi {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  return {
    calls,
    fetch: async <T,>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      const method = init?.method ?? 'GET';
      const keys = [`${method} ${path}`, path];
      for (const key of keys) {
        if (key in responses) {
          const value = responses[key];
          const out =
            typeof value === 'function'
              ? (value as (i?: RequestInit) => unknown)(init)
              : value;
          return out as T;
        }
      }
      // Default: treat unknown calls as successful no-ops.
      return undefined as T;
    },
  };
}

// `mountSettingsPage` triggers tab-specific fetches asynchronously. Allow
// several microtask flushes so the chained promises settle.
async function flushAsync(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

// --- Lifecycle ------------------------------------------------------------

beforeEach(() => {
  document.body.innerHTML = '';
  installTemplates();
  resetStores();
  history.replaceState(null, '', '/settings');
});

afterEach(() => {
  resetStores();
  history.replaceState(null, '', '/');
});

// --- Tests ----------------------------------------------------------------

describe('mountSettingsPage — initial render', () => {
  it('mounts the layout shell with the settings content inside', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const api = makeFakeApi({
      '/users/me': makeUser(),
      '/api/v1/projects': [],
    });

    mountSettingsPage(root, undefined, { apiFetch: api.fetch });
    await flushAsync();

    expect(root.querySelector('.fl-app-layout')).not.toBeNull();
    const contentSlot = root.querySelector('main[data-slot="content"]');
    expect(contentSlot).not.toBeNull();
    expect(
      contentSlot!.querySelector('section[data-section="profile"]'),
    ).not.toBeNull();
    expect(
      contentSlot!.querySelector('section[data-section="notifications"]'),
    ).not.toBeNull();
    expect(
      contentSlot!.querySelector('section[data-section="guidelines"]'),
    ).not.toBeNull();
  });

  it('opens on the Profile tab and lazy-loads /users/me', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const api = makeFakeApi({
      '/users/me': makeUser({ name: 'Alice', email: 'alice@test.com' }),
    });

    mountSettingsPage(root, undefined, { apiFetch: api.fetch });
    await flushAsync();

    const profileSection = root.querySelector(
      '[data-section="profile"]',
    ) as HTMLElement;
    expect(profileSection.hidden).toBe(false);

    const form = root.querySelector(
      '[data-role="profile-form"]',
    ) as HTMLFormElement;
    expect(form.hidden).toBe(false);

    expect(
      (root.querySelector('[data-role="profile-name"]') as HTMLInputElement)
        .value,
    ).toBe('Alice');
    expect(
      (root.querySelector('[data-role="profile-email"]') as HTMLInputElement)
        .value,
    ).toBe('alice@test.com');

    // The profile fetch happened.
    expect(api.calls.some((c) => c.path === '/users/me')).toBe(true);
  });
});

describe('Profile tab', () => {
  it('saves the profile via PUT /users/me and shows a success message', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const api = makeFakeApi({
      '/users/me': makeUser({ name: 'Alice', email: 'alice@test.com' }),
      'PUT /users/me': {},
    });

    mountSettingsPage(root, undefined, { apiFetch: api.fetch });
    await flushAsync();

    (root.querySelector('[data-role="profile-name"]') as HTMLInputElement).value =
      'Bob';
    (root.querySelector('[data-role="profile-avatar"]') as HTMLInputElement).value =
      'https://avatar.example/me.png';

    root
      .querySelector<HTMLFormElement>('[data-role="profile-form"]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await flushAsync();

    const put = api.calls.find((c) => c.init?.method === 'PUT');
    expect(put?.path).toBe('/users/me');
    expect(JSON.parse((put?.init?.body as string) ?? '{}')).toEqual({
      name: 'Bob',
      email: 'alice@test.com',
      avatarUrl: 'https://avatar.example/me.png',
    });

    const message = root.querySelector(
      '[data-role="profile-message"]',
    ) as HTMLElement;
    expect(message.hidden).toBe(false);
    expect(message.textContent).toBe('Profile updated.');
  });

  it('shows an error message when the save fails', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const api: FakeApi = {
      calls: [],
      fetch: async <T,>(path: string, init?: RequestInit): Promise<T> => {
        api.calls.push({ path, init });
        if (path === '/users/me' && (init?.method ?? 'GET') === 'GET') {
          return makeUser() as T;
        }
        throw new Error('Server exploded');
      },
    };

    mountSettingsPage(root, undefined, { apiFetch: api.fetch });
    await flushAsync();

    root
      .querySelector<HTMLFormElement>('[data-role="profile-form"]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await flushAsync();

    const message = root.querySelector(
      '[data-role="profile-message"]',
    ) as HTMLElement;
    expect(message.hidden).toBe(false);
    expect(message.textContent).toContain('Server exploded');
  });

  it('shows a load-error message when /users/me fails', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const api: FakeApi = {
      calls: [],
      fetch: async (): Promise<never> => {
        throw new Error('boom');
      },
    };

    mountSettingsPage(root, undefined, { apiFetch: api.fetch });
    await flushAsync();

    const loading = root.querySelector(
      '[data-role="profile-loading"]',
    ) as HTMLElement;
    expect(loading.hidden).toBe(true);

    const message = root.querySelector(
      '[data-role="profile-message"]',
    ) as HTMLElement;
    expect(message.hidden).toBe(false);
    expect(message.textContent).toContain('Failed to load profile.');
  });
});

describe('Notifications tab', () => {
  it('lazy-loads on first activation and renders one toggle per preference', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const prefs: NotificationPreferences = {
      newAnnotation: true,
      newComment: false,
      promotedToOwner: true,
      projectDeleted: false,
    };
    const api = makeFakeApi({
      '/users/me': makeUser({ notificationPreferences: prefs }),
    });

    mountSettingsPage(root, undefined, { apiFetch: api.fetch });
    await flushAsync();

    // Switch to the Notifications tab.
    (
      root.querySelector('[data-role="tab-notifications"]') as HTMLButtonElement
    ).click();
    await flushAsync();

    const list = root.querySelector(
      '[data-role="notifications-list"]',
    ) as HTMLElement;
    const toggles = list.querySelectorAll(
      '[data-role="notification-toggle"]',
    );
    expect(toggles).toHaveLength(4);

    const states = Array.from(toggles).map(
      (t) => (t as HTMLElement).getAttribute('aria-checked'),
    );
    // Order matches NOTIFICATION_ROWS in the page module.
    expect(states).toEqual(['true', 'false', 'true', 'false']);

    // The Notifications fetch hit /users/me a second time (Profile tab
    // already loaded once on initial activation).
    expect(api.calls.filter((c) => c.path === '/users/me').length).toBe(2);
  });

  it('PUTs the updated preferences when a toggle is clicked', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const prefs: NotificationPreferences = {
      newAnnotation: true,
      newComment: true,
      promotedToOwner: true,
      projectDeleted: true,
    };
    const api = makeFakeApi({
      '/users/me': makeUser({ notificationPreferences: prefs }),
      'PUT /users/me/notifications': {},
    });

    mountSettingsPage(root, undefined, { apiFetch: api.fetch });
    await flushAsync();

    (
      root.querySelector('[data-role="tab-notifications"]') as HTMLButtonElement
    ).click();
    await flushAsync();

    const firstToggle = root.querySelector(
      '[data-role="notification-toggle"]',
    ) as HTMLButtonElement;
    expect(firstToggle.getAttribute('aria-checked')).toBe('true');
    firstToggle.click();
    await flushAsync();

    const put = api.calls.find(
      (c) => c.init?.method === 'PUT' && c.path === '/users/me/notifications',
    );
    expect(put).toBeTruthy();
    expect(JSON.parse((put?.init?.body as string) ?? '{}')).toEqual({
      newAnnotation: false,
      newComment: true,
      promotedToOwner: true,
      projectDeleted: true,
    });

    expect(firstToggle.getAttribute('aria-checked')).toBe('false');
  });

  it('reverts the toggle and shows an error when the PUT fails', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const prefs: NotificationPreferences = {
      newAnnotation: true,
      newComment: true,
      promotedToOwner: true,
      projectDeleted: true,
    };
    const api: FakeApi = {
      calls: [],
      fetch: async <T,>(path: string, init?: RequestInit): Promise<T> => {
        api.calls.push({ path, init });
        const method = init?.method ?? 'GET';
        if (path === '/users/me' && method === 'GET') {
          return makeUser({ notificationPreferences: prefs }) as T;
        }
        if (
          path === '/users/me/notifications' &&
          method === 'PUT'
        ) {
          throw new Error('failed');
        }
        return undefined as T;
      },
    };

    mountSettingsPage(root, undefined, { apiFetch: api.fetch });
    await flushAsync();

    (
      root.querySelector('[data-role="tab-notifications"]') as HTMLButtonElement
    ).click();
    await flushAsync();

    const firstToggle = root.querySelector(
      '[data-role="notification-toggle"]',
    ) as HTMLButtonElement;
    firstToggle.click();
    await flushAsync();

    // Reverted because the PUT failed.
    expect(firstToggle.getAttribute('aria-checked')).toBe('true');

    const errorEl = root.querySelector(
      '[data-role="notifications-error"]',
    ) as HTMLElement;
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toContain('Failed to update preference.');
  });
});

describe('Guidelines tab', () => {
  it('lazy-loads the guidelines list and shows the default badge for built-ins', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const api = makeFakeApi({
      '/users/me': makeUser(),
      '/guidelines': [
        makeGuideline({ id: 'g1', name: 'Default One', isDefault: true }),
        makeGuideline({
          id: 'g2',
          name: 'Custom One',
          isDefault: false,
          description: 'Custom desc',
        }),
      ],
    });

    mountSettingsPage(root, undefined, { apiFetch: api.fetch });
    await flushAsync();

    (
      root.querySelector('[data-role="tab-guidelines"]') as HTMLButtonElement
    ).click();
    await flushAsync();

    const rows = root.querySelectorAll('[data-role="guideline-row"]');
    expect(rows).toHaveLength(2);

    const firstBadge = rows[0].querySelector(
      '[data-role="default-badge"]',
    ) as HTMLElement;
    const secondBadge = rows[1].querySelector(
      '[data-role="default-badge"]',
    ) as HTMLElement;
    expect(firstBadge.hidden).toBe(false);
    expect(secondBadge.hidden).toBe(true);

    const secondDesc = rows[1].querySelector(
      '[data-role="description"]',
    ) as HTMLElement;
    expect(secondDesc.hidden).toBe(false);
    expect(secondDesc.textContent).toBe('Custom desc');
  });

  it('shows the empty state when no guidelines exist', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const api = makeFakeApi({
      '/users/me': makeUser(),
      '/guidelines': [],
    });

    mountSettingsPage(root, undefined, { apiFetch: api.fetch });
    await flushAsync();

    (
      root.querySelector('[data-role="tab-guidelines"]') as HTMLButtonElement
    ).click();
    await flushAsync();

    const empty = root.querySelector(
      '[data-role="guidelines-empty"]',
    ) as HTMLElement;
    expect(empty.hidden).toBe(false);
  });

  it('disables the create button until the name input is non-empty', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const api = makeFakeApi({
      '/users/me': makeUser(),
      '/guidelines': [],
    });

    mountSettingsPage(root, undefined, { apiFetch: api.fetch });
    await flushAsync();

    (
      root.querySelector('[data-role="tab-guidelines"]') as HTMLButtonElement
    ).click();
    await flushAsync();

    const submit = root.querySelector(
      '[data-role="guideline-submit"]',
    ) as HTMLButtonElement;
    const name = root.querySelector(
      '[data-role="guideline-name"]',
    ) as HTMLInputElement;
    expect(submit.disabled).toBe(true);

    name.value = 'New guideline';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    expect(submit.disabled).toBe(false);

    name.value = '   ';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    expect(submit.disabled).toBe(true);
  });

  it('POSTs the trimmed name and description, then refreshes the list', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const list: Guideline[] = [];
    const api = makeFakeApi({
      '/users/me': makeUser(),
      'GET /guidelines': () => [...list],
      'POST /guidelines': () => {
        list.push(
          makeGuideline({
            id: 'g-new',
            name: 'Trimmed',
            description: 'Trimmed desc',
            isDefault: false,
          }),
        );
        return { id: 'g-new' };
      },
    });

    mountSettingsPage(root, undefined, { apiFetch: api.fetch });
    await flushAsync();

    (
      root.querySelector('[data-role="tab-guidelines"]') as HTMLButtonElement
    ).click();
    await flushAsync();

    const name = root.querySelector(
      '[data-role="guideline-name"]',
    ) as HTMLInputElement;
    const desc = root.querySelector(
      '[data-role="guideline-desc"]',
    ) as HTMLTextAreaElement;
    name.value = '  Trimmed  ';
    desc.value = '  Trimmed desc  ';
    name.dispatchEvent(new Event('input', { bubbles: true }));

    root
      .querySelector<HTMLFormElement>('[data-role="guideline-form"]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await flushAsync();

    const post = api.calls.find((c) => c.init?.method === 'POST');
    expect(post?.path).toBe('/guidelines');
    expect(JSON.parse((post?.init?.body as string) ?? '{}')).toEqual({
      name: 'Trimmed',
      description: 'Trimmed desc',
    });

    // The new row appears.
    const names = Array.from(
      root.querySelectorAll('[data-role="guideline-row"] [data-slot="name"]'),
    ).map((n) => n.textContent);
    expect(names).toContain('Trimmed');

    // Inputs cleared.
    expect(name.value).toBe('');
    expect(desc.value).toBe('');
  });

  it('does not POST when the name input is empty or whitespace', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const api = makeFakeApi({
      '/users/me': makeUser(),
      '/guidelines': [],
    });

    mountSettingsPage(root, undefined, { apiFetch: api.fetch });
    await flushAsync();

    (
      root.querySelector('[data-role="tab-guidelines"]') as HTMLButtonElement
    ).click();
    await flushAsync();

    const name = root.querySelector(
      '[data-role="guideline-name"]',
    ) as HTMLInputElement;
    name.value = '   ';

    root
      .querySelector<HTMLFormElement>('[data-role="guideline-form"]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await flushAsync();

    expect(
      api.calls.some(
        (c) => c.init?.method === 'POST' && c.path === '/guidelines',
      ),
    ).toBe(false);
  });
});

describe('teardown', () => {
  it('removes the page DOM and detaches listeners', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const api = makeFakeApi({ '/users/me': makeUser() });
    const teardown = mountSettingsPage(root, undefined, { apiFetch: api.fetch });
    await flushAsync();

    expect(root.querySelector('.fl-app-layout')).not.toBeNull();
    expect(root.querySelector('[data-section="profile"]')).not.toBeNull();

    teardown();

    expect(root.querySelector('.fl-app-layout')).toBeNull();
    expect(root.querySelector('[data-section="profile"]')).toBeNull();
  });
});

describe('error handling', () => {
  it('throws a clear error when the settings template is missing', () => {
    document.getElementById('tpl-settings-page')!.remove();
    const root = document.createElement('div');
    document.body.appendChild(root);

    expect(() => mountSettingsPage(root)).toThrow(
      /no <template> element found with id "tpl-settings-page"/,
    );
  });
});

// Silence the test-runner's "vi.fn() exists but never called" lint while
// keeping the import for future use.
void vi;
