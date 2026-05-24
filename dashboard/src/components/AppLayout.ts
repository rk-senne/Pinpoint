/**
 * AppLayout shell — vanilla TypeScript (Requirement 31.1, task 18.5).
 *
 * Replaces the React `AppLayout.tsx` with a small module that:
 *   1. Clones the `#app-layout` `<template>` from `index.html`.
 *   2. Mounts the vanilla `ProjectListSidebar` (task 18.6) into the
 *      sidebar slot.
 *   3. Mounts the per-route `contentNode` into the content slot.
 *   4. Binds the top-bar's current-user label to `authStore.currentUser`.
 *   5. Wires the logout button (clears the auth token, calls
 *      `POST /api/v1/auth/logout`, navigates to `/auth`).
 *
 * Per-route mount functions hand `mountAppLayout` the body of each screen
 * as a `Node`; the History-API router in `lib/router.ts` invokes those
 * mount functions as the user navigates.
 *
 * Requirements: 31.1
 */

import { bind, bindEvents, cloneTemplate, mount, text } from '../lib/render';
import { navigate } from '../lib/router';
import { authStore, resetStores } from '../lib/stores';
import { apiFetch } from '../lib/api';
import { clearAuth } from '../lib/auth';
import { mountProjectListSidebar } from './ProjectListSidebar';

/**
 * Mount the AppLayout shell into `rootEl` and place `contentNode` in the
 * content slot. Returns a teardown function that disconnects every signal
 * subscription and event listener registered by this call so callers can
 * re-mount the layout cleanly (e.g. on route changes that swap the layout).
 *
 * The shell does not own the per-route content. Callers create the content
 * `Node` themselves and pass it in — the layout merely places it into the
 * `[data-slot="content"]` `<main>`. This keeps the layout decoupled from
 * any specific page module.
 */
export function mountAppLayout(rootEl: Element, contentNode: Node): () => void {
  const fragment = cloneTemplate('app-layout');
  const layoutRoot = fragment.firstElementChild as HTMLElement | null;
  if (!layoutRoot) {
    throw new Error('mountAppLayout: #app-layout template is empty');
  }

  // Sidebar slot — mount the vanilla `ProjectListSidebar` (task 18.6). It
  // owns its own DOM lifecycle and fetches the project list on mount.
  const sidebarSlot = layoutRoot.querySelector<HTMLElement>('[data-slot="sidebar"]');
  let sidebarHandle: { dispose: () => void } | null = null;
  if (sidebarSlot) {
    sidebarSlot.replaceChildren();
    sidebarHandle = mountProjectListSidebar(sidebarSlot, {
      navigate: (path) => navigate(path),
    });
  }

  // Content slot — caller-provided node moved into place.
  const contentSlot = layoutRoot.querySelector('[data-slot="content"]');
  if (!contentSlot) {
    throw new Error('mountAppLayout: template is missing the content slot');
  }
  contentSlot.replaceChildren(contentNode);

  // Bind the top-bar current-user label to the auth store. The label shows
  // the user's name when present, falls back to the email, and renders
  // empty when nobody is signed in.
  const currentUserSlot = layoutRoot.querySelector('[data-slot="currentUser"]');
  const unbindUser =
    currentUserSlot === null
      ? noop
      : bind(currentUserSlot, authStore.currentUser, (el, user) => {
          text(el, user ? (user.name || user.email) : '');
        });

  // Wire the top-bar buttons. `goHome` keeps the logo navigation working
  // even on browsers that do not honor the `data-route` link interception
  // (e.g. when running unit tests outside the router's `start`-bound
  // listener).
  const cleanupEvents = bindEvents(layoutRoot, {
    goHome: (e) => {
      e.preventDefault();
      navigate('/');
    },
    logout: (e) => {
      e.preventDefault();
      void handleLogout();
    },
  });

  mount(rootEl, fragment);

  return () => {
    sidebarHandle?.dispose();
    unbindUser();
    cleanupEvents();
    layoutRoot.remove();
  };
}

/**
 * Logout handler. Best-effort: we always drop the in-memory tokens and
 * reset stores regardless of whether the server call succeeds, then
 * route to `/auth`. The `POST /api/v1/auth/logout` server route is what
 * actually clears the `fl_session` and `fl_csrf` cookies (Task 7.5,
 * Req 18.1) — the local `clearAuth()` only drops the in-memory CSRF
 * token and the bearer JWT used by Socket.IO.
 */
async function handleLogout(): Promise<void> {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } catch {
    // Swallow — the user is logging out, so an offline or 401 is fine.
  }
  clearAuth();
  resetStores();
  navigate('/auth');
}

function noop(): void {
  /* intentional */
}
