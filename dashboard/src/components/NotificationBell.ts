/**
 * In-app notification bell component.
 *
 * Fetches notifications on mount, listens for real-time `notification.created`
 * socket events, and provides mark-read / mark-all-read actions.
 *
 * Requirements: 31.1 (vanilla TS, no React)
 */

import { signal } from '@pinpoint/shared';
import { cloneTemplate, bindEvents, mount } from '../lib/render';
import { apiFetch } from '../lib/api';
import { createEmptyState } from './EmptyState';
import { onSocketEvent } from '../lib/socket';

interface Notification {
  id: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

/**
 * Shape of `GET /api/v1/notifications`. The server wraps the rows in a
 * `{ notifications, unreadCount }` envelope (see
 * `server/src/adapters/inbound/http/notifications.routes.ts` →
 * `ListUserNotifications`); `unreadCount` is the authoritative unread
 * total across every page, not just the rows returned here.
 */
interface NotificationsResponse {
  notifications: Notification[];
  unreadCount: number;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  if (hrs < 48) return 'yesterday';
  return `${Math.floor(hrs / 24)}d ago`;
}

export function mountNotificationBell(container: HTMLElement): () => void {
  const fragment = cloneTemplate('notification-bell');
  const root = fragment.firstElementChild as HTMLElement;

  const badge = root.querySelector<HTMLElement>('[data-role="badge"]')!;
  const toggleBtn = root.querySelector<HTMLButtonElement>('[data-action="toggleDropdown"]');
  const dropdown = root.querySelector<HTMLElement>('[data-role="dropdown"]')!;
  const listEl = root.querySelector<HTMLElement>('[data-role="list"]')!;
  const emptyEl = root.querySelector<HTMLElement>('[data-role="empty"]')!;

  // Shared empty-state component; replaces the template's plain text.
  emptyEl.removeAttribute('style');
  emptyEl.replaceChildren(createEmptyState('no-notifications', { compact: true }));

  const notifications = signal<Notification[]>([]);
  // Authoritative unread total from the server envelope. Falls back to the
  // locally-derived count only before the first fetch resolves (or when a
  // real-time event arrives for a notification not yet in the badge total).
  const unreadCount = signal<number>(0);
  let open = false;

  // Reactive render
  function paintBadge(): void {
    const count = unreadCount.get();
    badge.textContent = String(count);
    badge.hidden = count === 0;
    // The visible count is decorative (aria-hidden); announce it in the name.
    toggleBtn?.setAttribute(
      'aria-label',
      count === 0 ? 'Notifications' : `Notifications, ${count} unread`,
    );
  }

  const unsubCount = unreadCount.subscribe(() => paintBadge());

  const unsub = notifications.subscribe((items) => {
    listEl.replaceChildren();
    if (items.length === 0) {
      emptyEl.hidden = false;
    } else {
      emptyEl.hidden = true;
      for (const item of items) {
        const row = cloneTemplate('notification-bell-item', {
          title: item.title,
          body: item.body,
          time: timeAgo(item.createdAt),
        });
        const rowEl = row.firstElementChild as HTMLElement;
        rowEl.style.background = item.read ? '#fff' : '#f0f4ff';
        bindEvents(rowEl, {
          markRead: () => void markRead(item),
        });
        listEl.appendChild(row);
      }
    }
  });

  async function markRead(item: Notification): Promise<void> {
    if (item.read) return;
    try {
      await apiFetch(`/notifications/${item.id}/read`, { method: 'PATCH' });
    } catch { /* best-effort */ }
    notifications.set(
      notifications.get().map((n) => (n.id === item.id ? { ...n, read: true } : n)),
    );
    unreadCount.set(Math.max(0, unreadCount.get() - 1));
  }

  async function markAllRead(): Promise<void> {
    try {
      await apiFetch('/notifications/read-all', { method: 'POST' });
    } catch { /* best-effort */ }
    notifications.set(notifications.get().map((n) => ({ ...n, read: true })));
    unreadCount.set(0);
  }

  const cleanupEvents = bindEvents(root, {
    toggleDropdown: () => {
      open = !open;
      dropdown.hidden = !open;
    },
    markAllRead: () => void markAllRead(),
  });

  // Close dropdown when clicking outside
  const onDocClick = (e: MouseEvent) => {
    if (open && !root.contains(e.target as Node)) {
      open = false;
      dropdown.hidden = true;
    }
  };
  document.addEventListener('click', onDocClick, true);

  // Fetch initial notifications. The server returns a
  // `{ notifications, unreadCount }` envelope — read both fields rather
  // than treating the body as a bare array (the old bug set the signal to
  // the whole envelope object, so no rows ever rendered and the badge
  // showed `NaN`/0).
  void apiFetch<NotificationsResponse>('/notifications')
    .then((res) => {
      notifications.set(Array.isArray(res?.notifications) ? res.notifications : []);
      unreadCount.set(typeof res?.unreadCount === 'number' ? res.unreadCount : 0);
    })
    .catch(() => { /* ignore fetch errors */ });

  // Real-time updates
  let offSocket: (() => void) | null = null;
  try {
    offSocket = onSocketEvent('notification.created', (n) => {
      const notification = n as Notification;
      notifications.set([notification, ...notifications.get()]);
      if (!notification.read) {
        unreadCount.set(unreadCount.get() + 1);
      }
    });
  } catch { /* socket not connected yet — fine */ }

  mount(container, fragment);

  return () => {
    unsub();
    unsubCount();
    cleanupEvents();
    offSocket?.();
    document.removeEventListener('click', onDocClick, true);
    root.remove();
  };
}
