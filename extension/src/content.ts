/**
 * Content script (content.ts) — creates a Shadow DOM root for UI isolation
 * and mounts the `<fl-overlay-host>` Custom Element.
 *
 * --------------------------------------------------------------------------
 * CSP-strict audit (task 41.1, Requirement 49.1)
 * --------------------------------------------------------------------------
 * The Extension overlay must continue to render on host pages with strict
 * `Content-Security-Policy` headers (e.g.
 * `default-src 'none'; script-src 'self'; style-src 'self'`). The runtime
 * is therefore audited for the four classes of CSP-incompatible patterns
 * the spec calls out:
 *
 *   1. Inline event handlers (`onclick="..."`, `setAttribute('onfoo', ...)`):
 *      none. Every event listener is registered via `addEventListener`
 *      from inside a Custom Element constructor or `connectedCallback`.
 *   2. Inline `style="..."` attributes / bulk `cssText` assignments
 *      (sentinel: csp-audit-allow):
 *      none. Two earlier exceptions in `MentionAutocomplete` and
 *      `CommentThread` templates were moved to the shared stylesheet
 *      (`extension/src/styles/sharedStyleSheet.ts`). The bulk
 *      `cssText = "..."` assignments in `HoverOutline` and the
 *      `<fl-error-tag>` indicator (`lib/withBoundary.ts`) were converted
 *      to per-property `style.X = ...` writes — those go through the
 *      typed `CSSStyleDeclaration` object and do not produce an inline
 *      `style` attribute. Per-property writes (e.g.
 *      `el.style.transform = ...` in `PinPositioner`, `HoverOutline`,
 *      `Popover`, `ClusterListPopover`, `MarkupEditor`, `FloatingToolbar`)
 *      are the canonical runtime path and remain.
 *   3. `eval`-class APIs (sentinel: csp-audit-allow):
 *      none. No `eval`, no `new Function`, no `setTimeout` / `setInterval`
 *      invocations with a string first argument. Every `setTimeout` /
 *      `setInterval` callsite passes a function reference.
 *   4. Other dynamic-script surfaces:
 *      no `document.write`, no `outerHTML` writes. `innerHTML` writes exist
 *      only on `<template>` elements (which the spec explicitly allows —
 *      those bake static markup into a template, the rendered DOM is
 *      built via `cloneNode`) and on the screenshot viewer's `<svg>`
 *      overlay where the markup payload is `MarkupDocumentSchema`-
 *      validated server-side before render.
 *
 * The audit is enforced as a unit test:
 * `extension/src/__tests__/cspAudit.test.ts` regex-scans every first-party
 * source file for the four pattern classes above and fails CI on a
 * regression. Adding a new exception requires either fixing the call site
 * or registering an entry in `ALLOWED_VIOLATIONS` with a written
 * justification — the empty allow-list is the steady state.
 *
 * --------------------------------------------------------------------------
 * Styling delivery (task 41.2, Requirement 49.2)
 * --------------------------------------------------------------------------
 * Constructable `CSSStyleSheet` adopted via `adoptedStyleSheets` is the
 * canonical CSP-clean delivery path for every Custom Element in the
 * extension. Each component constructor calls `adoptStyles(shadowRoot)`
 * from `extension/src/styles/sharedStyleSheet.ts`, which:
 *
 *   - Primary path: assigns the shared constructable `CSSStyleSheet` to
 *     `shadowRoot.adoptedStyleSheets`. Constructable stylesheets installed
 *     this way are not classified as inline by `style-src`, so the overlay
 *     renders under `default-src 'none'; script-src 'self'; style-src 'self'`
 *     without any policy relaxation.
 *   - Fallback path: when `new CSSStyleSheet()` or `Document.adoptedStyleSheets`
 *     is unavailable (legacy engines, some jsdom builds), a static
 *     `<style>` element is appended inside the Shadow Root. Because the
 *     fallback `<style>` lives inside a Shadow Root in the extension's
 *     isolated world, host-page CSP does not block it.
 *
 * Both paths are exercised by
 * `extension/src/__tests__/cspIntegration.test.ts` (task 41.3), which
 * mounts the full `<fl-overlay-host>` under a strict CSP `<meta>` tag and
 * asserts the overlay renders without writing inline `style="…"`
 * attributes or inline event handlers anywhere in its tree.
 * --------------------------------------------------------------------------
 *
 * Per task 40.2 (Req 48.2): when this script runs inside a sub-frame
 * (`window.top !== window.self`), we skip the full overlay mount and
 * instead install only the tiny `subFrameRelay` click-relay. Sub-frames
 * stay completely passive — they relay click rects to the top frame
 * via `postMessage`, but never render UI of their own.
 *
 * Per task 17.9 of the pinpoint-app spec (Requirement 31.4): the
 * content script MUST continue to use Shadow DOM for style isolation but
 * MUST NOT bootstrap React. All overlay UI is now driven by the
 * `<fl-overlay-host>` Web Component (task 17.8). This module is responsible
 * for:
 *
 *   1. Per-site allow/block guard (tasks 38.2 / 38.3, Reqs 46.2 / 46.3) —
 *      consulted at the very top of execution. When the host matches the
 *      block-list, or when a non-empty allow-list does not match, the
 *      script logs a debug message and returns without doing any further
 *      work. Storage failures default to "allow" so a flaky
 *      `chrome.storage.sync` never silently disables the extension.
 *   2. Registering `<fl-overlay-host>` via a side-effect import.
 *   3. Pulling the JWT auth token from `chrome.storage.local` and resolving
 *      the project for the current tab via
 *      `GET /api/v1/projects/by-url?url=<location.href>` (Req 22.1) using
 *      the existing `apiFetch` wrapper from `./lib/api`.
 *   4. Creating a Shadow Host on the page, attaching an open Shadow Root,
 *      and appending a single `<fl-overlay-host>` configured with the
 *      resolved `projectId` and `token`. Per-element styling lives inside
 *      the Custom Element via `adoptStyles()` so this script no longer
 *      injects CSS strings.
 *   5. Routing `host-action` events emitted by `<fl-overlay-host>` to the
 *      REST API:
 *        - `create-annotation` → `POST /projects/:id/annotations`
 *        - `change-status`     → `PUT  /annotations/:id/status`
 *        - `create-comment`    → `POST /annotations/:id/comments`
 *      The host has already updated its own store optimistically; this
 *      script only handles the network round-trip.
 *   6. Listening for the `TOGGLE_OVERLAY` runtime message from the service
 *      worker and toggling the Shadow Host's visibility.
 */

