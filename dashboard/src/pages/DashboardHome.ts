/**
 * DashboardHome — vanilla TypeScript (Requirement 31.1, task 18.7).
 *
 * Replaces `DashboardHome.tsx` with a no-React module that mounts the
 * shared `AppLayout` shell and renders the home content into the layout's
 * content slot. Two states are supported:
 *
 *   - `empty`   — visible when `projectsStore.active` is `[]`. Shows a
 *                 friendly call-to-action that opens the sidebar's
 *                 create-project dialog by clicking through to the
 *                 sidebar's `+ Create Project` button.
 *   - `recent`  — visible when at least one active project exists. Lists
 *                 the most recently updated projects with deep-link rows
 *                 (`/projects/:id`) that the router intercepts via the
 *                 `data-route` attribute.
 *
 * The page subscribes to `projectsStore.active` so the two states swap as
 * the sidebar's project fetch resolves and as new projects are created.
 *
 * The exported `mountDashboardHome` matches the `RouteHandler` shape from
 * `lib/router.ts` so it can be registered with
 * `defineRoute('/', mountDashboardHome)`.
 *
 * Requirements: 31.1
 */

import type { Project } from '@pinpoint/shared';

import { mountAppLayout } from '../components/AppLayout';
import {
  attr,
  bind,
  bindEvents,
  cloneTemplate,
  requireRole,
  requireSection,
  text,
} from '../lib/render';
import { navigate } from '../lib/router';
import { projectsStore } from '../lib/stores';

/** How many recent projects to show in the home list. */
const RECENT_LIMIT = 5;

type HomeView = 'list' | 'cards';
const VIEW_PREF_KEY = 'pinpoint_home_view';

/**
 * Mount the home page into `rootEl`. The optional `params` argument is
 * accepted (and ignored) so the function is directly assignable to the
 * `RouteHandler` type exported by `lib/router.ts`.
 *
 * Returns a teardown function that removes the rendered DOM and detaches
 * every event listener and signal subscription registered by this call.
 */
