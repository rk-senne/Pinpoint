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
import { onSocketEvent } from '../lib/socket';

interface Notification {
  id: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
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
  const dropdown = root.querySelector<HTMLElement>('[data-role="dropdown"]')!;
  const listEl = root.querySelector<HTMLElement>('[data-role="list"]')!;
  const emptyEl = root.querySelector<HTMLElement>('[data-role="empty"]')!;

  const notifications = signal<Notification[]>([]);
  let open = false;

  // Reactive render
  const unsub = notifications.subscribe((items) => {
    const unread = items.filter((n) => !n.read).length;
    badge.textContent = String(unread);
    badge.hidden = unread === 0;

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
  }

  async function markAllRead(): Promise<void> {
    try {
      await apiFetch('/notifications/read-all', { method: 'POST' });
    } catch { /* best-effort */ }
    notifications.set(notifications.get().map((n) => ({ ...n, read: true })));
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

  // Fetch initial notifications
  void apiFetch<Notification[]>('/notifications')
    .then((items) => notifications.set(items))
    .catch(() => { /* ignore fetch errors */ });

  // Real-time updates
  let offSocket: (() => void) | null = null;
  try {
    offSocket = onSocketEvent('notification.created', (n) => {
      notifications.set([n as Notification, ...notifications.get()]);
    });
  } catch { /* socket not connected yet — fine */ }

  mount(container, fragment);

  return () => {
    unsub();
    cleanupEvents();
    offSocket?.();
    document.removeEventListener('click', onDocClick, true);
    root.remove();
  };
}