import {
  apiFetch,
  queueChangeAnnotationStatus,
  queueCreateAnnotation,
  queueCreateComment,
} from './lib/api';
import { getStoredAuthToken } from './lib/authTokenStore';
import { installHistoryPatch } from './lib/historyPatch';
import { lookupProject } from './lib/projectMappingStore';
import { shouldSkipInjection } from './lib/hostFilter';
import { startSyncer, setSyncRemapAdapter } from './lib/Syncer';
import { createConnectionMonitor, type ConnectionMonitor } from './lib/connectionMonitor';
import { withContentScriptBoundary } from './lib/ContentScriptBoundary';
import './components/OverlayHost';
import type { FlOverlayHost, OverlayHostAction } from './components/OverlayHost';
import type { PickerProject } from './components/ProjectPicker';
import type { Annotation, Project } from '@pinpoint/shared';

const SHADOW_HOST_ID = 'pinpoint-shadow-host';

let shadowHostEl: HTMLElement | null = null;
let overlayHostEl: FlOverlayHost | null = null;
let overlayEnabled = false;
let connectionMonitorInstance: ConnectionMonitor | null = null;

/** Response shape for `GET /api/v1/projects/by-url`. */
interface ProjectByUrlResponse {
  projectId: string;
  pageId: string;
}

/** Shape returned by `GET /api/v1/projects/:id/members` (Req 22.4). */
interface ProjectMember {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: string;
}

/** Pull the stored auth token; null when logged out. Re-exported via
 * `getStoredAuthToken` so every surface in the extension uses one
 * canonical implementation. */
const readStoredAuthToken = getStoredAuthToken;

/**
 * Resolve the project the current page belongs to. Returns null when the
 * server has no mapping (404), the user is signed out (401), or the
 * network call fails — in every case the overlay is still constructable;
 * persistence simply won't work until a project resolves.
 *
 * Per task 30.3 (Requirement 39.2): the URL → Project mapping cache
 * (populated by `<fl-project-picker>` on user selection in task 30.2)
 * is consulted **before** calling `GET /by-url`. A cache hit
 * short-circuits the server round-trip entirely; only a cache miss
 * falls back to the server. The cache is keyed by `origin + pathname`
 * so query strings and fragments collapse to the same Project.
 */