export function mountDashboardHome(
  rootEl: HTMLElement,
  _params?: Record<string, string>,
): () => void {
  // Build the home content first so we can hand it to `mountAppLayout`.
  const fragment = cloneTemplate('tpl-dashboard-home');
  const contentRoot = fragment.firstElementChild as HTMLElement | null;
  if (!contentRoot) {
    throw new Error('mountDashboardHome: #tpl-dashboard-home template is empty');
  }

  // Per-row listener cleanups. Cleared on every rerender so detached rows
  // can be GC'd; otherwise the closures capturing each row would keep the
  // detached DOM alive for the page's lifetime.
  let rowCleanups: Array<() => void> = [];

  let currentView: HomeView =
    (localStorage.getItem(VIEW_PREF_KEY) as HomeView) || 'list';

  const emptySection = requireSection(contentRoot, 'empty');
  const recentSection = requireSection(contentRoot, 'recent');
  const recentList = requireRole(contentRoot, 'recent-list');
  const cardsGrid = requireRole(contentRoot, 'cards-grid');
  const listBtn = contentRoot.querySelector<HTMLButtonElement>('[data-action="selectList"]');
  const cardsBtn = contentRoot.querySelector<HTMLButtonElement>('[data-action="selectCards"]');

  function paintViewToggle(): void {
    if (listBtn) {
      listBtn.style.fontWeight = currentView === 'list' ? '600' : '400';
      listBtn.style.color = currentView === 'list' ? '#4f46e5' : '#666';
    }
    if (cardsBtn) {
      cardsBtn.style.fontWeight = currentView === 'cards' ? '600' : '400';
      cardsBtn.style.color = currentView === 'cards' ? '#4f46e5' : '#666';
    }
  }

  // Wire page-local actions.
  const cleanupEvents = bindEvents(contentRoot, {
    createProject: (e) => {
      e.preventDefault();
      const trigger = document.querySelector<HTMLElement>(
        '[data-role="create"][data-action="openCreate"]',
      );
      if (trigger) {
        trigger.click();
      }
    },
    selectList: () => {
      currentView = 'list';
      localStorage.setItem(VIEW_PREF_KEY, 'list');
      paintViewToggle();
      rerender();
    },
    selectCards: () => {
      currentView = 'cards';
      localStorage.setItem(VIEW_PREF_KEY, 'cards');
      paintViewToggle();
      rerender();
    },
  });

  paintViewToggle();

  // Reactive: switch between empty/recent and (re)render the list when
  // the active projects change.
  const unbindRecent = bind(recentList, projectsStore.active, () => {
    rerender();
  });

  // Compose the shell: the layout owns the chrome (header, sidebar,
  // logout), the home page owns the content slot.
  const teardownLayout = mountAppLayout(rootEl, contentRoot);

  return () => {
    unbindRecent();
    cleanupEvents();
    for (const cleanup of rowCleanups) cleanup();
    rowCleanups = [];
    teardownLayout();
    contentRoot.remove();
  };

  // -------------------------------------------------------------------
  // rendering
  // -------------------------------------------------------------------

  function rerender(): void {
    const active = projectsStore.active.get();

    // Tear down listeners attached to the previous batch of rows before
    // we detach them from the DOM.
    for (const cleanup of rowCleanups) cleanup();
    rowCleanups = [];
    recentList.replaceChildren();
    cardsGrid.replaceChildren();

    if (active.length === 0) {
      emptySection.hidden = false;
      recentSection.hidden = true;
      return;
    }

    emptySection.hidden = true;
    recentSection.hidden = false;

    const sorted = active
      .slice()
      .sort((a, b) => recencyKey(b).localeCompare(recencyKey(a)))
      .slice(0, RECENT_LIMIT);

    if (currentView === 'list') {
      recentList.hidden = false;
      cardsGrid.hidden = true;
      for (const project of sorted) {
        recentList.appendChild(renderRow(project));
      }
    } else {
      recentList.hidden = true;
      cardsGrid.hidden = false;
      for (const project of sorted) {
        cardsGrid.appendChild(renderCard(project));
      }
    }
  }

  function renderRow(project: Project): HTMLElement {
    const url = project.urls[0] ?? '';
    const rowFragment = cloneTemplate('tpl-dashboard-home-recent-item', {
      name: project.name,
      url,
    });
    const row = rowFragment.firstElementChild as HTMLElement;

    const link = row.querySelector<HTMLAnchorElement>('[data-role="recent-link"]');
    if (link) {
      attr(link, 'href', `/projects/${project.id}`);
      attr(link, 'aria-label', `Open project ${project.name}`);
    }

    if (!url) {
      const urlSlot = row.querySelector<HTMLElement>('[data-slot="url"]');
      if (urlSlot) text(urlSlot, '');
    }

    const rowCleanup = bindEvents(row, {
      openProject: (e) => {
        if (e.defaultPrevented) return;
        e.preventDefault();
        navigate(`/projects/${project.id}`);
      },
    });
    rowCleanups.push(rowCleanup);

    return row;
  }

  function renderCard(project: Project): HTMLElement {
    const cardFragment = cloneTemplate('tpl-dashboard-home-card', {
      name: project.name,
      status: project.status,
      activity: formatRelativeTime(project.updatedAt),
    });
    const card = cardFragment.firstElementChild as HTMLElement;

    // Color the status badge
    const statusBadge = card.querySelector<HTMLElement>('[data-role="status-badge"]');
    if (statusBadge) {
      statusBadge.style.background = project.status === 'active' ? '#dcfce7' : '#f3f4f6';
      statusBadge.style.color = project.status === 'active' ? '#166534' : '#6b7280';
    }

    const cardCleanup = bindEvents(card, {
      openProject: (e) => {
        if (e.defaultPrevented) return;
        e.preventDefault();
        navigate(`/projects/${project.id}`);
      },
    });
    rowCleanups.push(cardCleanup);

    return card;
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Sort key for the recent-projects list. Prefers `updatedAt` so the list
 * reorders as projects change; falls back to `createdAt` and finally the
 * id so the comparison is total even on malformed rows.
 */
function recencyKey(project: Project): string {
  return project.updatedAt || project.createdAt || project.id;
}

/** Format an ISO date as a human-friendly relative time string. */
function formatRelativeTime(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
