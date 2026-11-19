// @vitest-environment jsdom
/**
 * Unit tests for `mountNotificationBell` (GAP 2 — UI coverage).
 *
 * Covers mount/render (template cloned, initial fetch populates the list), the
 * primary interaction (unread badge count, mark-read issues a PATCH and flips
 * the badge, mark-all-read), the real-time `notification.created` socket path,
 * and the empty/error state.
 *
 * `apiFetch` and `onSocketEvent` are mocked at the module boundary so the
 * component's network + socket seams are controllable and assertable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Notification = {
  id: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
};

// --- module mocks -----------------------------------------------------------

const apiFetch = vi.fn<(path: string, opts?: RequestInit) => Promise<unknown>>();
vi.mock('../lib/api', () => ({
  apiFetch: (path: string, opts?: RequestInit) => apiFetch(path, opts),
}));

// Capture the registered `notification.created` handler so tests can push
// real-time events, and let tests assert the unsubscribe is called on teardown.
let socketHandler: ((n: unknown) => void) | null = null;
const socketUnsub = vi.fn();
vi.mock('../lib/socket', () => ({
  onSocketEvent: (_event: string, handler: (n: unknown) => void) => {
    socketHandler = handler;
    return socketUnsub;
  },
}));

import { mountNotificationBell } from './NotificationBell';

// --- template fixtures (mirror dashboard/index.html) ------------------------

const TEMPLATES: Record<string, string> = {
  'notification-bell': `
    <div data-role="notification-bell">
      <button type="button" data-action="toggleDropdown" aria-label="Notifications">
        🔔<span data-role="badge" hidden></span>
      </button>
      <div data-role="dropdown" hidden>
        <button type="button" data-action="markAllRead">Mark all read</button>
        <div data-role="list"></div>
        <div data-role="empty" hidden>No notifications</div>
      </div>
    </div>
  `,
  'notification-bell-item': `
    <div data-role="item" data-action="markRead">
      <div>
        <div data-slot="title"></div>
        <div data-slot="body"></div>
      </div>
      <span data-slot="time"></span>
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

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: overrides.id ?? 'n1',
    title: overrides.title ?? 'New annotation',
    body: overrides.body ?? 'Someone commented',
    read: overrides.read ?? false,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Build the REAL `GET /api/v1/notifications` response envelope
 * (`{ notifications, unreadCount }`) captured from the running API — see
 * responses captured from the live API. `unreadCount` defaults to the number of unread rows
 * so tests that don't care about the server/local split stay intuitive, but
 * it can be overridden to exercise the "authoritative server count" path.
 */
function notificationsEnvelope(
  rows: Notification[],
  unreadCount?: number,
): { notifications: Notification[]; unreadCount: number } {
  return {
    notifications: rows,
    unreadCount: unreadCount ?? rows.filter((n) => !n.read).length,
  };
}