export async function resolveProjectForUrl(
  href: string,
): Promise<string | null> {
  // 1. Try the local cache first. A hit means the user has previously
  //    picked a Project for this `origin + pathname` via the picker
  //    (task 30.2), so we trust it and skip the network call entirely.
  let cached: string | null = null;
  try {
    const url = new URL(href);
    cached = await lookupProject({
      origin: url.origin,
      pathname: url.pathname,
    });
  } catch {
    // Malformed URL or chrome.storage failure — degrade to the network
    // path; this matches the helper's "best effort" contract.
    cached = null;
  }
  if (cached) return cached;

  // 2. Cache miss → ask the server. Failures (404, 401, network) all
  //    funnel into `null` so the host page stays stable.
  try {
    const res = await apiFetch<ProjectByUrlResponse>(
      `/projects/by-url?url=${encodeURIComponent(href)}`,
    );
    return res.projectId;
  } catch {
    return null;
  }
}

/**
 * Build (or reuse) the Shadow Host element. Pointer events are disabled
 * on the host so the underlying page stays fully interactive; child
 * elements that need to be clickable opt in via `pointer-events: auto`
 * in the shared stylesheet.
 */
function ensureShadowHost(): { host: HTMLElement; root: ShadowRoot } {
  if (shadowHostEl && shadowHostEl.shadowRoot) {
    return { host: shadowHostEl, root: shadowHostEl.shadowRoot };
  }
  const host = document.createElement('div');
  host.id = SHADOW_HOST_ID;
  host.style.position = 'fixed';
  host.style.top = '0';
  host.style.left = '0';
  host.style.width = '0';
  host.style.height = '0';
  host.style.zIndex = '2147483647';
  host.style.pointerEvents = 'none';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  shadowHostEl = host;
  return { host, root };
}

/** Reflect the current `overlayEnabled` state on the Shadow Host. */
function applyOverlayVisibility(): void {
  if (!shadowHostEl) return;
  shadowHostEl.style.display = overlayEnabled ? '' : 'none';
}

/**
 * Handle a `host-action` event emitted by `<fl-overlay-host>`. Mutating
 * actions (`create-annotation`, `change-status`, `create-comment`) are
 * routed through the offline-first queue helpers in `./lib/api`, which:
 *
 *   1. Generate a `localUuid` (or reuse the host's optimistic id).
 *   2. Append a durable `OutboxEntry` to `chrome.storage.local`.
 *   3. Optionally insert an optimistic local row (the host already does
 *      this for create-annotation and change-status, so we pass `null`
 *      writers; comment-submit hands the writer through so the new
 *      comment appears in the popover immediately).
 *   4. Trigger the Syncer (`startSyncer()` already wired the live
 *      drainer in `bootstrap()`), which replays the entry against
 *      `apiFetchRaw` with `clientRequestId = localUuid` so the server's
 *      idempotent-replay path (task 35.2) collapses retries.
 *
 * Read-only / UI-only actions (`overlay-close`, `picker-select`) skip
 * the outbox entirely. Failures from the queue helpers are logged but
 * never thrown — the host page must stay stable, and the durable
 * outbox entry is the source of truth once enqueue has succeeded.
 */
