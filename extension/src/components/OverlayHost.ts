/**
 * `<fl-overlay-host>` — Web Component conversion of the React `OverlayManager`
 * shell (extension/src/components/OverlayManager.tsx).
 *
 * Per task 17.8 of the pinpoint-app spec (Requirements 31.2, 31.3) and
 * the `<fl-overlay-host>` description in design.md (Key Design Decision #2,
 * Architecture diagram, "Chrome Extension Components"):
 *
 *   1. HTMLElement subclass with an open Shadow Root + `adoptStyles()`.
 *   2. Owns the overlay store as a set of `signal<T>()` slices imported from
 *      `@pinpoint/shared`:
 *        - `annotations: Signal<Annotation[]>`
 *        - `comments: Signal<FLComment[]>`
 *        - `selectedAnnotationId: Signal<string | null>`
 *        - `popoverTarget: Signal<PopoverTarget | null>`
 *        - `members: Signal<MentionCandidate[]>`
 *        - `reconnecting: Signal<boolean>`
 *        - `viewersByAnnotation: Signal<Record<string, string[]>>`
 *      The store itself is exported as `createOverlayStore()` so tests can
 *      mount the host with a pre-seeded store.
 *   3. Instantiates exactly one `PinPositioner` (Req 14.5) and uses it to
 *      register / unregister `<fl-annotation-pin>` instances as the
 *      `annotations` signal changes.
 *   4. Mounts the Socket.IO `/collab` client (lazy-imported so the host is
 *      still constructable in jsdom test environments where
 *      `socket.io-client` runtime is not exercised). Subscribes to the events
 *      called out in design.md WebSocket Events table:
 *        - `annotation:created`, `annotation:updated`, `annotation:status`,
 *          `comment:created`, `annotation:viewers`, `presence:update`
 *      and updates the corresponding store signal. The socket also drives the
 *      `reconnecting` signal via `disconnect` / `reconnect_attempt` /
 *      `connect`.
 *   5. Renders the overlay UI by assembling the leaf Custom Elements in the
 *      Shadow Root:
 *        - `<fl-floating-toolbar>`
 *        - `<fl-sidebar-panel>`
 *        - `<fl-popover>`
 *        - one `<fl-annotation-pin>` per current annotation, registered with
 *          the `PinPositioner` against its resolved DOM target
 *      On store changes, child element properties are reassigned (children
 *      observe the store via property setters; this host never touches their
 *      Shadow DOM).
 *   6. Listens for child events (`pin-click`, `submit`, `cancel`, `close`,
 *      `comment-submit`, `status-change`, `annotation-select`) and updates
 *      the store. API mutations (annotation create / status / comment) are
 *      dispatched as `host-action` `CustomEvent`s so the content script
 *      (which holds the `apiFetch` wrapper) can route them — keeps the
 *      Shadow DOM unit testable in jsdom without spinning up `chrome.*`.
 *   7. `disconnectedCallback` disposes the `PinPositioner`, disconnects the
 *      socket, and unsubscribes every store listener.
 *   8. Idempotent `customElements.define()` — guarded so HMR / repeated test
 *      imports do not throw "this name has already been used".
 *
 * Implements: Requirements 31.2, 31.3.
 */

import type {
  Annotation,
  AnnotationStatus,
  Comment as FLComment,
  Severity,
  Signal,
} from '@pinpoint/shared';
import { signal } from '@pinpoint/shared';

import { io } from 'socket.io-client';

import { adoptStyles } from '../styles/sharedStyleSheet';
import { DOMTargetResolver } from '../lib/DOMTargetResolver';
import { DEFAULT_API_ORIGIN } from '../lib/api';
import { withBoundary } from '../lib/withBoundary';
import {
  PinPositioner,
  type PinPositionerOptOutStorage,
} from '../lib/PinPositioner';
import {
  PinClusterer,
  type PinCluster,
} from '../lib/PinClusterer';
import { HoverOutline } from '../lib/HoverOutline';
import type { MentionCandidate } from '../lib/mentionFilter';

import './FloatingToolbar';
import './SidebarPanel';
import './Popover';
import './AnnotationPin';
import './ClusterPin';
import './ClusterListPopover';
import './ProjectPicker';

import {
  SUBFRAME_CLICK_MESSAGE_TYPE,
  type SubFrameClickMessage,
} from '../content/subFrameRelay';

import type { AnnotationPin as FlAnnotationPinElement } from './AnnotationPin';
import type { ClusterPin as FlClusterPinElement } from './ClusterPin';
import type { FlFloatingToolbar } from './FloatingToolbar';
import type { FlSidebarPanel, AnnotationSelectEventDetail } from './SidebarPanel';
import type {
  FlPopover,
  PopoverTarget,
  PopoverSubmitDetail,
  PopoverStatusChangeDetail,
  PopoverCommentSubmitDetail,
} from './Popover';
import type { FlClusterListPopover } from './ClusterListPopover';
import { popoverTargetFromRect } from './ClusterListPopover';
import type {
  FlProjectPicker,
  PickerProject,
  ProjectPickerSelectEventDetail,
} from './ProjectPicker';

/* -------------------------------------------------------------------------- */
/* Overlay store                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The reactive overlay store. Each field is an independent `signal<T>()`
 * slice so subscribers only re-render the part of the UI they care about.
 *
 * Field set per design.md ("`<fl-overlay-host>` is the only element the
 * content script appends to the Shadow Root. It owns the overlay store
 * (signals for `annotations`, `comments`, `selectedAnnotationId`,
 * `popoverTarget`, `members`, `reconnecting`, `viewersByAnnotation`) …")
 * plus `isOffline` for the floating-toolbar's offline banner (Req 44.1,
 * task 36.8). The slice is owned here so any future surface (sidebar,
 * popover) can subscribe without re-plumbing the host.
 */
export interface OverlayStore {
  readonly annotations: Signal<Annotation[]>;
  readonly comments: Signal<FLComment[]>;
  readonly selectedAnnotationId: Signal<string | null>;
  readonly popoverTarget: Signal<PopoverTarget | null>;
  readonly members: Signal<MentionCandidate[]>;
  readonly reconnecting: Signal<boolean>;
  readonly viewersByAnnotation: Signal<Record<string, string[]>>;
  readonly isOffline: Signal<boolean>;
}

/** Build a fresh overlay store with empty initial values. */
export function createOverlayStore(): OverlayStore {
  return {
    annotations: signal<Annotation[]>([]),
    comments: signal<FLComment[]>([]),
    selectedAnnotationId: signal<string | null>(null),
    popoverTarget: signal<PopoverTarget | null>(null),
    members: signal<MentionCandidate[]>([]),
    reconnecting: signal<boolean>(false),
    viewersByAnnotation: signal<Record<string, string[]>>({}),
    isOffline: signal<boolean>(false),
  };
}

/* -------------------------------------------------------------------------- */
/* Socket adapter                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Minimal subset of the `socket.io-client` `Socket` surface the host
 * touches. Declared as an interface so tests can inject a fake socket
 * without pulling in the full client runtime.
 */