/** Flush microtasks so the mount-time fetch `.then` runs. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '';
  installTemplates();
  apiFetch.mockReset();
  socketUnsub.mockReset();
  socketHandler = null;
  // Default: the mount-time GET /notifications resolves to the real
  // `{ notifications, unreadCount }` envelope with an empty list.
  apiFetch.mockResolvedValue(notificationsEnvelope([]));
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('mountNotificationBell', () => {
  describe('render', () => {
    it('mounts the bell template into the container and fetches notifications', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);

      mountNotificationBell(container);
      await flush();

      expect(container.querySelector('[data-role="notification-bell"]')).not.toBeNull();
      expect(apiFetch).toHaveBeenCalledWith('/notifications', undefined);
    });

    it('toggles the dropdown open and closed via the bell button', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      mountNotificationBell(container);
      await flush();

      const toggle = container.querySelector<HTMLButtonElement>(
        '[data-action="toggleDropdown"]',
      )!;
      const dropdown = container.querySelector<HTMLElement>('[data-role="dropdown"]')!;

      expect(dropdown.hidden).toBe(true);
      toggle.click();
      expect(dropdown.hidden).toBe(false);
      toggle.click();
      expect(dropdown.hidden).toBe(true);
    });
  });

  describe('unread badge + mark-read (primary interaction)', () => {
    it('shows the unread count in the badge and renders one row per notification', async () => {
      apiFetch.mockResolvedValueOnce(
        notificationsEnvelope([
          makeNotification({ id: 'n1', read: false }),
          makeNotification({ id: 'n2', read: false }),
          makeNotification({ id: 'n3', read: true }),
        ]),
      );
      const container = document.createElement('div');
      document.body.appendChild(container);

      mountNotificationBell(container);
      await flush();

      const badge = container.querySelector<HTMLElement>('[data-role="badge"]')!;
      expect(badge.textContent).toBe('2'); // two unread
      expect(badge.hidden).toBe(false);
      expect(container.querySelectorAll('[data-role="list"] [data-role="item"]')).toHaveLength(3);
    });

    it('uses the server unreadCount for the badge, not just the loaded page', async () => {
      // The first page carries one unread row, but the server reports 7 unread
      // across all pages. The badge must show the authoritative total so a
      // paginated first page never understates the count.
      apiFetch.mockResolvedValueOnce(
        notificationsEnvelope([makeNotification({ id: 'n1', read: false })], 7),
      );
      const container = document.createElement('div');
      document.body.appendChild(container);

      mountNotificationBell(container);
      await flush();

      const badge = container.querySelector<HTMLElement>('[data-role="badge"]')!;
      expect(badge.textContent).toBe('7');
      expect(badge.hidden).toBe(false);
    });

    it('marks a notification read: issues the PATCH and decrements the badge', async () => {
      apiFetch.mockResolvedValueOnce(
        notificationsEnvelope([
          makeNotification({ id: 'n1', read: false }),
          makeNotification({ id: 'n2', read: false }),
        ]),
      );
      const container = document.createElement('div');
      document.body.appendChild(container);

      mountNotificationBell(container);
      await flush();

      const badge = container.querySelector<HTMLElement>('[data-role="badge"]')!;
      expect(badge.textContent).toBe('2');

      // The PATCH call for the mark-read action resolves OK.
      apiFetch.mockResolvedValueOnce({});
      const firstRow = container.querySelector<HTMLElement>(
        '[data-role="list"] [data-role="item"]',
      )!;
      firstRow.click();
      await flush();

      expect(apiFetch).toHaveBeenCalledWith('/notifications/n1/read', { method: 'PATCH' });
      expect(badge.textContent).toBe('1'); // one unread remains
      expect(badge.hidden).toBe(false);
    });

    it('mark-all-read hides the badge and POSTs to the read-all endpoint', async () => {
      apiFetch.mockResolvedValueOnce(
        notificationsEnvelope([
          makeNotification({ id: 'n1', read: false }),
          makeNotification({ id: 'n2', read: false }),
        ]),
      );
      const container = document.createElement('div');
      document.body.appendChild(container);

      mountNotificationBell(container);
      await flush();

      apiFetch.mockResolvedValueOnce({});
      container.querySelector<HTMLButtonElement>('[data-action="markAllRead"]')!.click();
      await flush();

      expect(apiFetch).toHaveBeenCalledWith('/notifications/read-all', { method: 'POST' });
      const badge = container.querySelector<HTMLElement>('[data-role="badge"]')!;
      expect(badge.hidden).toBe(true);
      expect(badge.textContent).toBe('0');
    });

    it('prepends a real-time notification pushed over the socket and bumps the badge', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      mountNotificationBell(container);
      await flush();

      expect(socketHandler).toBeTypeOf('function');
      socketHandler!(makeNotification({ id: 'live-1', title: 'Live', read: false }));

      const badge = container.querySelector<HTMLElement>('[data-role="badge"]')!;
      expect(badge.textContent).toBe('1');
      const rows = container.querySelectorAll('[data-role="list"] [data-role="item"]');
      expect(rows).toHaveLength(1);
      expect(rows[0].querySelector('[data-slot="title"]')?.textContent).toBe('Live');
    });
  });

  describe('empty / error state', () => {
    it('shows the empty state and a hidden badge when there are no notifications', async () => {
      apiFetch.mockResolvedValueOnce(notificationsEnvelope([]));
      const container = document.createElement('div');
      document.body.appendChild(container);

      mountNotificationBell(container);
      await flush();

      expect(container.querySelector<HTMLElement>('[data-role="empty"]')!.hidden).toBe(false);
      expect(container.querySelector<HTMLElement>('[data-role="badge"]')!.hidden).toBe(true);
    });

    it('renders the empty state when the initial fetch rejects (errors swallowed)', async () => {
      apiFetch.mockReset();
      apiFetch.mockRejectedValueOnce(new Error('network down'));
      const container = document.createElement('div');
      document.body.appendChild(container);

      expect(() => mountNotificationBell(container)).not.toThrow();
      await flush();

      // No items rendered; empty state visible; badge hidden.
      expect(container.querySelectorAll('[data-role="list"] [data-role="item"]')).toHaveLength(0);
      expect(container.querySelector<HTMLElement>('[data-role="empty"]')!.hidden).toBe(false);
    });
  });

  describe('teardown', () => {
    it('unsubscribes the socket listener and removes the element', async () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const teardown = mountNotificationBell(container);
      await flush();

      teardown();

      expect(socketUnsub).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-role="notification-bell"]')).toBeNull();
    });
  });
});