async function onHostAction(event: Event): Promise<void> {
  const detail = (event as CustomEvent<OverlayHostAction>).detail;
  if (!detail) return;
  const host = overlayHostEl;

  try {
    switch (detail.kind) {
      case 'create-annotation': {
        const a = detail.annotation;
        // Use the popover-generated id as the outbox `localUuid` so the
        // optimistic row already in the store, the outbox entry, and the
        // Syncer's eventual `Outbox.replace` (task 36.4) all key off the
        // same UUID.
        await queueCreateAnnotation(
          {
            projectId: a.projectId,
            pageId: a.pageId,
            pageUrl: a.pageUrl ?? window.location.href,
            type: a.type,
            severity: a.severity,
            body: a.body,
            target: a.target,
            environment: a.environment,
            guidelineId: a.guidelineId,
            assigneeId: a.assigneeId,
            dueDate: a.dueDate,
            // Capture_Buffer (Req 36.2 / task 27.3). Forwarded only when
            // the popover attached them — bug-report submissions
            // (type=note, severity ∈ {critical, major}). Older payloads
            // omit the fields and the server's schema treats them as
            // optional + nullable.
            capturedConsole: a.capturedConsole,
            capturedNetwork: a.capturedNetwork,
            screenshotObjectKey: a.screenshotObjectKey,
          },
          // The host already optimistically inserted the row with id=a.id
          // in `<fl-overlay-host>`'s `#onPopoverSubmit`, so we deliberately
          // pass a no-op writer to avoid double insertion.
          null,
          { uuid: () => a.id },
        );
        break;
      }
      case 'change-status': {
        // The host already applied the optimistic status flip; the queue
        // helper just records the mutation in the outbox so the Syncer
        // replays it as PUT /annotations/:id/status.
        await queueChangeAnnotationStatus(
          { annotationId: detail.annotationId, status: detail.status },
          null,
        );
        break;
      }
      case 'create-comment': {
        // The host does NOT optimistically insert a comment, so the queue
        // helper's writer pushes the locally-built `Comment` into the
        // store. The popover's comment thread observes
        // `host.store.comments` and renders the new entry immediately.
        await queueCreateComment(
          {
            annotationId: detail.annotationId,
            body: detail.body,
            mentions: detail.mentions,
          },
          host
            ? (comment) => {
                const current = host.store.comments.get();
                // De-dupe defensively in case a parallel socket replay
                // already inserted the row.
                if (current.some((c) => c.id === comment.id)) return;
                host.store.comments.set([...current, comment]);
              }
            : null,
        );
        break;
      }
      case 'overlay-close': {
        // Toolbar close button mirrors the TOGGLE_OVERLAY runtime message.
        if (overlayEnabled) {
          overlayEnabled = false;
          applyOverlayVisibility();
        }
        break;
      }
      case 'picker-select': {
        // Manual project picker fallback (Req 38.2 / 39.1, task 29.4).
        // The picker has already persisted the URL→Project mapping to
        // `chrome.storage.local` (Req 39.2 / task 30.2) before
        // dispatching `select`; here we simply switch the overlay's
        // active Project, reseed annotations + members for the new
        // Project, hide the picker, and let the existing setProjectId
        // path leave the old Socket.IO room and join the new one.
        if (!overlayHostEl) break;
        overlayHostEl.setProjectId(detail.projectId);
        overlayHostEl.hideProjectPicker();
        await seedProjectData(overlayHostEl, detail.projectId);
        break;
      }
    }
  } catch (err) {
    // Outbox-enqueue failures (e.g., chrome.storage quota) and any other
    // unexpected error must not break the host page.
    console.error('[pinpoint] host-action failed', detail.kind, err);
  }
}

/**
 * Reseed the overlay host with the current Project's annotations and
 * member roster. Called on first mount and whenever the host re-binds
 * to a different Project after an SPA navigation (Req 38.1, task 29.3).
 *
 * Failures are swallowed: the overlay must remain stable on the host
 * page even when the API is unreachable. The store will simply stay
 * empty until the user retries (e.g. by toggling the overlay or
 * navigating again).
 */
async function seedProjectData(
  host: FlOverlayHost,
  projectId: string,
): Promise<void> {
  const [annotationsRes, membersRes] = await Promise.allSettled([
    apiFetch<{ annotations: Annotation[] }>(
      `/projects/${encodeURIComponent(projectId)}/annotations`,
    ),
    apiFetch<{ members: ProjectMember[] }>(
      `/projects/${encodeURIComponent(projectId)}/members`,
    ),
  ]);

  // The host may have been re-bound to yet another project while these
  // requests were in flight. Drop the response if it would clobber the
  // newer binding.
  if (host.projectId !== projectId) return;

  if (annotationsRes.status === 'fulfilled') {
    host.store.annotations.set(annotationsRes.value.annotations ?? []);
  }
  if (membersRes.status === 'fulfilled') {
    const members = (membersRes.value.members ?? []).map((m) => ({
      userId: m.userId,
      name: m.name,
      email: m.email,
    }));
    host.store.members.set(members);
  }
}

/**
 * Project picker fallback (Req 38.2 / 39.1, task 29.4).
 *
 * Fetch the user's accessible projects and reveal `<fl-project-picker>`
 * inside `<fl-overlay-host>` so the user can manually pick a Project
 * for the current page. Called whenever:
 *
 *   - `chrome.storage.local`'s URL→Project cache has no entry for
 *     `origin + pathname`, AND
 *   - `GET /api/v1/projects/by-url` returned 404, AND
 *   - the user is signed in (otherwise the projects list is empty), AND
 *   - the overlay is enabled (otherwise the shadow host is hidden so
 *     the picker would have no UX impact and we'd waste a network call).
 *
 * The picker emits `select` on row click which the overlay host
 * forwards as a `picker-select` host-action; `onHostAction` switches
 * the active Project, hides the picker, and reseeds annotations +
 * members for the new Project. Storage persistence (Req 39.2) already
 * happens inside the picker before the event fires.
 *
 * Failures are swallowed: an unreachable `/projects` endpoint must not
 * break the host page. The picker stays hidden and the user can retry
 * by toggling the overlay or navigating again.
 *
 * Exported so unit tests can drive the helper directly without going
 * through the top-level `runGuardThenBootstrap` side effects.
 */