export interface OverlaySocket {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  off?(event: string, handler?: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  disconnect(): unknown;
}

/** Factory used by the host to create a socket. Replaceable for tests. */
export type OverlaySocketFactory = (config: {
  projectId: string;
  token: string;
  serverUrl: string;
}) => OverlaySocket | null;

/* -------------------------------------------------------------------------- */
/* Custom event detail types                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `host-action` event detail. The host emits one of these whenever a
 * persistence-bearing user action happens inside the overlay; the content
 * script (which owns the API client) listens and routes them. Keeping the
 * API call out of the host means the Shadow DOM is fully unit-testable in
 * jsdom without the `apiFetch` machinery.
 */
export type OverlayHostAction =
  | { kind: 'create-annotation'; annotation: Annotation }
  | { kind: 'change-status'; annotationId: string; status: AnnotationStatus }
  | { kind: 'create-comment'; annotationId: string; body: string; mentions: string[] }
  | { kind: 'overlay-close' }
  | { kind: 'picker-select'; projectId: string };

/* -------------------------------------------------------------------------- */
/* Element                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Severity → priority mapping used to pick a representative severity for
 * a cluster pin. Mirrors the visual ranking the dashboard uses (critical
 * is the loudest color and "wins" when multiple severities co-cluster).
 */
const CLUSTER_SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  informational: 1,
};

/**
 * Pick the highest-priority severity from a set of annotations, or
 * `null` when the set is empty. Used by the cluster pin so the badge
 * picks up the most-severe color in its bucket.
 */
function pickHighestSeverity(annotations: readonly Annotation[]): Severity | null {
  let best: Severity | null = null;
  let bestRank = -Infinity;
  for (const a of annotations) {
    const rank = CLUSTER_SEVERITY_RANK[a.severity] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = a.severity;
    }
  }
  return best;
}

/**
 * Parse an element's current `transform: translate3d(<x>px, <y>px, 0)`
 * value into `{ x, y }` page coordinates. Returns `null` when the
 * transform has not been set yet (no rAF tick has run, or the positioner
 * deliberately left it untouched on the fallback path). Used by the
 * clusterer to read the same coordinates the user sees on screen so a
 * zoom-in that brings two pins into the same bucket clusters them
 * (Req 52.3).
 */
