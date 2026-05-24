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

  const emptySection = requireSection(contentRoot, 'empty');
  const recentSection = requireSection(contentRoot, 'recent');
  const recentList = requireRole(contentRoot, 'recent-list');

  // Wire page-local actions. `createProject` clicks the sidebar's
  // create-project button so the home CTA reuses the same dialog flow
  // rather than re-implementing it. Falls back to navigating to `/`
  // (a no-op) when the sidebar has not been mounted yet (e.g. unit tests
  // that exercise the home page in isolation).
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
  });

  // Reactive: switch between empty/recent and (re)render the list when
  // the active projects change. The subscription fires once immediately
  // with the current value, so initial paint happens here.
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

    if (active.length === 0) {
      emptySection.hidden = false;
      recentSection.hidden = true;
      return;
    }

    emptySection.hidden = true;
    recentSection.hidden = false;

    // Sort by most recently updated first, falling back to createdAt.
    // The server returns projects in insertion order today, so the home
    // page does the ranking client-side rather than depend on server-side
    // ordering that may change.
    const sorted = active
      .slice()
      .sort((a, b) => recencyKey(b).localeCompare(recencyKey(a)))
      .slice(0, RECENT_LIMIT);

    for (const project of sorted) {
      recentList.appendChild(renderRow(project));
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

    // Page-level fallback for environments where `data-route` link
    // interception is not active (unit tests, or when the router has not
    // been started yet). The router's click handler will run first when
    // wired and short-circuit this via `e.defaultPrevented`.
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