export async function maybeShowProjectPicker(host: FlOverlayHost): Promise<void> {
  // Skip when the overlay is disabled. The shadow host's `display: none`
  // would hide the picker anyway, but we also avoid the `/projects`
  // network round-trip in that case.
  if (!overlayEnabled) return;

  // Skip when the user is signed out. The picker has nothing to show
  // and the user needs to authenticate via the popup first.
  const token = await readStoredAuthToken();
  if (!token) return;

  let projects: PickerProject[];
  try {
    projects = await fetchPickerProjects();
  } catch {
    return;
  }

  // The host may have rebound to a real Project (cache hit on a
  // concurrent SPA navigation) while `/projects` was in flight; only
  // reveal the picker if no Project resolved in the meantime.
  if (host.projectId) return;

  host.showProjectPicker(projects);
}

/**
 * Fetch the user's accessible projects from `GET /api/v1/projects` and
 * project them onto the `PickerProject` shape consumed by
 * `<fl-project-picker>`. We map the server's `updatedAt` to the
 * picker's `lastUsedAt` so the recent-first ordering naturally tracks
 * the user's most-recently-touched projects without needing a new
 * column on the server (design.md §"Project Picker Fallback" stores
 * `lastSelectedAt` client-side but we have no per-user activity data
 * yet — `updatedAt` is the closest server-side proxy).
 *
 * Exported so tests can stub `apiFetch` and verify the projection.
 */
export async function fetchPickerProjects(): Promise<PickerProject[]> {
  const res = await apiFetch<{ projects: Project[] }>(`/projects`);
  const list = Array.isArray(res?.projects) ? res.projects : [];
  return list.map((p) => ({
    id: p.id,
    name: p.name,
    lastUsedAt: p.updatedAt,
  }));
}

/**
 * Test-only setter for the module-level `overlayEnabled` flag. Lets
 * unit tests drive the picker helpers without going through the
 * `chrome.runtime.onMessage` toggle path (jsdom does not implement
 * the `chrome.*` runtime).
 */
export function __setOverlayEnabledForTests(value: boolean): void {
  overlayEnabled = value;
}

/**
 * Re-resolve the Project for the current page when the host page navigates
 * via SPA history (Req 38.1, task 29.3). Both the in-page `historyPatch`
 * (`pushState` / `replaceState` / `popstate`) and the service-worker
 * bridge (`chrome.webNavigation.onHistoryStateUpdated`) dispatch the same
 * `pinpoint:locationchange` event, so this single listener covers
 * both signal sources.
 *
 * Behaviour:
 *   - `resolveProjectForUrl` returns the new Project (cache hit or
 *     `GET /by-url`). When it differs from the host's current Project,
 *     we call `setProjectId` (which leaves the old Socket.IO room, joins
 *     the new room, and clears stale store data) and reseed the host
 *     with the new Project's annotations + members.
 *   - When the new Project matches the current binding, we leave the
 *     host alone so Socket.IO presence is preserved across navigations
 *     within the same Project (e.g. SPAs that use `pushState` for
 *     intra-project routing).
 *   - When `resolveProjectForUrl` returns null AND the user is signed
 *     in AND the overlay is enabled, the project picker fallback (Req
 *     38.2 / 39.1, task 29.4) takes over: we fetch the user's
 *     accessible projects and reveal `<fl-project-picker>`. Otherwise
 *     we leave the host bound to its previous Project.
 */
async function onLocationChange(): Promise<void> {
  if (!overlayHostEl) return;
  const host = overlayHostEl;
  let nextProjectId: string | null;
  try {
    nextProjectId = await resolveProjectForUrl(window.location.href);
  } catch {
    nextProjectId = null;
  }

  // Task 29.4 / Req 38.2: when no Project resolves for the current URL
  // (cache miss + by-url 404) the picker fallback should take over.
  // We only reveal it when the user is signed in (otherwise the picker
  // has no projects to show) AND the overlay is currently enabled
  // (otherwise the entire shadow host is hidden anyway). The picker
  // hides the rest of the overlay; on selection the `picker-select`
  // host-action swaps the active Project.
  if (nextProjectId === null) {
    await maybeShowProjectPicker(host);
    return;
  }
  if (nextProjectId === host.projectId) {
    // URL re-resolved to the same Project — make sure any stale picker
    // is dismissed so the overlay surfaces are visible again.
    host.hideProjectPicker();
    return;
  }

  host.hideProjectPicker();
  host.setProjectId(nextProjectId);
  await seedProjectData(host, nextProjectId);
}