function readTransformCoords(el: HTMLElement): { x: number; y: number } | null {
  const transform = el.style.transform;
  if (!transform) return null;
  const match = /translate3d\(\s*(-?\d+(?:\.\d+)?)px\s*,\s*(-?\d+(?:\.\d+)?)px\s*,/.exec(
    transform,
  );
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

const TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <div class="fl-overlay-root" data-pinpoint="overlay-host" part="root">
      <div class="fl-reconnecting" hidden part="reconnecting" role="status" aria-live="polite">
        Reconnecting…
      </div>
      <div class="fl-pin-layer" part="pins"></div>
      <fl-sidebar-panel part="sidebar"></fl-sidebar-panel>
      <fl-popover part="popover"></fl-popover>
      <fl-cluster-list-popover part="cluster-list"></fl-cluster-list-popover>
      <fl-floating-toolbar part="toolbar"></fl-floating-toolbar>
      <div class="fl-project-picker-fallback" part="picker" hidden>
        <fl-project-picker part="picker-element"></fl-project-picker>
      </div>
    </div>
  `;
  return t;
})();

export class FlOverlayHost extends HTMLElement {
  static readonly tagName = 'fl-overlay-host';

  // --- store + lifecycle ---
  #store: OverlayStore;
  #pinPositioner: PinPositioner | null = null;
  #hoverOutline: HoverOutline | null = null;
  #socket: OverlaySocket | null = null;
  #socketFactory: OverlaySocketFactory | null = null;
  #unsubs: Array<() => void> = [];

  // --- per-annotation pin elements ---
  #pinEls = new Map<string, FlAnnotationPinElement>();

  // --- pin clustering (Req 52.1 / 52.3, tasks 44.1–44.4) ---
  #pinClusterer: PinClusterer = new PinClusterer();
  /** Cluster pins keyed by their bucket key (`${bx}:${by}`). */
  #clusterEls = new Map<string, FlClusterPinElement>();
  /** Annotation ids currently rolled up into a cluster (so their individual pin is hidden). */
  #clusteredAnnotationIds = new Set<string>();
  /** Whether the cluster + visualViewport listeners have been wired. */
  #clusterListenersWired = false;
  #visualViewportRef: VisualViewport | null = null;

  // --- shadow refs ---
  #pinLayer!: HTMLElement;
  #sidebar!: FlSidebarPanel;
  #popover!: FlPopover;
  #clusterList!: FlClusterListPopover;
  #toolbar!: FlFloatingToolbar;
  #reconnectingBanner!: HTMLElement;
  #pickerWrapper!: HTMLElement;
  #picker!: FlProjectPicker;
  #pickerVisible = false;

  // --- configuration ---
  #projectId: string | null = null;
  #pageId: string | null = null;
  #token: string | null = null;
  #serverUrl: string = DEFAULT_API_ORIGIN;

  // --- sub-frame click relay listener (task 40.3, Req 48.2) ---
  #subFrameMessageListener: ((event: MessageEvent) => void) | null = null;

  constructor(store?: OverlayStore) {
    super();
    this.#store = store ?? createOverlayStore();

    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    root.appendChild(TEMPLATE.content.cloneNode(true));

    this.#pinLayer = root.querySelector('.fl-pin-layer') as HTMLElement;
    this.#sidebar = root.querySelector('fl-sidebar-panel') as FlSidebarPanel;
    this.#popover = root.querySelector('fl-popover') as FlPopover;
    this.#clusterList = root.querySelector('fl-cluster-list-popover') as FlClusterListPopover;
    this.#toolbar = root.querySelector('fl-floating-toolbar') as FlFloatingToolbar;
    this.#reconnectingBanner = root.querySelector('.fl-reconnecting') as HTMLElement;
    this.#pickerWrapper = root.querySelector('.fl-project-picker-fallback') as HTMLElement;
    this.#picker = root.querySelector('fl-project-picker') as FlProjectPicker;
  }

  /* -------------------------------------------------------------------- */
  /* Public configuration                                                 */
  /* -------------------------------------------------------------------- */

  /** Read-only access to the underlying store (so consumers can subscribe). */
  get store(): OverlayStore {
    return this.#store;
  }

  /**
   * Replace the overlay store. Resets every subscription so the new store
   * drives all child elements. Useful for tests that want a host with a
   * pre-seeded store.
   */
  set store(next: OverlayStore) {
    this.#teardownSubscriptions();
    this.#store = next;
    if (this.isConnected) {
      this.#wireSubscriptions();
    }
  }

  /** Project this overlay is collaborating on. */
  get projectId(): string | null {
    return this.#projectId;
  }
  set projectId(next: string | null | undefined) {
    this.#projectId = next ?? null;
    this.#maybeMountSocket();
  }

  /**
   * Optional page identifier the host is currently bound to. Mirrors the
   * `pageId` returned by `GET /api/v1/projects/by-url` so callers that
   * need to scope subsequent fetches (annotations, members) to the same
   * page can retrieve it without re-resolving.
   */
  get pageId(): string | null {
    return this.#pageId;
  }
  set pageId(next: string | null | undefined) {
    this.#pageId = next ?? null;
  }

  /**
   * Re-bind the overlay to a different Project (Req 38.1, task 29.3).
   *
   * SPA navigations on the host page leave `<fl-overlay-host>` mounted
   * but require it to switch the room it's joined to and clear out the
   * stale annotation / comment / member data that belonged to the
   * previous Project. Steps:
   *
   *   1. Leave the previous Socket.IO room via `socket.emit('leave', …)`
   *      so server-side presence tracking drops this socket from the old
   *      room before the new room arrives.
   *   2. Update the host's `projectId` (and optional `pageId`) fields.
   *   3. Re-emit `join` on the still-connected socket so the same socket
   *      now broadcasts presence to the new room — no reconnect, no new
   *      handshake.
   *   4. Reset the `annotations`, `comments`, `members`, and
   *      `viewersByAnnotation` signals to empty values, and clear the
   *      currently-selected annotation / popover. The content script
   *      reseeds the host with a fresh `GET /projects/:id/annotations`
   *      and `GET /projects/:id/members` after this returns; child
   *      components show their empty / loading state in the meantime.
   *
   * Calling `setProjectId(null)` simply clears the binding (used by the
   * project-picker fallback covered by tasks 30.x). Calling with the
   * same id the host is already bound to is a no-op.
   */
  setProjectId(
    projectId: string | null,
    pageId: string | null = null,
  ): void {
    const previous = this.#projectId;
    const next = projectId ?? null;
    if (previous === next) {
      // Same project — only refresh the page id (still cheap to keep
      // the helper idempotent for repeated SPA pings to the same URL).
      this.#pageId = pageId ?? null;
      return;
    }

    // 1. Leave the old room before changing identity. Best-effort: a
    //    torn-down socket must not break the rebind.
    if (this.#socket && previous) {
      try {
        this.#socket.emit('leave', { projectId: previous });
      } catch {
        /* swallow — leave is advisory */
      }
    }

    // 2. Update identity.
    this.#projectId = next;
    this.#pageId = pageId ?? null;

    // 3. Reset the stale store slices so the sidebar / pin layer / popover
    //    drop everything that belonged to the previous Project. The
    //    content script reseeds them with the new Project's data.
    this.#store.annotations.set([]);
    this.#store.comments.set([]);
    this.#store.members.set([]);
    this.#store.viewersByAnnotation.set({});
    this.#store.selectedAnnotationId.set(null);
    this.#store.popoverTarget.set(null);

    // 4. Join the new room. If the socket isn't mounted yet (no token,
    //    or the previous projectId was null), `#maybeMountSocket` covers
    //    the cold-start case.
    if (this.#socket && next && this.#token) {
      try {
        this.#socket.emit('join', { projectId: next, token: this.#token });
      } catch {
        /* best-effort */
      }
    } else {
      this.#maybeMountSocket();
    }
  }

  /** Bearer token for the Socket.IO auth handshake. */
  get token(): string | null {
    return this.#token;
  }
  set token(next: string | null | undefined) {
    this.#token = next ?? null;
    this.#maybeMountSocket();
  }

  /** Override the API/Socket origin (defaults to `DEFAULT_API_ORIGIN`). */
  get serverUrl(): string {
    return this.#serverUrl;
  }
  set serverUrl(next: string | null | undefined) {
    if (typeof next === 'string' && next.length > 0) this.#serverUrl = next;
  }

  /**
   * Inject a socket factory. When set BEFORE `connectedCallback`, the host
   * uses this factory in lieu of the default `socket.io-client` import.
   * Tests pass in a fake; production code leaves it unset and the host
   * lazy-loads the real client.
   */
  setSocketFactory(factory: OverlaySocketFactory | null): void {
    this.#socketFactory = factory;
  }

  /* -------------------------------------------------------------------- */
  /* Project picker fallback (Req 38.2 / 39.1, task 29.4)                 */
  /* -------------------------------------------------------------------- */

  /**
   * Reveal `<fl-project-picker>` with the supplied list of accessible
   * projects, hiding the rest of the overlay (pins, sidebar, popover,
   * floating toolbar) so the user can pick a Project for the current
   * page. Called by the content script when:
   *
   *   - `chrome.storage.local`'s URL→Project cache has no entry for
   *     `origin + pathname` (task 30.2 / 30.3), AND
   *   - `GET /api/v1/projects/by-url` returned 404.
   *
   * The picker emits a `select` event when the user picks a row; the
   * host re-dispatches that as a `host-action` of kind `picker-select`
   * so the content script (which owns the API client) can swap the
   * Project, refresh annotations + members, and join the new room.
   * Storage persistence (Req 39.2) already happens inside the picker
   * itself before the event fires.
   *
   * Idempotent: calling with a fresh list while the picker is already
   * visible just refreshes the rows.
   */
  showProjectPicker(projects: readonly PickerProject[]): void {
    this.#picker.projects = projects;
    if (!this.#pickerVisible) {
      this.#pickerVisible = true;
      this.#pickerWrapper.hidden = false;
      this.#applyPickerVisibility();
    }
  }

  /**
   * Hide the project picker. Called by the content script after the
   * user picks a Project (or after the URL re-resolves to a Project
   * via cache / `by-url`). Restores the rest of the overlay.
   */
  hideProjectPicker(): void {
    if (!this.#pickerVisible) return;
    this.#pickerVisible = false;
    this.#pickerWrapper.hidden = true;
    this.#applyPickerVisibility();
  }

  /** Whether the project picker is currently mounted in the visible state. */
  get pickerVisible(): boolean {
    return this.#pickerVisible;
  }

  /**
   * When the picker is visible we hide every other overlay surface so
   * the user is not torn between picking a Project and clicking a stale
   * sidebar entry that belongs to nothing yet. Implemented as inline
   * `display: none` on the four child surfaces because the shared
   * stylesheet's `:host` selector cannot reach descendants of the
   * shadow tree from outside.
   */
  #applyPickerVisibility(): void {
    const hidden = this.#pickerVisible;
    this.#pinLayer.style.display = hidden ? 'none' : '';
    (this.#sidebar as HTMLElement).style.display = hidden ? 'none' : '';
    (this.#popover as HTMLElement).style.display = hidden ? 'none' : '';
    (this.#toolbar as HTMLElement).style.display = hidden ? 'none' : '';
    (this.#clusterList as HTMLElement).style.display = hidden ? 'none' : '';
  }

  /* -------------------------------------------------------------------- */
  /* Lifecycle                                                            */
  /* -------------------------------------------------------------------- */

  connectedCallback(): void {
    if (!this.hasAttribute('data-pinpoint')) {
      this.setAttribute('data-pinpoint', 'overlay-host-host');
    }

    // Instantiate the single PinPositioner this host owns (Req 14.5).
    // When running inside the Chrome extension runtime, wrap
    // `chrome.storage.sync` and `chrome.storage.onChanged` so the
    // positioner can honor the per-host opt-out toggle from the options
    // page (Req 51.3 / task 43.2).
    //
    // The positioner's `onAfterTick` hook drives `PinClusterer`
    // reclustering on every layout-affecting event (scroll, mutation,
    // resize, ResizeObserver). Pairing the cluster pass with the
    // positioner tick is what task 44.1 mandates ("runs after every
    // PinPositioner tick") and what gives us 52.3 — a zoom-in that
    // brings two pins into the same bucket clusters them, a zoom-out
    // that separates them re-expands the cluster.
    if (!this.#pinPositioner) {
      this.#pinPositioner = new PinPositioner({
        optOutStorage: this.#resolvePinPositionerOptOutStorage(),
        onAfterTick: () => this.#recomputeClusters(),
      });
    }

    // Single hover-preview outline that follows the pointer (Req 37.1, 37.2).
    if (!this.#hoverOutline) {
      this.#hoverOutline = new HoverOutline();
      const root = this.shadowRoot;
      if (root) {
        // The outermost shadow host (the wrapper div the content script
        // appends) is reachable via `root.host` when this element is the
        // document root of the shadow tree, otherwise via a walk up the
        // composed tree. We always pass it so the outline can recognise
        // its own surfaces and skip them (per task 28.1).
        const overlayShadowHost = this.#findOverlayShadowHost();
        this.#hoverOutline.attach(root, overlayShadowHost);
      }
    }

    this.#wireChildEventHandlers();
    this.#wireSubscriptions();
    this.#installSubFrameRelayListener();
    this.#wireClusterReclusterListeners();
    this.#maybeMountSocket();
  }

  disconnectedCallback(): void {
    this.#unwireChildEventHandlers();
    this.#teardownSubscriptions();
    this.#uninstallSubFrameRelayListener();
    this.#unwireClusterReclusterListeners();
    this.#teardownSocket();
    this.#disposePinPositioner();
    this.#disposeHoverOutline();
    this.#clearClusters();
    this.#clearPins();
  }

  /* -------------------------------------------------------------------- */
  /* Store ↔ child wiring                                                 */
  /* -------------------------------------------------------------------- */

  /**
   * Subscribe to every store signal and forward the value into the
   * appropriate child element via property assignment. Each `subscribe()`
   * fires once with the current value, so this also seeds initial state.
   */
  #wireSubscriptions(): void {
    const s = this.#store;

    this.#unsubs.push(
      s.annotations.subscribe((annotations) => {
        this.#sidebar.annotations = annotations;
        this.#syncPinElements(annotations);
        // Keep popover's nextPinNumber and (in view mode) annotation in sync.
        this.#popover.nextPinNumber = annotations.length + 1;
        const selected = s.selectedAnnotationId.get();
        if (selected) {
          const found = annotations.find((a) => a.id === selected) ?? null;
          this.#popover.annotation = found;
        }
      }),
    );

    this.#unsubs.push(
      s.comments.subscribe((comments) => {
        this.#popover.comments = comments;
      }),
    );

    this.#unsubs.push(
      s.selectedAnnotationId.subscribe((id) => {
        if (id === null) {
          this.#popover.annotation = null;
          return;
        }
        const found = s.annotations.get().find((a) => a.id === id) ?? null;
        this.#popover.annotation = found;
        // Tell the server we are viewing this annotation (Req 6.6).
        if (this.#socket) {
          try {
            this.#socket.emit('annotation:open', { id });
          } catch {
            /* socket might be torn down — best-effort */
          }
        }
      }),
    );

    this.#unsubs.push(
      s.popoverTarget.subscribe((target) => {
        this.#popover.target = target;
        // Req 37.3 (task 28.2): when the popover opens, hide the
        // hover-preview outline so the two surfaces never compete for
        // the user's attention. Re-enable it the moment the popover
        // closes — `HoverOutline` resumes drawing on the next
        // pointermove (it self-subscribes to `pointermove` on
        // `document`, see `HoverOutline.attach()`).
        this.#hoverOutline?.setHidden(target !== null);
      }),
    );

    this.#unsubs.push(
      s.members.subscribe((members) => {
        this.#popover.members = members;
      }),
    );

    this.#unsubs.push(
      s.reconnecting.subscribe((reconnecting) => {
        this.#reconnectingBanner.hidden = !reconnecting;
      }),
    );

    // Offline banner inside the floating toolbar (Req 44.1, task 36.8).
    // The slice is driven by `connectionMonitor.isOffline` (which fuses
    // `navigator.onLine` and the `/api/v1/health` heartbeat); this
    // subscription forwards the value as a property assignment so the
    // toolbar's hidden/visible state stays in sync without the toolbar
    // having to know about the connection monitor. The same value is
    // forwarded to the popover so its view-mode Resolve / Reopen
    // buttons can disable themselves on unsynced annotations while the
    // network is down (Req 44.5 / task 36.6); the popover derives the
    // "is unsynced" half locally from `annotation.pinNumber === 0`.
    this.#unsubs.push(
      s.isOffline.subscribe((offline) => {
        this.#toolbar.isOffline = offline;
        this.#popover.isOffline = offline;
      }),
    );

    // viewersByAnnotation has no direct child binding today (popover header
    // co-viewer indicator is task 14.2's UI work). Subscribe anyway so the
    // store stays the single source of truth and so subsequent UI work can
    // observe it without re-plumbing the host.
    this.#unsubs.push(s.viewersByAnnotation.subscribe(() => {}));
  }

  #teardownSubscriptions(): void {
    for (const off of this.#unsubs) {
      try {
        off();
      } catch {
        /* swallow — unsubscribing must never throw on teardown */
      }
    }
    this.#unsubs = [];
  }

  /* -------------------------------------------------------------------- */
  /* Pin layer                                                            */
  /* -------------------------------------------------------------------- */

  /**
   * Reconcile `<fl-annotation-pin>` elements against the current annotation
   * list. Pins for newly added annotations get created and registered with
   * the `PinPositioner`; pins whose annotation went away get unregistered
   * and detached; pins whose annotation changed keep the same DOM node and
   * just have their `annotation` property reassigned.
   *
   * Task 36.7 / Req 44.6 — when an annotation carries `targetStale: true`
   * (set by the Syncer when a queued create-annotation's stored selector
   * no longer resolves on replay), force `data-fallback="true"` on the
   * pin element so the warning ring renders even if `PinPositioner`
   * itself was able to resolve some sibling element. The flag is purely
   * advisory; we never clear it once set because re-resolving on every
   * paint would race with the user's pending replay.
   */
  #syncPinElements(annotations: readonly Annotation[]): void {
    const next = new Set<string>();
    for (const a of annotations) {
      next.add(a.id);
      const existing = this.#pinEls.get(a.id);
      if (existing) {
        existing.annotation = a;
        this.#applyTargetStaleFlag(existing, a);
      } else {
        const pin = document.createElement('fl-annotation-pin') as FlAnnotationPinElement;
        pin.annotation = a;
        this.#pinLayer.appendChild(pin);
        this.#pinEls.set(a.id, pin);
        const target = this.#resolveTarget(a);
        this.#pinPositioner?.register(a.id, pin, target, {
          pageX: a.target.pageX,
          pageY: a.target.pageY,
        });
        this.#applyTargetStaleFlag(pin, a);
      }
    }
    // Drop pins that are no longer in the list.
    for (const [id, pin] of Array.from(this.#pinEls.entries())) {
      if (!next.has(id)) {
        this.#pinPositioner?.unregister(id);
        pin.remove();
        this.#pinEls.delete(id);
      }
    }
    // The annotation set just changed. Recompute clusters once with the
    // current pin transforms so a freshly-added or freshly-removed pin
    // is grouped with (or split from) its neighbors immediately, even
    // before the next layout-driven tick (Req 52.3 / task 44.4).
    this.#recomputeClusters();
  }

  /**
   * Re-run `PinClusterer` against the current screen positions of every
   * registered pin and reconcile the `<fl-cluster-pin>` elements against
   * the result. Implements Requirement 52.3 / task 44.4: when the user
   * zooms in (or the page layout shifts) so two pins now share a bucket,
   * a single cluster pin is rendered with the count and the individual
   * pins are hidden; when zoom-out separates them again, the cluster is
   * dropped and the individual pins are revealed.
   *
   * The pin's screen position is read from the `transform: translate3d`
   * value `PinPositioner` writes during its tick (so this pass observes
   * the same coordinates the user sees), multiplied by the current
   * `visualViewport.scale` so a pinch-zoom in (which makes pins
   * visually closer together without changing the underlying CSS-pixel
   * coordinates) clusters and a pinch-zoom out re-expands. When the
   * transform has not been written yet (e.g. fallback path with no
   * stored coordinates) we fall back to the annotation's stored
   * `target.pageX/pageY`.
   */
  #recomputeClusters(): void {
    const annotations = this.#store.annotations.get();
    if (annotations.length === 0) {
      this.#applyClusters([]);
      return;
    }

    const scale = this.#currentViewportScale();
    const pinInputs = annotations.map((a) => {
      const el = this.#pinEls.get(a.id);
      const coords = el ? readTransformCoords(el) : null;
      const x = coords ? coords.x : a.target.pageX;
      const y = coords ? coords.y : a.target.pageY;
      return { id: a.id, x: x * scale, y: y * scale };
    });

    const clusters = this.#pinClusterer.cluster(pinInputs);
    this.#applyClusters(clusters);
  }

  /**
   * Apply a freshly-computed cluster set: create any new
   * `<fl-cluster-pin>` elements, update existing ones, drop stale ones,
   * and toggle the `hidden` flag on each individual `<fl-annotation-pin>`
   * so the user only ever sees one of the two surfaces per annotation.
   */
  #applyClusters(clusters: readonly PinCluster[]): void {
    const annotations = this.#store.annotations.get();
    const annotationsById = new Map(annotations.map((a) => [a.id, a]));

    const nextBucketKeys = new Set<string>();
    const nextClusteredIds = new Set<string>();
    const scale = this.#currentViewportScale();

    for (const cluster of clusters) {
      if (cluster.pinIds.length < 2) continue;
      nextBucketKeys.add(cluster.bucketKey);
      for (const id of cluster.pinIds) {
        nextClusteredIds.add(id);
      }
      const containedAnnotations = cluster.pinIds
        .map((id) => annotationsById.get(id))
        .filter((a): a is Annotation => Boolean(a));
      const severity = pickHighestSeverity(containedAnnotations);

      let clusterEl = this.#clusterEls.get(cluster.bucketKey);
      if (!clusterEl) {
        clusterEl = document.createElement('fl-cluster-pin') as FlClusterPinElement;
        this.#pinLayer.appendChild(clusterEl);
        this.#clusterEls.set(cluster.bucketKey, clusterEl);
      }
      clusterEl.pinIds = cluster.pinIds.slice();
      clusterEl.count = cluster.pinIds.length;
      clusterEl.severity = severity;
      // Position the cluster pin at the bucket centroid in CSS pixels.
      // `centroid` is in scaled coordinates; divide by the active scale
      // so the cluster lands in the same coordinate space as the
      // individual pins (which are positioned by `PinPositioner` in CSS
      // pixels). At scale === 1 this is a no-op.
      const cx = cluster.centroid.x / scale;
      const cy = cluster.centroid.y / scale;
      clusterEl.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
    }

    // Drop cluster pins whose bucket no longer has ≥ 2 members.
    for (const [bucketKey, el] of Array.from(this.#clusterEls.entries())) {
      if (!nextBucketKeys.has(bucketKey)) {
        el.remove();
        this.#clusterEls.delete(bucketKey);
      }
    }

    // Toggle hidden on individual pins: pins inside a cluster are
    // hidden, pins that were previously clustered but are now
    // standalone get revealed. The `hidden` HTML attribute is the right
    // mechanism here — Custom Elements honor it via the user-agent
    // stylesheet (`[hidden] { display: none !important }`).
    const previouslyClustered = this.#clusteredAnnotationIds;
    for (const id of nextClusteredIds) {
      const pin = this.#pinEls.get(id);
      if (pin) pin.hidden = true;
    }
    for (const id of previouslyClustered) {
      if (nextClusteredIds.has(id)) continue;
      const pin = this.#pinEls.get(id);
      if (pin) pin.hidden = false;
    }
    this.#clusteredAnnotationIds = nextClusteredIds;
  }

  /**
   * Read the current visual-viewport scale (1 when the page is not
   * zoomed). Falls back to 1 when `visualViewport` is unavailable
   * (older browsers / jsdom).
   */
  #currentViewportScale(): number {
    const vv = (typeof window !== 'undefined' ? window.visualViewport : null) as
      | VisualViewport
      | null
      | undefined;
    if (!vv || typeof vv.scale !== 'number' || !Number.isFinite(vv.scale) || vv.scale <= 0) {
      return 1;
    }
    return vv.scale;
  }

  /**
   * Wire `window.resize` and `visualViewport.resize` listeners so a
   * window resize or a pinch-zoom triggers a recluster (Req 52.3 / task
   * 44.4). The `PinPositioner` already listens for `resize` to recompute
   * pin transforms; the `onAfterTick` hook then drives the clusterer.
   * `visualViewport`'s pinch-zoom does NOT fire a `window.resize` on
   * every browser, so we add the explicit `visualViewport.resize`
   * listener here. Re-listening to `window.resize` is harmless (both
   * the positioner and the host coalesce through `flush()`).
   */
  #wireClusterReclusterListeners(): void {
    if (this.#clusterListenersWired) return;
    this.#clusterListenersWired = true;
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.#onViewportResize, { passive: true });
      const vv = window.visualViewport ?? null;
      if (vv) {
        this.#visualViewportRef = vv;
        vv.addEventListener('resize', this.#onViewportResize);
        vv.addEventListener('scroll', this.#onViewportResize);
      }
    }
  }

  #unwireClusterReclusterListeners(): void {
    if (!this.#clusterListenersWired) return;
    this.#clusterListenersWired = false;
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.#onViewportResize);
    }
    if (this.#visualViewportRef) {
      this.#visualViewportRef.removeEventListener('resize', this.#onViewportResize);
      this.#visualViewportRef.removeEventListener('scroll', this.#onViewportResize);
      this.#visualViewportRef = null;
    }
  }

  /**
   * Resize / pinch-zoom handler. Asks the positioner for a synchronous
   * tick (which writes fresh transforms AND fires `onAfterTick` so the
   * clusterer runs against the new coordinates). When the positioner is
   * unavailable, recluster directly from stored coordinates so the
   * cluster pins still reconcile.
   */
  #onViewportResize = (): void => {
    if (this.#pinPositioner) {
      this.#pinPositioner.flush();
    } else {
      this.#recomputeClusters();
    }
  };

  #clearClusters(): void {
    for (const [, el] of this.#clusterEls) {
      el.remove();
    }
    this.#clusterEls.clear();
    this.#clusteredAnnotationIds.clear();
  }

  /**
   * Apply the `data-fallback="true"` warning attribute when the
   * annotation carries `targetStale: true` (Req 44.6 / task 36.7).
   * Mirrors the same attribute `PinPositioner` writes when the
   * resolved target is null, so the existing
   * `:host([data-fallback="true"])` rule on `<fl-annotation-pin>`
   * picks up the warning ring without any new CSS. Once set we leave
   * the flag in place: a subsequent rAF tick from `PinPositioner`
   * would otherwise clear it the moment some other element happened
   * to be at the stored coordinates.
   */
  #applyTargetStaleFlag(
    pin: FlAnnotationPinElement,
    annotation: Annotation,
  ): void {
    if (annotation.targetStale === true) {
      pin.dataset.fallback = 'true';
    }
  }

  /**
   * Resolve a stored DOMTarget to a live element via DOMTargetResolver.
   * Wrapped in a try/catch because in jsdom the host page may not have
   * the elements the selector matches; we fall through to `null` and let
   * the positioner mark the pin as `data-fallback="true"`.
   */
  #resolveTarget(annotation: Annotation): Element | null {
    try {
      return DOMTargetResolver.resolveSelector(annotation.target);
    } catch {
      return null;
    }
  }

  #clearPins(): void {
    for (const [, pin] of this.#pinEls) {
      pin.remove();
    }
    this.#pinEls.clear();
  }

  #disposePinPositioner(): void {
    if (this.#pinPositioner) {
      this.#pinPositioner.dispose();
      this.#pinPositioner = null;
    }
  }

  /**
   * Wire up a `PinPositionerOptOutStorage` from the runtime
   * `chrome.storage.sync` surface (Req 51.3 / task 43.2). Returns
   * `undefined` outside the extension runtime (e.g., jsdom tests) so
   * `PinPositioner` falls back to its eager-start legacy behavior.
   */
  #resolvePinPositionerOptOutStorage(): PinPositionerOptOutStorage | undefined {
    if (typeof chrome === 'undefined') return undefined;
    const sync = chrome.storage?.sync;
    if (!sync || typeof sync.get !== 'function') return undefined;
    const onChangedApi = chrome.storage?.onChanged;
    return {
      get: (keys) =>
        sync.get(
          keys as string | string[] | Record<string, unknown> | null,
        ) as Promise<Record<string, unknown>>,
      onChanged: onChangedApi
        ? {
            addListener: (cb) => onChangedApi.addListener(cb),
            removeListener: (cb) => onChangedApi.removeListener(cb),
          }
        : undefined,
      areaName: 'sync',
    };
  }

  #disposeHoverOutline(): void {
    if (this.#hoverOutline) {
      this.#hoverOutline.dispose();
      this.#hoverOutline = null;
    }
  }

  /**
   * Resolve the page-level shadow host element so the hover outline can
   * recognise the overlay's own surfaces and skip them (Req 37.1, task
   * 28.1's "Skip elements inside the overlay's own shadow tree"). When the
   * `<fl-overlay-host>` is itself appended directly into a Shadow Root,
   * `getRootNode()` returns that root and `.host` is the wrapper element
   * the content script created. In tests where the host is mounted into
   * `document.body`, `getRootNode()` returns the document and we fall back
   * to the host element itself; either way the outline filters out
   * `[data-pinpoint]` descendants defensively.
   */
  #findOverlayShadowHost(): Element | null {
    const root = this.getRootNode();
    if (root instanceof ShadowRoot) {
      return root.host;
    }
    return this;
  }

  /* -------------------------------------------------------------------- */
  /* Child events                                                         */
  /* -------------------------------------------------------------------- */

  #wireChildEventHandlers(): void {
    this.#sidebar.addEventListener('annotation-select', this.#onAnnotationSelect);
    this.#sidebar.addEventListener('close', this.#onOverlayClose);
    this.#popover.addEventListener('submit', this.#onPopoverSubmit);
    this.#popover.addEventListener('cancel', this.#onPopoverCancel);
    this.#popover.addEventListener('close', this.#onPopoverClose);
    this.#popover.addEventListener('status-change', this.#onPopoverStatusChange);
    this.#popover.addEventListener('comment-submit', this.#onPopoverCommentSubmit);
    this.#clusterList.addEventListener('annotation-select', this.#onClusterListSelect);
    this.#clusterList.addEventListener('close', this.#onClusterListClose);
    this.#toolbar.addEventListener('close', this.#onOverlayClose);
    this.#pinLayer.addEventListener('pin-click', this.#onPinClick);
    this.#pinLayer.addEventListener('cluster-click', this.#onClusterClick);
    this.#picker.addEventListener('select', this.#onPickerSelect);
  }

  #unwireChildEventHandlers(): void {
    this.#sidebar.removeEventListener('annotation-select', this.#onAnnotationSelect);
    this.#sidebar.removeEventListener('close', this.#onOverlayClose);
    this.#popover.removeEventListener('submit', this.#onPopoverSubmit);
    this.#popover.removeEventListener('cancel', this.#onPopoverCancel);
    this.#popover.removeEventListener('close', this.#onPopoverClose);
    this.#popover.removeEventListener('status-change', this.#onPopoverStatusChange);
    this.#popover.removeEventListener('comment-submit', this.#onPopoverCommentSubmit);
    this.#clusterList.removeEventListener('annotation-select', this.#onClusterListSelect);
    this.#clusterList.removeEventListener('close', this.#onClusterListClose);
    this.#toolbar.removeEventListener('close', this.#onOverlayClose);
    this.#pinLayer.removeEventListener('pin-click', this.#onPinClick);
    this.#pinLayer.removeEventListener('cluster-click', this.#onClusterClick);
    this.#picker.removeEventListener('select', this.#onPickerSelect);
  }

  #onAnnotationSelect = (event: Event): void => {
    const detail = (event as CustomEvent<AnnotationSelectEventDetail>).detail;
    if (!detail) return;
    this.#selectAnnotation(detail.annotationId);
  };

  #onPinClick = (event: Event): void => {
    const detail = (event as CustomEvent<{ annotationId: string }>).detail;
    if (!detail) return;
    this.#selectAnnotation(detail.annotationId);
  };

  /**
   * `cluster-click` from `<fl-cluster-pin>` (task 44.3, Req 52.2). The
   * cluster pin emits a list of contained annotation ids; we look them
   * up in the store, anchor `<fl-cluster-list-popover>` at the cluster
   * pin's bounding rect (in page coordinates), and hand the entries to
   * the popover for rendering. The popover takes care of showing the
   * picker; the host listens for `annotation-select` from it to drill
   * into the regular `<fl-popover>` for the chosen annotation.
   *
   * The event is dispatched on the pin layer with `composed: true`, so
   * `event.target` is `.fl-pin-layer` and we walk `composedPath()` to
   * find the originating `<fl-cluster-pin>` element. That element's
   * `getBoundingClientRect()` gives us the on-screen position; we
   * convert to page coordinates by adding `window.scrollX/Y` so the
   * popover's anchor stays correct after the page is scrolled before
   * the click.
   */
  #onClusterClick = (event: Event): void => {
    const detail = (event as CustomEvent<{ pinIds: string[] }>).detail;
    if (!detail) return;
    const path = (event as CustomEvent).composedPath?.() ?? [];
    let originator: Element | null = null;
    for (const node of path) {
      if (
        node instanceof Element &&
        node.tagName.toLowerCase() === 'fl-cluster-pin'
      ) {
        originator = node;
        break;
      }
    }
    const rect = originator?.getBoundingClientRect();
    const annotations = this.#store.annotations.get();
    const contained = detail.pinIds
      .map((id) => annotations.find((a) => a.id === id))
      .filter((a): a is Annotation => Boolean(a));
    this.#clusterList.annotations = contained;
    if (rect) {
      this.#clusterList.target = popoverTargetFromRect({
        left: rect.left,
        top: rect.top,
      });
    } else {
      // Fall back to the document origin so the popover still renders;
      // happens in jsdom where `getBoundingClientRect` returns zeros and
      // the cluster pin is not positioned. Tests assert behavior, not
      // pixel-perfect anchoring.
      this.#clusterList.target = { pageX: 0, pageY: 0 };
    }
  };

  /**
   * `annotation-select` from `<fl-cluster-list-popover>` (task 44.3, Req
   * 52.2). The user picked one annotation from the cluster bucket. We
   * close the cluster list popover and open the regular `<fl-popover>`
   * for the chosen annotation by reusing the same store mutation
   * `<fl-sidebar-panel>` already triggers.
   */
  #onClusterListSelect = (event: Event): void => {
    const detail = (event as CustomEvent<AnnotationSelectEventDetail>).detail;
    if (!detail) return;
    // Close the cluster list before opening the regular popover so the
    // two surfaces never overlap on screen.
    this.#clusterList.target = null;
    this.#selectAnnotation(detail.annotationId);
  };

  /**
   * `close` from `<fl-cluster-list-popover>`. The popover already
   * closed itself (Escape, click-outside, or a programmatic `.close()`);
   * we drop our reference to the contained annotations so a later open
   * does not re-render stale data.
   */
  #onClusterListClose = (): void => {
    this.#clusterList.annotations = [];
  };

  #selectAnnotation(annotationId: string): void {
    const found = this.#store.annotations.get().find((a) => a.id === annotationId);
    if (!found) return;
    this.#store.selectedAnnotationId.set(annotationId);
    this.#store.popoverTarget.set({
      pageX: found.target.pageX,
      pageY: found.target.pageY,
      domTarget: found.target,
    });
  }

  #onPopoverSubmit = (event: Event): void => {
    const detail = (event as CustomEvent<PopoverSubmitDetail>).detail;
    if (!detail) return;
    // Fill in the project id the popover doesn't know about, then
    // dispatch as a host-action for the content script to persist.
    const annotation: Annotation = {
      ...detail.annotation,
      projectId: this.#projectId ?? detail.annotation.projectId,
    };
    this.#dispatchHostAction({ kind: 'create-annotation', annotation });
    // Optimistically push into the local store so the pin and sidebar
    // reflect the new annotation immediately. The server's
    // `annotation:created` broadcast will reconcile.
    this.#store.annotations.set([...this.#store.annotations.get(), annotation]);
    this.#store.popoverTarget.set(null);
  };

  #onPopoverCancel = (): void => {
    this.#store.popoverTarget.set(null);
    this.#store.selectedAnnotationId.set(null);
  };

  #onPopoverClose = (): void => {
    const previous = this.#store.selectedAnnotationId.get();
    this.#store.selectedAnnotationId.set(null);
    this.#store.popoverTarget.set(null);
    if (previous && this.#socket) {
      try {
        this.#socket.emit('annotation:close', { id: previous });
      } catch {
        /* best-effort */
      }
    }
  };

  #onPopoverStatusChange = (event: Event): void => {
    const detail = (event as CustomEvent<PopoverStatusChangeDetail>).detail;
    if (!detail) return;
    // Optimistic update so the sidebar / popover both reflect the change.
    const annotations = this.#store.annotations.get().map((a) =>
      a.id === detail.annotationId ? { ...a, status: detail.status } : a,
    );
    this.#store.annotations.set(annotations);
    this.#dispatchHostAction({
      kind: 'change-status',
      annotationId: detail.annotationId,
      status: detail.status,
    });
  };

  #onPopoverCommentSubmit = (event: Event): void => {
    const detail = (event as CustomEvent<PopoverCommentSubmitDetail>).detail;
    if (!detail) return;
    this.#dispatchHostAction({
      kind: 'create-comment',
      annotationId: detail.annotationId,
      body: detail.body,
      mentions: detail.mentions,
    });
  };

  #onOverlayClose = (): void => {
    this.#dispatchHostAction({ kind: 'overlay-close' });
  };

  /**
   * Forward `<fl-project-picker>`'s `select` event as a `host-action`
   * so the content script can swap the active Project (Req 38.2 / 39.2,
   * task 29.4). The picker has already persisted the URL→Project
   * mapping to `chrome.storage.local` before this fires; the host
   * leaves the actual `setProjectId` call to the content script (which
   * also reseeds annotations + members and joins the new room).
   */
  #onPickerSelect = (event: Event): void => {
    const detail = (event as CustomEvent<ProjectPickerSelectEventDetail>).detail;
    if (!detail || typeof detail.projectId !== 'string' || detail.projectId.length === 0) {
      return;
    }
    this.#dispatchHostAction({ kind: 'picker-select', projectId: detail.projectId });
  };

  #dispatchHostAction(detail: OverlayHostAction): void {
    this.dispatchEvent(
      new CustomEvent<OverlayHostAction>('host-action', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  /* -------------------------------------------------------------------- */
  /* Sub-frame click relay listener (task 40.3, Req 48.2 / 48.3)          */
  /* -------------------------------------------------------------------- */

  /**
   * Listen for `pinpoint:subframe-click` messages dispatched by
   * sub-frame relays (`extension/src/content/subFrameRelay.ts`, task
   * 40.2) and open the popover anchored at the relayed coordinates.
   *
   * Defense-in-depth (task 40.4 / Requirement 48.3): every incoming
   * message is checked against `window.location.origin`. Even though
   * the sender already gates on same-origin, we re-validate here so a
   * compromised or misbehaving sub-frame from another origin cannot
   * drive the top-frame popover. Cross-origin events are silently
   * dropped — the cross-origin frame contributes nothing to the
   * overlay.
   *
   * The relayed `{ x, y, w, h }` rect already accounts for the iframe's
   * offset within the top frame (the relay adds `frameElement`'s
   * bounding rect for same-origin parents). We translate that viewport
   * rect into a `PopoverTarget` in page coordinates by adding the top
   * frame's current scroll offset and anchoring at the rect's centre,
   * then assign it to `popoverTarget` so the popover opens at the
   * relayed location.
   */
  #installSubFrameRelayListener(): void {
    if (this.#subFrameMessageListener) return;
    if (typeof window === 'undefined') return;

    const expectedOrigin = (() => {
      try {
        return window.location.origin;
      } catch {
        return null;
      }
    })();

    const listener = (event: MessageEvent): void => {
      // 40.4 / 48.3: drop messages from origins other than our own.
      // Some test environments (jsdom) populate `event.origin` as ''
      // for synthetic `MessageEvent`s; treat that as same-origin only
      // when the sender is the top window itself (i.e. `event.source`
      // matches `window`) so we never accidentally accept a forged
      // event from a different origin.
      if (expectedOrigin !== null) {
        const origin = event.origin;
        if (origin && origin !== expectedOrigin) return;
        if (!origin && event.source !== null && event.source !== window) {
          return;
        }
      }

      const data = event.data as SubFrameClickMessage | null | undefined;
      if (!data || typeof data !== 'object') return;
      if (data.type !== SUBFRAME_CLICK_MESSAGE_TYPE) return;

      const rect = data.rect;
      if (
        !rect ||
        typeof rect.x !== 'number' ||
        typeof rect.y !== 'number' ||
        typeof rect.w !== 'number' ||
        typeof rect.h !== 'number'
      ) {
        return;
      }

      // Translate the relayed viewport rect into a page-coordinate
      // `PopoverTarget`. The relay rect is in the top frame's viewport
      // (sender already added the iframe's offset); we add the current
      // scroll offset and anchor at the rect's centre so the popover
      // points at the click target rather than its top-left corner.
      const scrollX = typeof window.scrollX === 'number' ? window.scrollX : 0;
      const scrollY = typeof window.scrollY === 'number' ? window.scrollY : 0;
      const target: PopoverTarget = {
        pageX: rect.x + rect.w / 2 + scrollX,
        pageY: rect.y + rect.h / 2 + scrollY,
      };

      this.#store.popoverTarget.set(target);
    };

    this.#subFrameMessageListener = listener;
    window.addEventListener('message', listener);
  }

  #uninstallSubFrameRelayListener(): void {
    if (!this.#subFrameMessageListener) return;
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.#subFrameMessageListener);
    }
    this.#subFrameMessageListener = null;
  }

  /* -------------------------------------------------------------------- */
  /* Socket                                                               */
  /* -------------------------------------------------------------------- */

  /**
   * Mount the Socket.IO client when both `projectId` and `token` are set.
   * The default factory lazy-imports `socket.io-client`; tests inject a
   * fake via `setSocketFactory`.
   */
  #maybeMountSocket(): void {
    if (!this.isConnected) return;
    if (this.#socket) return; // already connected
    if (!this.#projectId || !this.#token) return;

    const factory = this.#socketFactory ?? this.#defaultSocketFactory;
    const socket = factory({
      projectId: this.#projectId,
      token: this.#token,
      serverUrl: this.#serverUrl,
    });
    if (!socket) return;
    this.#socket = socket;
    this.#wireSocketEvents(socket);
  }

  /**
   * Default socket factory — uses `socket.io-client`. Wrapped in a function
   * so it can be replaced in tests via `setSocketFactory`.
   */
  #defaultSocketFactory: OverlaySocketFactory = ({ projectId, token, serverUrl }) => {
    try {
      const socket = io(`${serverUrl}/collab`, {
        auth: { token, projectId },
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        transports: ['websocket', 'polling'],
      });
      return socket as unknown as OverlaySocket;
    } catch {
      return null;
    }
  };

  #wireSocketEvents(socket: OverlaySocket): void {
    const projectId = this.#projectId;

    socket.on('connect', () => {
      if (projectId && this.#token) {
        try {
          socket.emit('join', { projectId, token: this.#token });
        } catch {
          /* best-effort */
        }
      }
      this.#store.reconnecting.set(false);
      // If the user had an annotation open before disconnect, re-emit
      // `annotation:open` so the server's presence map re-includes us
      // (design.md §5 "on reconnect the client re-emits annotation:open
      // for whichever annotation it has open").
      const selected = this.#store.selectedAnnotationId.get();
      if (selected) {
        try {
          socket.emit('annotation:open', { id: selected });
        } catch {
          /* best-effort */
        }
      }
    });

    socket.on('disconnect', () => {
      this.#store.reconnecting.set(true);
    });

    socket.on('reconnect_attempt', () => {
      this.#store.reconnecting.set(true);
    });

    socket.on('annotation:created', (...args: unknown[]) => {
      const data = args[0] as Annotation | undefined;
      if (!data) return;
      const current = this.#store.annotations.get();
      if (current.some((a) => a.id === data.id)) {
        // Server replay of an annotation we already optimistically inserted.
        this.#store.annotations.set(
          current.map((a) => (a.id === data.id ? data : a)),
        );
      } else {
        this.#store.annotations.set([...current, data]);
      }
    });

    socket.on('annotation:updated', (...args: unknown[]) => {
      const data = args[0] as Annotation | undefined;
      if (!data) return;
      this.#store.annotations.set(
        this.#store.annotations.get().map((a) => (a.id === data.id ? data : a)),
      );
    });

    socket.on('annotation:status', (...args: unknown[]) => {
      const data = args[0] as { id?: string; status?: AnnotationStatus } | undefined;
      if (!data || !data.id || !data.status) return;
      this.#store.annotations.set(
        this.#store.annotations.get().map((a) =>
          a.id === data.id ? { ...a, status: data.status as AnnotationStatus } : a,
        ),
      );
    });

    socket.on('comment:created', (...args: unknown[]) => {
      const data = args[0] as FLComment | undefined;
      if (!data) return;
      const current = this.#store.comments.get();
      if (current.some((c) => c.id === data.id)) return;
      this.#store.comments.set([...current, data]);
    });

    socket.on('annotation:viewers', (...args: unknown[]) => {
      const data = args[0] as { id?: string; userIds?: string[] } | undefined;
      if (!data || !data.id || !Array.isArray(data.userIds)) return;
      const next = { ...this.#store.viewersByAnnotation.get() };
      next[data.id] = [...data.userIds];
      this.#store.viewersByAnnotation.set(next);
    });

    socket.on('presence:update', (...args: unknown[]) => {
      // Presence is currently observed via `viewersByAnnotation`. Subsequent
      // tasks (14.2 / 14.3) attach UI; keep the listener so a future
      // subscriber is wired immediately when this lands.
      void args;
    });
  }

  #teardownSocket(): void {
    if (!this.#socket) return;
    try {
      this.#socket.disconnect();
    } catch {
      /* swallow — disconnect must never throw on teardown */
    }
    this.#socket = null;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get(FlOverlayHost.tagName)) {
  // Req 50.1 / task 42.1: wrap lifecycle callbacks so failures during
  // mount / unmount surface as inline `<fl-error-tag>` indicators
  // instead of bubbling out and breaking the host page. Wrapped on the
  // prototype BEFORE `define()` because the custom-elements spec
  // caches lifecycle callbacks on the registered definition by reading
  // the class prototype at definition time — a constructor-time own-
  // property override is never observed by the engine.
  withBoundary(FlOverlayHost.prototype, 'connectedCallback');
  withBoundary(FlOverlayHost.prototype, 'disconnectedCallback');
  customElements.define(FlOverlayHost.tagName, FlOverlayHost);
}

declare global {
  interface HTMLElementTagNameMap {
    'fl-overlay-host': FlOverlayHost;
  }
  interface HTMLElementEventMap {
    'host-action': CustomEvent<OverlayHostAction>;
  }
}

export default FlOverlayHost;