/** Bootstrap: create the Shadow Host, mount `<fl-overlay-host>`, configure it. */
async function mountOverlay(): Promise<void> {
  const { root } = ensureShadowHost();

  // Idempotent — a second invocation (HMR, repeated injection) reuses the
  // existing host instead of stacking another one.
  if (overlayHostEl) return;

  const host = document.createElement('fl-overlay-host') as FlOverlayHost;
  host.addEventListener('host-action', onHostAction as EventListener);
  root.appendChild(host);
  overlayHostEl = host;

  applyOverlayVisibility();

  // Task 36.4 / Req 44.3 — wire the Syncer's success-path remap into
  // the overlay store. When the Syncer drains a queued create-
  // annotation or create-comment, the server's response carries the
  // canonical id (and `pinNumber` for annotations); the adapter swaps
  // the optimistic row's `id === localUuid` for the server-assigned
  // values so the rest of the UI stops referencing the local UUID.
  // Every step is defensive: a row that was already reconciled by a
  // socket broadcast (`annotation:created`, `comment:created`) is left
  // alone, and a row that was never inserted optimistically is a no-
  // op rather than a duplicate insert. The cascade rewrite of *other*
  // outbox entries (e.g., a comment queued under the optimistic
  // annotation) happens inside the Syncer itself; this adapter only
  // touches the in-memory signals.
  setSyncRemapAdapter({
    remapAnnotation: (localUuid, serverAnnotation) => {
      const current = overlayHostEl;
      if (!current) return;
      const annotations = current.store.annotations.get();
      const next = annotations.map((a) => {
        if (a.id === localUuid) {
          return {
            ...a,
            // Preserve any locally-attached fields the optimistic row
            // owns (e.g., a Capture_Buffer the server didn't echo back)
            // and overlay the server-assigned canonical fields on top.
            ...(serverAnnotation as Partial<Annotation>),
            id: serverAnnotation.id,
            pinNumber: serverAnnotation.pinNumber,
          };
        }
        return a;
      });
      // If a parallel `annotation:created` socket replay already
      // swapped the row, `Object.is(prev, next)` will short-circuit
      // inside the signal — no redundant fan-out.
      current.store.annotations.set(next);

      // Keep `selectedAnnotationId` pointing at the canonical row so
      // the popover stays open across the swap. Without this the
      // popover briefly closes when its `annotation` lookup misses.
      const selected = current.store.selectedAnnotationId.get();
      if (selected === localUuid) {
        current.store.selectedAnnotationId.set(serverAnnotation.id);
      }
    },
    remapComment: (localUuid, serverComment) => {
      const current = overlayHostEl;
      if (!current) return;
      const comments = current.store.comments.get();
      const next = comments.map((c) =>
        c.id === localUuid
          ? { ...c, ...(serverComment as Record<string, unknown>), id: serverComment.id }
          : c,
      );
      current.store.comments.set(next as typeof comments);
    },
    // Task 36.7 / Req 44.6 — flag the optimistic pin whose `id ===
    // localUuid` as having a stale anchor. The Syncer calls this
    // before replaying a queued create-annotation when the stored
    // selector no longer resolves on the live page. We splice
    // `targetStale: true` onto the annotation row so the OverlayHost's
    // pin reconciliation marks `<fl-annotation-pin data-fallback="true">`
    // (matching `PinPositioner`'s missing-target contract) and the
    // popover surfaces a "Target may have moved" notice in view mode.
    // The flag is purely advisory — the replay still proceeds with the
    // original payload because the user's textual feedback is the
    // source of truth, not the anchor.
    flagPinAsStale: (localUuid) => {
      const current = overlayHostEl;
      if (!current) return;
      const annotations = current.store.annotations.get();
      let mutated = false;
      const next = annotations.map((a) => {
        if (a.id !== localUuid) return a;
        if (a.targetStale === true) return a;
        mutated = true;
        return { ...a, targetStale: true };
      });
      if (mutated) {
        current.store.annotations.set(next);
      }
    },
  });

  // Connection monitor (task 36.8 / Req 44.1). Tracks `navigator.onLine`
  // and a 30 s `HEAD /api/v1/health` heartbeat, flipping the
  // `host.store.isOffline` slice — which the toolbar subscribes to to
  // show the "Offline" banner. We pipe the monitor's signal into the
  // host store rather than passing it through directly so the two
  // signals stay decoupled (the host store remains the single source
  // of truth for every UI surface) and so tests that assemble a host
  // by hand can swap a fake monitor without touching the toolbar.
  if (!connectionMonitorInstance) {
    connectionMonitorInstance = createConnectionMonitor();
    connectionMonitorInstance.isOffline.subscribe((offline) => {
      const current = overlayHostEl;
      if (!current) return;
      current.store.isOffline.set(offline);
    });
  }

  const [token, projectId] = await Promise.all([
    readStoredAuthToken(),
    resolveProjectForUrl(window.location.href),
  ]);
  host.token = token;
  host.projectId = projectId;
  if (projectId) {
    await seedProjectData(host, projectId);
  }
}

/**
 * Tear down the overlay: removes the Shadow Host from the page, drops
 * the `<fl-overlay-host>` reference, and stops the connection monitor.
 * Idempotent — safe to call when nothing was mounted (e.g. bootstrap
 * never ran because the per-site guard skipped injection).
 *
 * Called from a `pagehide` listener wired up in `bootstrap()` so the
 * overlay does not linger as a detached subtree when the host page
 * navigates away. Wrapping the call in `withContentScriptBoundary`
 * (Req 50.2) ensures that unmount-time failures cannot break the host
 * page's own `pagehide` listeners.
 */
function unmountOverlay(): void {
  if (overlayHostEl) {
    overlayHostEl.removeEventListener('host-action', onHostAction as EventListener);
    overlayHostEl = null;
  }
  if (shadowHostEl) {
    if (shadowHostEl.parentNode) {
      shadowHostEl.parentNode.removeChild(shadowHostEl);
    }
    shadowHostEl = null;
  }
  if (connectionMonitorInstance) {
    connectionMonitorInstance.dispose();
    connectionMonitorInstance = null;
  }
  // Task 36.4 — drop the Syncer's adapter so a stale closure cannot
  // poke at a torn-down `overlayHostEl` after `pagehide`.
  setSyncRemapAdapter(null);
}

/** Flip overlay visibility in response to `TOGGLE_OVERLAY`. */
function toggleOverlay(): void {
  overlayEnabled = !overlayEnabled;
  applyOverlayVisibility();
  // Task 29.4 / Req 38.2: the picker fallback should only appear once
  // the user has actually opened the overlay. When toggling on with no
  // active Project bound, surface the picker so the user can pick one
  // for the current page. When toggling off, leave the host alone —
  // the shadow host's `display: none` already hides the picker.
  if (overlayEnabled && overlayHostEl && !overlayHostEl.projectId) {
    maybeShowProjectPicker(overlayHostEl).catch((err) => {
      console.error('[pinpoint] maybeShowProjectPicker failed', err);
    });
  }
}

/**
 * Top-level bootstrap. Runs only after the per-site allow/block guard
 * (tasks 38.2 / 38.3, Requirements 46.2 / 46.3) clears: the content
 * script must do nothing — no history patch, no message listeners, no
 * overlay mount — when the host page is excluded by user configuration.
 *
 * Wrapping the side-effects in a function (instead of leaving them at
 * module scope) is what makes the guard meaningful: once the dynamic
 * `import` of `./components/OverlayHost` has registered the Custom
 * Element class globally, the only remaining observable effects on the
 * host page happen here.
 */
function bootstrap(): void {
  // Observe SPA navigations on the host page (Req 38.1, task 29.1).
  // Other modules subscribe to `pinpoint:locationchange` to
  // re-resolve the active project and refresh the overlay; this only
  // installs the patch.
  installHistoryPatch();

  // Outbox replay loop (task 36.3, Req 44.3). Registers an `online`
  // listener and a 30 s `setInterval` that drain `chrome.storage.local`
  // entries through the live API with `clientRequestId = localUuid` so
  // the server's idempotent-replay path (task 35.2) recognises retries.
  // Idempotent — repeat calls (HMR, double script injection) are no-ops.
  startSyncer();

  window.addEventListener('pinpoint:locationchange', () => {
    onLocationChange().catch((err) => {
      console.error('[pinpoint] onLocationChange failed', err);
    });
  });

  // Listen for the toggle message from the background service worker.
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const type = (message as { type?: unknown }).type;
      if (type === 'TOGGLE_OVERLAY') {
        toggleOverlay();
        return;
      }
      // Keyboard-shortcut bridge (task 31.2 / Req 40.1). The service
      // worker forwards `chrome.commands.onCommand` events as
      // `FL_COMMAND` messages; we re-dispatch them as a window-scoped
      // CustomEvent so the toolbar, sidebar, and pin renderer (which
      // all live inside the Shadow Root) can subscribe without
      // depending on `chrome.runtime`.
      if (type === 'FL_COMMAND') {
        const command = (message as { command?: unknown }).command;
        if (typeof command !== 'string' || command.length === 0) return;
        window.dispatchEvent(
          new CustomEvent('pinpoint:command', { detail: { command } }),
        );
      }
      // SPA navigation bridge (task 29.2 / Req 38.1). The service worker
      // observes `chrome.webNavigation.onHistoryStateUpdated` for the
      // top frame and forwards the new URL here. We re-dispatch it as
      // the same `pinpoint:locationchange` CustomEvent that
      // `historyPatch` emits, so listeners only need one subscription
      // regardless of whether the navigation was caught in-page or
      // surfaced by webNavigation.
      if (type === 'FL_LOCATION_CHANGE') {
        const url = (message as { url?: unknown }).url;
        if (typeof url !== 'string' || url.length === 0) return;
        window.dispatchEvent(
          new CustomEvent('pinpoint:locationchange', { detail: { url } }),
        );
      }
    });
  }

  // Kick off the mount under the outer ContentScriptBoundary (task
  // 42.2 / Req 50.2). The boundary catches synchronous throws AND any
  // rejected promise from `mountOverlay()` so a failure during overlay
  // bootstrapping (Shadow Host creation, custom-element registration,
  // project resolution, network) cannot propagate into the host page's
  // runtime. The host's own JavaScript MUST keep running even if the
  // overlay blows up.
  void withContentScriptBoundary(() => mountOverlay());

  // Tear the overlay down on `pagehide` so we leave no detached subtree
  // behind. Wrapped under the same `ContentScriptBoundary` (Req 50.2)
  // so unmount-time failures cannot break the host page's own
  // navigation lifecycle.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => {
      withContentScriptBoundary(() => unmountOverlay());
    });
  }
}

/**
 * Per-site allow/block guard (tasks 38.2 / 38.3, Reqs 46.2 / 46.3).
 *
 * Runs at the very top of the content script's execution — before the
 * Shadow Host is created, before any DOM manipulation, before message
 * listeners are wired, before the history patch is installed.
 *
 *   - Block-list match → log + return (no injection).
 *   - Non-empty allow-list with no match → log + return (no injection).
 *   - Otherwise → call `bootstrap()`.
 *
 * Storage failures fall back to "allow" inside `shouldSkipInjection` so
 * a flaky `chrome.storage.sync` does not silently disable the extension
 * on every page.
 */
async function runGuardThenBootstrap(): Promise<void> {
  const decision = await shouldSkipInjection();
  if (decision.skip) {
    const reason =
      decision.reason === 'block-list'
        ? 'host matches block-list'
        : 'host not in non-empty allow-list';
    console.debug(
      `[pinpoint] skipping injection on ${window.location.hostname}: ${reason}`,
    );
    return;
  }
  bootstrap();
}

/**
 * Sub-frame branch (task 40.2 / Req 48.2).
 *
 * `manifest.json` runs the content script in every same-origin frame
 * (`all_frames: true`, task 40.1). The full overlay must mount only
 * once, in the top frame, otherwise we get duplicate UIs nested
 * inside iframes. Sub-frames instead register a tiny click-relay that
 * `postMessage`s the click rect up to the top frame so the top-frame
 * `<fl-overlay-host>` can anchor a popover at the relayed
 * coordinates (task 40.3).
 *
 * `runGuardThenBootstrap` is intentionally not invoked in sub-frames —
 * the per-site allow/block guard is a top-frame concern, and the
 * relay is small enough that re-applying the guard would cost more
 * than the bytes it could save.
 */
if (typeof window !== 'undefined' && window.top !== window.self) {
  void import('./content/subFrameRelay.js').then(({ installSubFrameRelay }) => {
    installSubFrameRelay();
  });
} else {
  runGuardThenBootstrap().catch((err) => {
    // `shouldSkipInjection` already swallows storage failures, so the only
    // way to land here is something genuinely unexpected. Default to
    // "inject" so a guard bug never disables the overlay silently.
    console.error('[pinpoint] guard check failed; injecting anyway', err);
    bootstrap();
  });
}
