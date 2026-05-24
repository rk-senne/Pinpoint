// @vitest-environment jsdom
/**
 * Unit tests for `<fl-overlay-host>`.
 *
 * Validates Requirements 31.2, 31.3:
 *   - HTMLElement subclass with an open Shadow Root that hosts the four
 *     leaf Custom Elements (`<fl-floating-toolbar>`, `<fl-sidebar-panel>`,
 *     `<fl-popover>`, plus a `.fl-pin-layer` for `<fl-annotation-pin>`s).
 *   - Owns the overlay store as `signal<T>()` slices for `annotations`,
 *     `comments`, `selectedAnnotationId`, `popoverTarget`, `members`,
 *     `reconnecting`, `viewersByAnnotation`.
 *   - Subscribes children via property assignment so a store mutation
 *     propagates to the matching child (`sidebar.annotations`,
 *     `popover.comments`, etc.).
 *   - Listens for child events (`pin-click`, `submit`, `cancel`, `close`,
 *     `comment-submit`, `status-change`, `annotation-select`) and updates
 *     the store + emits `host-action` events for the content script.
 *   - Mounts a Socket.IO-shaped client; `annotation:created`,
 *     `annotation:updated`, `annotation:status`, `comment:created`,
 *     `annotation:viewers`, and disconnect/reconnect events update the
 *     store.
 *   - `disconnectedCallback` disposes the PinPositioner, disconnects the
 *     socket, and unsubscribes signal listeners.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import './OverlayHost';
import {
  FlOverlayHost,
  createOverlayStore,
  type OverlayHostAction,
  type OverlaySocket,
  type OverlaySocketFactory,
} from './OverlayHost';
import type {
  Annotation,
  AnnotationStatus,
  Comment as FLComment,
} from '@pinpoint/shared';

/* -------------------------------------------------------------------------- */
/* Test helpers                                                               */
/* -------------------------------------------------------------------------- */

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: overrides.id ?? `ann-${Math.random().toString(36).slice(2, 8)}`,
    projectId: overrides.projectId ?? 'project-1',
    pageId: overrides.pageId ?? 'page-1',
    pageUrl: overrides.pageUrl ?? 'https://example.test',
    type: overrides.type ?? 'note',
    severity: overrides.severity ?? 'critical',
    status: overrides.status ?? 'active',
    body: overrides.body ?? 'hello',
    authorId: overrides.authorId ?? 'user-1',
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2024-01-01T00:00:00Z',
    target: overrides.target ?? {
      cssSelector: 'body',
      xpath: '/html/body',
      pageX: 10,
      pageY: 20,
      tagName: 'BODY',
      textSnippet: '',
    },
    environment: overrides.environment ?? {
      browserFamily: 'Chrome',
      browserVersion: '120',
      osFamily: 'macOS',
      osVersion: '14',
      deviceType: 'desktop',
      userAgentRaw: 'test-ua',
    },
    pinNumber: overrides.pinNumber ?? 1,
    ...overrides,
  };
}

function makeComment(overrides: Partial<FLComment> = {}): FLComment {
  return {
    id: overrides.id ?? `c-${Math.random().toString(36).slice(2, 8)}`,
    annotationId: overrides.annotationId ?? 'ann-1',
    authorId: overrides.authorId ?? 'user-1',
    body: overrides.body ?? 'a comment',
    mentions: overrides.mentions ?? [],
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Test-only fake socket. Captures `emit`s and lets tests fire arbitrary
 * server events with `triggerEvent`.
 */
class FakeSocket implements OverlaySocket {
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly emits: Array<{ event: string; args: unknown[] }> = [];
  disconnected = false;

  on(event: string, handler: (...args: unknown[]) => void): unknown {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  off(event: string, handler?: (...args: unknown[]) => void): unknown {
    if (!handler) {
      this.handlers.delete(event);
      return this;
    }
    const list = this.handlers.get(event);
    if (!list) return this;
    this.handlers.set(
      event,
      list.filter((h) => h !== handler),
    );
    return this;
  }

  emit(event: string, ...args: unknown[]): unknown {
    this.emits.push({ event, args });
    return this;
  }

  disconnect(): unknown {
    this.disconnected = true;
    return this;
  }

  /** Fire a server-to-client event into all registered handlers. */
  triggerEvent(event: string, payload?: unknown): void {
    const list = this.handlers.get(event) ?? [];
    for (const h of list) h(payload);
  }
}

/**
 * Mount a host with a fake socket. Returns the host, the fake socket the
 * factory produced, and a teardown helper. `connectedCallback` runs as a
 * side effect of `appendChild`, so subscriptions and child wiring are
 * active by the time this returns.
 */
function mountHost(opts: {
  projectId?: string | null;
  token?: string | null;
  factory?: OverlaySocketFactory;
} = {}) {
  const fake = new FakeSocket();
  const factory: OverlaySocketFactory =
    opts.factory ??
    (() => fake);

  const host = document.createElement('fl-overlay-host') as FlOverlayHost;
  host.setSocketFactory(factory);
  host.projectId = opts.projectId ?? 'project-1';
  host.token = opts.token ?? 'fake-token';
  document.body.appendChild(host);

  return {
    host,
    socket: fake,
    cleanup: () => {
      host.remove();
    },
  };
}

beforeAll(() => {
  expect(customElements.get('fl-overlay-host')).toBeDefined();
});

afterEach(() => {
  document.body.replaceChildren();
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('<fl-overlay-host>', () => {
  describe('shape', () => {
    it('is a Custom Element subclass of HTMLElement with an open Shadow Root', () => {
      const host = document.createElement('fl-overlay-host') as FlOverlayHost;
      expect(host).toBeInstanceOf(HTMLElement);
      expect(host).toBeInstanceOf(FlOverlayHost);
      expect(host.shadowRoot).toBeTruthy();
      expect(host.shadowRoot?.mode).toBe('open');
    });

    it('renders the four leaf custom elements (toolbar, sidebar, popover, pin-layer) in its Shadow Root', () => {
      const { host, cleanup } = mountHost();
      const root = host.shadowRoot!;
      expect(root.querySelector('fl-floating-toolbar')).toBeTruthy();
      expect(root.querySelector('fl-sidebar-panel')).toBeTruthy();
      expect(root.querySelector('fl-popover')).toBeTruthy();
      expect(root.querySelector('.fl-pin-layer')).toBeTruthy();
      cleanup();
    });

    it('exposes a default overlay store with all seven signal slices', () => {
      const host = document.createElement('fl-overlay-host') as FlOverlayHost;
      const s = host.store;
      expect(s.annotations.get()).toEqual([]);
      expect(s.comments.get()).toEqual([]);
      expect(s.selectedAnnotationId.get()).toBeNull();
      expect(s.popoverTarget.get()).toBeNull();
      expect(s.members.get()).toEqual([]);
      expect(s.reconnecting.get()).toBe(false);
      expect(s.viewersByAnnotation.get()).toEqual({});
    });

    it('renders the single `<div class="fl-hover-outline">` inside the Shadow Root (Req 37.1, task 28.1)', () => {
      const { host, cleanup } = mountHost();
      const root = host.shadowRoot!;
      const outlines = root.querySelectorAll('.fl-hover-outline');
      expect(outlines).toHaveLength(1);
      const outline = outlines[0] as HTMLElement;
      // pointer-events: none is the contractual rule (Req 37.2) — the
      // outline must never intercept clicks from the host page.
      expect(outline.style.pointerEvents).toBe('none');
      expect(outline.getAttribute('data-pinpoint')).toBe('hover-outline');
      cleanup();
    });

    it('hides the hover outline when the popover opens and unsuppresses it on close (Req 37.3, task 28.2)', () => {
      const { host, cleanup } = mountHost();
      const outline = host.shadowRoot!.querySelector(
        '.fl-hover-outline',
      ) as HTMLElement;

      // Initial state — the outline is mounted and not forcibly hidden.
      // `HoverOutline` starts with display:none until a pointermove
      // resolves a target; what we care about here is that opening the
      // popover never leaves the outline visible.
      const initialDisplay = outline.style.display;
      expect(initialDisplay === '' || initialDisplay === 'none').toBe(true);

      // Open the popover — the outline must be hidden (Req 37.3).
      host.store.popoverTarget.set({ pageX: 100, pageY: 200 });
      expect(outline.style.display).toBe('none');

      // Close the popover — the host clears the suppression flag so the
      // outline can resume drawing on the next pointermove. The element's
      // `display` stays `none` until that next pointermove redraws it —
      // that's `HoverOutline`'s normal resume-on-pointermove contract,
      // verified in HoverOutline.test.ts. Re-opening the popover here
      // confirms the host still tracks the open/close transition.
      host.store.popoverTarget.set(null);
      expect(outline.style.display).toBe('none');

      host.store.popoverTarget.set({ pageX: 5, pageY: 6 });
      expect(outline.style.display).toBe('none');
      cleanup();
    });

    it('accepts a pre-seeded store via the constructor', () => {
      const store = createOverlayStore();
      store.annotations.set([makeAnnotation({ id: 'pre' })]);
      const host = new FlOverlayHost(store);
      document.body.appendChild(host);
      const sidebar = host.shadowRoot!.querySelector('fl-sidebar-panel') as HTMLElement & {
        annotations: readonly Annotation[];
      };
      expect(sidebar.annotations.length).toBe(1);
      expect(sidebar.annotations[0].id).toBe('pre');
      host.remove();
    });
  });

  describe('store → child wiring (signal-based reactivity)', () => {
    it('forwards annotations to <fl-sidebar-panel> when the signal changes', () => {
      const { host, cleanup } = mountHost();
      const sidebar = host.shadowRoot!.querySelector('fl-sidebar-panel') as HTMLElement & {
        annotations: readonly Annotation[];
      };

      host.store.annotations.set([
        makeAnnotation({ id: 'a1' }),
        makeAnnotation({ id: 'a2' }),
      ]);
      expect(sidebar.annotations.map((a) => a.id)).toEqual(['a1', 'a2']);

      host.store.annotations.set([makeAnnotation({ id: 'a3' })]);
      expect(sidebar.annotations.map((a) => a.id)).toEqual(['a3']);
      cleanup();
    });

    it('reconciles <fl-annotation-pin> elements against the annotations signal', () => {
      const { host, cleanup } = mountHost();
      const layer = host.shadowRoot!.querySelector('.fl-pin-layer') as HTMLElement;
      expect(layer.querySelectorAll('fl-annotation-pin').length).toBe(0);

      host.store.annotations.set([
        makeAnnotation({ id: 'a1' }),
        makeAnnotation({ id: 'a2' }),
      ]);
      expect(layer.querySelectorAll('fl-annotation-pin').length).toBe(2);

      // remove a1, keep a2, add a3 → final count 2 with a2/a3
      host.store.annotations.set([
        makeAnnotation({ id: 'a2' }),
        makeAnnotation({ id: 'a3' }),
      ]);
      const pins = Array.from(layer.querySelectorAll('fl-annotation-pin')) as HTMLElement[];
      expect(pins.length).toBe(2);
      const ids = pins.map((p) => (p as HTMLElement & { annotation: Annotation }).annotation?.id);
      expect(ids.sort()).toEqual(['a2', 'a3']);
      cleanup();
    });

    it('triggers a recluster on `window.resize` so pins that newly overlap collapse into a `<fl-cluster-pin>` (Req 52.3, task 44.4)', () => {
      const { host, cleanup } = mountHost();
      const layer = host.shadowRoot!.querySelector('.fl-pin-layer') as HTMLElement;

      // Two annotations placed in distinct buckets so the initial
      // recluster (which falls back to `target.pageX/pageY` because the
      // pins haven't had a rAF tick yet) leaves them as singletons.
      // 24-px default radius → bucket (0,0) and bucket (8,8).
      host.store.annotations.set([
        makeAnnotation({
          id: 'a1',
          target: {
            cssSelector: 'body',
            xpath: '/html/body',
            pageX: 5,
            pageY: 5,
            tagName: 'BODY',
            textSnippet: '',
          },
        }),
        makeAnnotation({
          id: 'a2',
          target: {
            cssSelector: 'body',
            xpath: '/html/body',
            pageX: 200,
            pageY: 200,
            tagName: 'BODY',
            textSnippet: '',
          },
        }),
      ]);
      expect(layer.querySelectorAll('fl-cluster-pin').length).toBe(0);

      // Dispatch a window resize. The host's resize handler asks the
      // positioner to flush, which (a) writes fresh transforms based on
      // each pin's resolved target — `body.getBoundingClientRect()` in
      // jsdom returns all zeros — and (b) fires the `onAfterTick` hook
      // that drives the clusterer. Both pins now share bucket (0,0) so
      // a single cluster pin renders with `count = 2`.
      window.dispatchEvent(new Event('resize'));

      const clusterPins = layer.querySelectorAll('fl-cluster-pin');
      expect(clusterPins.length).toBe(1);
      const cluster = clusterPins[0] as HTMLElement & {
        count: number;
        pinIds: string[];
      };
      expect(cluster.count).toBe(2);
      expect([...cluster.pinIds].sort()).toEqual(['a1', 'a2']);

      // The individual pins are hidden while clustered so the user
      // sees one badge instead of two overlapping pins.
      const pins = Array.from(layer.querySelectorAll('fl-annotation-pin')) as HTMLElement[];
      expect(pins.every((p) => p.hidden)).toBe(true);
      cleanup();
    });

    it('forwards comments to <fl-popover> when the signal changes', () => {
      const { host, cleanup } = mountHost();
      const popover = host.shadowRoot!.querySelector('fl-popover') as HTMLElement & {
        comments: readonly FLComment[];
      };

      host.store.comments.set([makeComment({ id: 'c1' }), makeComment({ id: 'c2' })]);
      expect(popover.comments.length).toBe(2);
      cleanup();
    });

    it('opens the popover when popoverTarget is set and closes it when null', () => {
      const { host, cleanup } = mountHost();
      const popover = host.shadowRoot!.querySelector('fl-popover') as HTMLElement & {
        target: { pageX: number; pageY: number } | null;
      };

      host.store.popoverTarget.set({ pageX: 100, pageY: 200 });
      expect(popover.target).toEqual(expect.objectContaining({ pageX: 100, pageY: 200 }));

      host.store.popoverTarget.set(null);
      expect(popover.target).toBeNull();
      cleanup();
    });

    it('shows/hides the reconnecting banner from the reconnecting signal', () => {
      const { host, cleanup } = mountHost();
      const banner = host.shadowRoot!.querySelector('.fl-reconnecting') as HTMLElement;
      expect(banner.hidden).toBe(true);

      host.store.reconnecting.set(true);
      expect(banner.hidden).toBe(false);

      host.store.reconnecting.set(false);
      expect(banner.hidden).toBe(true);
      cleanup();
    });

    it('forwards isOffline to both <fl-floating-toolbar> and <fl-popover> (Req 44.5 / task 36.6)', () => {
      const { host, cleanup } = mountHost();
      const toolbar = host.shadowRoot!.querySelector(
        'fl-floating-toolbar',
      ) as HTMLElement & { isOffline: boolean };
      const popover = host.shadowRoot!.querySelector(
        'fl-popover',
      ) as HTMLElement & { isOffline: boolean };

      expect(toolbar.isOffline).toBe(false);
      expect(popover.isOffline).toBe(false);

      host.store.isOffline.set(true);
      expect(toolbar.isOffline).toBe(true);
      expect(popover.isOffline).toBe(true);

      host.store.isOffline.set(false);
      expect(toolbar.isOffline).toBe(false);
      expect(popover.isOffline).toBe(false);
      cleanup();
    });

    it('forwards members to <fl-popover> via property assignment', () => {
      const { host, cleanup } = mountHost();
      const popover = host.shadowRoot!.querySelector('fl-popover') as HTMLElement & {
        members: ReadonlyArray<{ userId: string; name: string }>;
      };

      host.store.members.set([{ userId: 'u1', name: 'Alice', email: 'alice@example.test' }]);
      expect(popover.members.length).toBe(1);
      expect(popover.members[0].name).toBe('Alice');
      cleanup();
    });

    it('drives popover annotation from selectedAnnotationId', () => {
      const { host, cleanup } = mountHost();
      const popover = host.shadowRoot!.querySelector('fl-popover') as HTMLElement & {
        annotation: Annotation | null;
      };

      const a1 = makeAnnotation({ id: 'a1', body: 'first' });
      host.store.annotations.set([a1]);

      host.store.selectedAnnotationId.set('a1');
      expect(popover.annotation?.id).toBe('a1');

      host.store.selectedAnnotationId.set(null);
      expect(popover.annotation).toBeNull();
      cleanup();
    });
  });

  describe('child events → store + host-action', () => {
    it('selects an annotation when sidebar dispatches `annotation-select`', () => {
      const { host, cleanup } = mountHost();
      host.store.annotations.set([makeAnnotation({ id: 'a1' })]);

      const sidebar = host.shadowRoot!.querySelector('fl-sidebar-panel') as HTMLElement;
      sidebar.dispatchEvent(
        new CustomEvent('annotation-select', {
          detail: { annotationId: 'a1' },
          bubbles: true,
          composed: true,
        }),
      );

      expect(host.store.selectedAnnotationId.get()).toBe('a1');
      expect(host.store.popoverTarget.get()).not.toBeNull();
      cleanup();
    });

    it('emits a host-action `create-annotation` on popover submit and pushes optimistically', () => {
      const { host, cleanup } = mountHost({ projectId: 'project-XYZ' });

      const seen: OverlayHostAction[] = [];
      host.addEventListener('host-action', (e) => {
        seen.push((e as CustomEvent<OverlayHostAction>).detail);
      });

      const popover = host.shadowRoot!.querySelector('fl-popover') as HTMLElement;
      const annotation = makeAnnotation({ id: 'new', projectId: '' });
      popover.dispatchEvent(
        new CustomEvent('submit', {
          detail: { annotation },
          bubbles: true,
          composed: true,
        }),
      );

      expect(seen.length).toBe(1);
      const action = seen[0];
      expect(action.kind).toBe('create-annotation');
      if (action.kind === 'create-annotation') {
        expect(action.annotation.projectId).toBe('project-XYZ');
      }
      // Optimistic insert
      expect(host.store.annotations.get().some((a) => a.id === 'new')).toBe(true);
      cleanup();
    });

    it('emits a host-action `change-status` on popover status-change and updates the store optimistically', () => {
      const { host, cleanup } = mountHost();
      host.store.annotations.set([
        makeAnnotation({ id: 'a1', status: 'active' }),
      ]);

      const seen: OverlayHostAction[] = [];
      host.addEventListener('host-action', (e) => {
        seen.push((e as CustomEvent<OverlayHostAction>).detail);
      });

      const popover = host.shadowRoot!.querySelector('fl-popover') as HTMLElement;
      popover.dispatchEvent(
        new CustomEvent('status-change', {
          detail: { annotationId: 'a1', status: 'resolved' as AnnotationStatus },
          bubbles: true,
          composed: true,
        }),
      );

      expect(seen.length).toBe(1);
      expect(seen[0].kind).toBe('change-status');
      expect(host.store.annotations.get()[0].status).toBe('resolved');
      cleanup();
    });

    it('emits a host-action `create-comment` on popover comment-submit', () => {
      const { host, cleanup } = mountHost();
      const seen: OverlayHostAction[] = [];
      host.addEventListener('host-action', (e) => {
        seen.push((e as CustomEvent<OverlayHostAction>).detail);
      });

      const popover = host.shadowRoot!.querySelector('fl-popover') as HTMLElement;
      popover.dispatchEvent(
        new CustomEvent('comment-submit', {
          detail: { annotationId: 'a1', body: 'hi @bob', mentions: ['bob'] },
          bubbles: true,
          composed: true,
        }),
      );

      expect(seen.length).toBe(1);
      expect(seen[0].kind).toBe('create-comment');
      cleanup();
    });

    it('clears popoverTarget on popover cancel', () => {
      const { host, cleanup } = mountHost();
      host.store.popoverTarget.set({ pageX: 1, pageY: 2 });
      host.store.selectedAnnotationId.set('a1');

      const popover = host.shadowRoot!.querySelector('fl-popover') as HTMLElement;
      popover.dispatchEvent(new CustomEvent('cancel', { bubbles: true, composed: true }));

      expect(host.store.popoverTarget.get()).toBeNull();
      expect(host.store.selectedAnnotationId.get()).toBeNull();
      cleanup();
    });

    it('emits a host-action `overlay-close` when toolbar dispatches close', () => {
      const { host, cleanup } = mountHost();
      const seen: OverlayHostAction[] = [];
      host.addEventListener('host-action', (e) => {
        seen.push((e as CustomEvent<OverlayHostAction>).detail);
      });

      const toolbar = host.shadowRoot!.querySelector('fl-floating-toolbar') as HTMLElement;
      toolbar.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));

      expect(seen.length).toBe(1);
      expect(seen[0].kind).toBe('overlay-close');
      cleanup();
    });

    it('selects the annotation when a pin dispatches `pin-click`', () => {
      const { host, cleanup } = mountHost();
      host.store.annotations.set([makeAnnotation({ id: 'a1' })]);

      const pin = host.shadowRoot!.querySelector('.fl-pin-layer fl-annotation-pin') as HTMLElement;
      pin.dispatchEvent(
        new CustomEvent('pin-click', {
          detail: { annotationId: 'a1' },
          bubbles: true,
          composed: true,
        }),
      );

      expect(host.store.selectedAnnotationId.get()).toBe('a1');
      cleanup();
    });

    it('opens the cluster list popover with the contained annotations on `cluster-click` (task 44.3)', () => {
      const { host, cleanup } = mountHost();
      host.store.annotations.set([
        makeAnnotation({ id: 'a1', pinNumber: 1 }),
        makeAnnotation({ id: 'a2', pinNumber: 2 }),
        makeAnnotation({ id: 'a3', pinNumber: 3 }),
      ]);

      // Append a stand-in cluster pin into the pin layer so the host's
      // delegated `cluster-click` listener fires. The host inspects
      // `composedPath()` to find the originating `<fl-cluster-pin>`, so
      // we use the real Custom Element here.
      const cluster = document.createElement('fl-cluster-pin') as HTMLElement;
      const layer = host.shadowRoot!.querySelector('.fl-pin-layer') as HTMLElement;
      layer.appendChild(cluster);

      cluster.dispatchEvent(
        new CustomEvent('cluster-click', {
          detail: { pinIds: ['a1', 'a3'] },
          bubbles: true,
          composed: true,
        }),
      );

      const clusterList = host.shadowRoot!.querySelector(
        'fl-cluster-list-popover',
      ) as HTMLElement & {
        annotations: readonly Annotation[];
        target: { pageX: number; pageY: number } | null;
      };
      expect(clusterList.annotations.map((a) => a.id)).toEqual(['a1', 'a3']);
      expect(clusterList.target).not.toBeNull();
      cleanup();
    });

    it('drills into the regular popover and closes the cluster list on `annotation-select` from the cluster list (task 44.3)', () => {
      const { host, cleanup } = mountHost();
      host.store.annotations.set([
        makeAnnotation({ id: 'a1' }),
        makeAnnotation({ id: 'a2' }),
      ]);

      const clusterList = host.shadowRoot!.querySelector(
        'fl-cluster-list-popover',
      ) as HTMLElement & {
        annotations: readonly Annotation[];
        target: { pageX: number; pageY: number } | null;
      };
      // Simulate the host opening the cluster list (would normally be
      // triggered by a `cluster-click`).
      clusterList.annotations = host.store.annotations.get();
      clusterList.target = { pageX: 0, pageY: 0 };

      // Dispatch the picker's `annotation-select` event from the popover
      // host element, the same way the inner row click would.
      clusterList.dispatchEvent(
        new CustomEvent('annotation-select', {
          detail: { annotationId: 'a2' },
          bubbles: true,
          composed: true,
        }),
      );

      expect(host.store.selectedAnnotationId.get()).toBe('a2');
      // Cluster list popover is closed (target reset to null).
      expect(clusterList.target).toBeNull();
      cleanup();
    });
  });

  describe('socket events → store', () => {
    it('emits `join` on socket connect', () => {
      const { socket, cleanup } = mountHost();
      socket.triggerEvent('connect');
      expect(socket.emits.some((e) => e.event === 'join')).toBe(true);
      cleanup();
    });

    it('updates reconnecting on disconnect / connect', () => {
      const { host, socket, cleanup } = mountHost();
      socket.triggerEvent('disconnect');
      expect(host.store.reconnecting.get()).toBe(true);
      socket.triggerEvent('connect');
      expect(host.store.reconnecting.get()).toBe(false);
      cleanup();
    });

    it('appends an annotation on `annotation:created`', () => {
      const { host, socket, cleanup } = mountHost();
      const a = makeAnnotation({ id: 'srv-1' });
      socket.triggerEvent('annotation:created', a);
      expect(host.store.annotations.get().some((x) => x.id === 'srv-1')).toBe(true);
      cleanup();
    });

    it('replaces an annotation on `annotation:updated`', () => {
      const { host, socket, cleanup } = mountHost();
      host.store.annotations.set([makeAnnotation({ id: 'a1', body: 'old' })]);
      socket.triggerEvent('annotation:updated', makeAnnotation({ id: 'a1', body: 'new' }));
      expect(host.store.annotations.get()[0].body).toBe('new');
      cleanup();
    });

    it('updates status on `annotation:status`', () => {
      const { host, socket, cleanup } = mountHost();
      host.store.annotations.set([makeAnnotation({ id: 'a1', status: 'active' })]);
      socket.triggerEvent('annotation:status', { id: 'a1', status: 'resolved' });
      expect(host.store.annotations.get()[0].status).toBe('resolved');
      cleanup();
    });

    it('appends a comment on `comment:created` and dedupes duplicates', () => {
      const { host, socket, cleanup } = mountHost();
      const c = makeComment({ id: 'c1' });
      socket.triggerEvent('comment:created', c);
      socket.triggerEvent('comment:created', c);
      expect(host.store.comments.get().length).toBe(1);
      cleanup();
    });

    it('records co-viewers on `annotation:viewers`', () => {
      const { host, socket, cleanup } = mountHost();
      socket.triggerEvent('annotation:viewers', { id: 'a1', userIds: ['u1', 'u2'] });
      expect(host.store.viewersByAnnotation.get()).toEqual({ a1: ['u1', 'u2'] });

      socket.triggerEvent('annotation:viewers', { id: 'a2', userIds: ['u3'] });
      expect(host.store.viewersByAnnotation.get()).toEqual({
        a1: ['u1', 'u2'],
        a2: ['u3'],
      });
      cleanup();
    });

    it('emits `annotation:open` when an annotation is selected', () => {
      const { host, socket, cleanup } = mountHost();
      host.store.annotations.set([makeAnnotation({ id: 'a1' })]);
      host.store.selectedAnnotationId.set('a1');
      expect(socket.emits.some((e) => e.event === 'annotation:open')).toBe(true);
      cleanup();
    });
  });

  describe('lifecycle: disconnectedCallback teardown', () => {
    it('disconnects the socket on disconnectedCallback', () => {
      const { host, socket } = mountHost();
      host.remove();
      expect(socket.disconnected).toBe(true);
    });

    it('stops forwarding store changes to children after disconnect', () => {
      const { host, socket, cleanup } = mountHost();
      host.store.annotations.set([makeAnnotation({ id: 'a1' })]);
      const sidebar = host.shadowRoot!.querySelector('fl-sidebar-panel') as HTMLElement & {
        annotations: readonly Annotation[];
      };
      expect(sidebar.annotations.length).toBe(1);

      host.remove();
      // After disconnect, store changes must not throw and must not
      // mutate the now-detached sidebar element via stale subscribers.
      const before = sidebar.annotations.length;
      host.store.annotations.set([
        makeAnnotation({ id: 'a1' }),
        makeAnnotation({ id: 'a2' }),
      ]);
      expect(sidebar.annotations.length).toBe(before);

      cleanup();
    });

    it('disposes the PinPositioner on disconnectedCallback (idempotent dispose)', () => {
      // We cannot easily reach the private positioner, so we approximate by
      // ensuring re-removal does not throw and a fresh host can be remounted.
      const { host, cleanup } = mountHost();
      host.remove();
      expect(() => host.remove()).not.toThrow();
      cleanup();
    });
  });

  describe('factory injection', () => {
    it('skips socket mounting when projectId or token is missing', () => {
      const factory = vi.fn(() => new FakeSocket());
      const host = document.createElement('fl-overlay-host') as FlOverlayHost;
      host.setSocketFactory(factory);
      // No projectId / token assigned.
      document.body.appendChild(host);
      expect(factory).not.toHaveBeenCalled();
      host.remove();
    });

    it('mounts the socket once both projectId and token are set after connection', () => {
      const factory = vi.fn(() => new FakeSocket());
      const host = document.createElement('fl-overlay-host') as FlOverlayHost;
      host.setSocketFactory(factory);
      document.body.appendChild(host);

      host.projectId = 'project-1';
      expect(factory).not.toHaveBeenCalled();

      host.token = 'token';
      expect(factory).toHaveBeenCalledTimes(1);
      host.remove();
    });
  });

  /* ---------------------------------------------------------------- */
  /* setProjectId — task 29.3 / Requirement 38.1                       */
  /* ---------------------------------------------------------------- */

  describe('setProjectId — SPA project rebind (Req 38.1, task 29.3)', () => {
    it('emits `leave` for the previous projectId and `join` for the new one on the same socket', () => {
      const { host, socket, cleanup } = mountHost({ projectId: 'project-A' });
      // Drain any emits from the initial mount (e.g. join on connect was
      // not fired here — connect event has not been triggered — so the
      // emits array starts empty).
      socket.emits.length = 0;

      host.setProjectId('project-B');

      const leave = socket.emits.find((e) => e.event === 'leave');
      const join = socket.emits.find((e) => e.event === 'join');
      expect(leave).toBeDefined();
      expect(leave?.args[0]).toEqual({ projectId: 'project-A' });
      expect(join).toBeDefined();
      expect(join?.args[0]).toMatchObject({ projectId: 'project-B' });
      // The same socket instance is reused — `setProjectId` must not
      // disconnect/reconnect.
      expect(socket.disconnected).toBe(false);
      cleanup();
    });

    it('updates the host`s projectId and pageId fields', () => {
      const { host, cleanup } = mountHost({ projectId: 'project-A' });

      host.setProjectId('project-B', 'page-99');

      expect(host.projectId).toBe('project-B');
      expect(host.pageId).toBe('page-99');
      cleanup();
    });

    it('resets the annotations / comments / members / viewersByAnnotation signals', () => {
      const { host, cleanup } = mountHost({ projectId: 'project-A' });
      host.store.annotations.set([
        makeAnnotation({ id: 'a1' }),
        makeAnnotation({ id: 'a2' }),
      ]);
      host.store.comments.set([makeComment({ id: 'c1' })]);
      host.store.members.set([
        { userId: 'u1', name: 'Alice', email: 'alice@example.test' },
      ]);
      host.store.viewersByAnnotation.set({ a1: ['u1'] });

      host.setProjectId('project-B');

      expect(host.store.annotations.get()).toEqual([]);
      expect(host.store.comments.get()).toEqual([]);
      expect(host.store.members.get()).toEqual([]);
      expect(host.store.viewersByAnnotation.get()).toEqual({});
      cleanup();
    });

    it('clears selectedAnnotationId and popoverTarget on rebind', () => {
      const { host, cleanup } = mountHost({ projectId: 'project-A' });
      host.store.annotations.set([makeAnnotation({ id: 'a1' })]);
      host.store.selectedAnnotationId.set('a1');
      host.store.popoverTarget.set({ pageX: 10, pageY: 20 });

      host.setProjectId('project-B');

      expect(host.store.selectedAnnotationId.get()).toBeNull();
      expect(host.store.popoverTarget.get()).toBeNull();
      cleanup();
    });

    it('propagates the empty annotations to the sidebar so it shows the empty state', () => {
      const { host, cleanup } = mountHost({ projectId: 'project-A' });
      host.store.annotations.set([
        makeAnnotation({ id: 'a1' }),
        makeAnnotation({ id: 'a2' }),
      ]);
      const sidebar = host.shadowRoot!.querySelector('fl-sidebar-panel') as HTMLElement & {
        annotations: readonly Annotation[];
      };
      expect(sidebar.annotations.length).toBe(2);

      host.setProjectId('project-B');

      expect(sidebar.annotations.length).toBe(0);
      // Pin layer also reconciles to zero pins.
      const layer = host.shadowRoot!.querySelector('.fl-pin-layer') as HTMLElement;
      expect(layer.querySelectorAll('fl-annotation-pin').length).toBe(0);
      cleanup();
    });

    it('is a no-op (no leave / join, no store reset) when called with the same projectId', () => {
      const { host, socket, cleanup } = mountHost({ projectId: 'project-A' });
      host.store.annotations.set([makeAnnotation({ id: 'a1' })]);
      socket.emits.length = 0;

      host.setProjectId('project-A');

      expect(socket.emits.find((e) => e.event === 'leave')).toBeUndefined();
      expect(socket.emits.find((e) => e.event === 'join')).toBeUndefined();
      expect(host.store.annotations.get()).toHaveLength(1);
      cleanup();
    });

    it('clears the projectId without emitting `join` when called with null', () => {
      const { host, socket, cleanup } = mountHost({ projectId: 'project-A' });
      socket.emits.length = 0;

      host.setProjectId(null);

      expect(host.projectId).toBeNull();
      expect(socket.emits.find((e) => e.event === 'leave')?.args[0]).toEqual({
        projectId: 'project-A',
      });
      expect(socket.emits.find((e) => e.event === 'join')).toBeUndefined();
      cleanup();
    });

    it('mounts the socket via the factory when called before any socket exists', () => {
      const fake = new FakeSocket();
      const factory = vi.fn(() => fake);
      const host = document.createElement('fl-overlay-host') as FlOverlayHost;
      host.setSocketFactory(factory);
      host.token = 'fake-token';
      // Note: no projectId yet — socket is NOT mounted.
      document.body.appendChild(host);
      expect(factory).not.toHaveBeenCalled();

      // Cold-start path: setProjectId mounts the socket via the factory
      // (no leave to emit, no socket to join on yet).
      host.setProjectId('project-X');

      expect(factory).toHaveBeenCalledTimes(1);
      expect(host.projectId).toBe('project-X');
      host.remove();
    });
  });

  /* ---------------------------------------------------------------- */
  /* Project picker fallback — task 29.4 / Req 38.2                    */
  /* ---------------------------------------------------------------- */

  describe('project picker fallback (Req 38.2 / 39.1, task 29.4)', () => {
    it('renders an `<fl-project-picker>` inside a hidden wrapper by default', () => {
      const { host, cleanup } = mountHost();
      const root = host.shadowRoot!;
      const wrapper = root.querySelector('.fl-project-picker-fallback') as HTMLElement;
      const picker = root.querySelector('fl-project-picker');
      expect(wrapper).toBeTruthy();
      expect(picker).toBeTruthy();
      // Hidden by default — only the explicit fallback flow reveals it.
      expect(wrapper.hasAttribute('hidden')).toBe(true);
      expect(host.pickerVisible).toBe(false);
      cleanup();
    });

    it('showProjectPicker reveals the wrapper, forwards projects, and hides the rest of the overlay', () => {
      const { host, cleanup } = mountHost();
      const root = host.shadowRoot!;
      const wrapper = root.querySelector('.fl-project-picker-fallback') as HTMLElement;
      const picker = root.querySelector('fl-project-picker') as HTMLElement & {
        projects: ReadonlyArray<{ id: string; name: string; lastUsedAt: string }>;
      };
      const sidebar = root.querySelector('fl-sidebar-panel') as HTMLElement;
      const popover = root.querySelector('fl-popover') as HTMLElement;
      const toolbar = root.querySelector('fl-floating-toolbar') as HTMLElement;
      const layer = root.querySelector('.fl-pin-layer') as HTMLElement;

      host.showProjectPicker([
        { id: 'p1', name: 'Alpha', lastUsedAt: '2024-02-01T00:00:00Z' },
        { id: 'p2', name: 'Beta', lastUsedAt: '2024-01-01T00:00:00Z' },
      ]);

      expect(wrapper.hasAttribute('hidden')).toBe(false);
      expect(host.pickerVisible).toBe(true);
      expect(picker.projects.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
      // Other overlay surfaces are display-hidden so they cannot
      // intercept clicks while the picker is up.
      expect(sidebar.style.display).toBe('none');
      expect(popover.style.display).toBe('none');
      expect(toolbar.style.display).toBe('none');
      expect(layer.style.display).toBe('none');
      cleanup();
    });

    it('hideProjectPicker restores the rest of the overlay', () => {
      const { host, cleanup } = mountHost();
      const root = host.shadowRoot!;
      const wrapper = root.querySelector('.fl-project-picker-fallback') as HTMLElement;
      const sidebar = root.querySelector('fl-sidebar-panel') as HTMLElement;
      const popover = root.querySelector('fl-popover') as HTMLElement;
      const toolbar = root.querySelector('fl-floating-toolbar') as HTMLElement;
      const layer = root.querySelector('.fl-pin-layer') as HTMLElement;

      host.showProjectPicker([
        { id: 'p1', name: 'Alpha', lastUsedAt: '2024-01-01T00:00:00Z' },
      ]);
      host.hideProjectPicker();

      expect(wrapper.hasAttribute('hidden')).toBe(true);
      expect(host.pickerVisible).toBe(false);
      expect(sidebar.style.display).toBe('');
      expect(popover.style.display).toBe('');
      expect(toolbar.style.display).toBe('');
      expect(layer.style.display).toBe('');
      cleanup();
    });

    it('emits a `picker-select` host-action when the picker dispatches `select`', () => {
      const { host, cleanup } = mountHost();
      const seen: OverlayHostAction[] = [];
      host.addEventListener('host-action', (e) => {
        seen.push((e as CustomEvent<OverlayHostAction>).detail);
      });

      host.showProjectPicker([
        { id: 'p1', name: 'Alpha', lastUsedAt: '2024-01-01T00:00:00Z' },
      ]);

      const picker = host.shadowRoot!.querySelector('fl-project-picker') as HTMLElement;
      picker.dispatchEvent(
        new CustomEvent('select', {
          detail: { projectId: 'p1' },
          bubbles: true,
          composed: true,
        }),
      );

      expect(seen.length).toBe(1);
      expect(seen[0]).toEqual({ kind: 'picker-select', projectId: 'p1' });
      cleanup();
    });

    it('ignores picker `select` events with no detail or empty projectId', () => {
      const { host, cleanup } = mountHost();
      const seen: OverlayHostAction[] = [];
      host.addEventListener('host-action', (e) => {
        seen.push((e as CustomEvent<OverlayHostAction>).detail);
      });

      const picker = host.shadowRoot!.querySelector('fl-project-picker') as HTMLElement;
      picker.dispatchEvent(
        new CustomEvent('select', { bubbles: true, composed: true }),
      );
      picker.dispatchEvent(
        new CustomEvent('select', {
          detail: { projectId: '' },
          bubbles: true,
          composed: true,
        }),
      );

      expect(seen.length).toBe(0);
      cleanup();
    });

    it('refreshes the picker rows when showProjectPicker is called again', () => {
      const { host, cleanup } = mountHost();
      const picker = host.shadowRoot!.querySelector('fl-project-picker') as HTMLElement & {
        projects: ReadonlyArray<{ id: string; name: string; lastUsedAt: string }>;
      };

      host.showProjectPicker([
        { id: 'p1', name: 'Alpha', lastUsedAt: '2024-01-01T00:00:00Z' },
      ]);
      expect(picker.projects.map((p) => p.id)).toEqual(['p1']);

      host.showProjectPicker([
        { id: 'p2', name: 'Beta', lastUsedAt: '2024-02-01T00:00:00Z' },
        { id: 'p3', name: 'Gamma', lastUsedAt: '2024-03-01T00:00:00Z' },
      ]);
      expect(picker.projects.map((p) => p.id).sort()).toEqual(['p2', 'p3']);
      // Still visible after re-assignment.
      expect(host.pickerVisible).toBe(true);
      cleanup();
    });
  });

  /* ---------------------------------------------------------------- */
  /* Sub-frame click relay listener — task 40.3 / 40.4 / Req 48.2 / 48.3 */
  /* ---------------------------------------------------------------- */

  describe('sub-frame click relay listener (task 40.3 / 40.4)', () => {
    it('opens the popover at the relayed coordinates when a same-origin `pinpoint:subframe-click` MessageEvent is dispatched (40.3)', () => {
      const { host, cleanup } = mountHost();
      // Ensure no popover is open yet.
      expect(host.store.popoverTarget.get()).toBeNull();

      // Synthesize the message the sub-frame relay would post. The
      // relay rect is in the top frame's viewport (sender already
      // added the iframe's offset for same-origin parents).
      const event = new MessageEvent('message', {
        data: {
          type: 'pinpoint:subframe-click',
          rect: { x: 100, y: 200, w: 40, h: 30 },
        },
        origin: window.location.origin,
        source: window,
      });
      window.dispatchEvent(event);

      const target = host.store.popoverTarget.get();
      expect(target).not.toBeNull();
      // The host anchors at the rect's centre and adds the current
      // scroll offset (zero in jsdom by default).
      expect(target).toEqual(
        expect.objectContaining({
          pageX: 100 + 40 / 2 + (window.scrollX ?? 0),
          pageY: 200 + 30 / 2 + (window.scrollY ?? 0),
        }),
      );
      cleanup();
    });

    it('drops `pinpoint:subframe-click` MessageEvents from a different origin (40.4 — defense in depth)', () => {
      const { host, cleanup } = mountHost();
      expect(host.store.popoverTarget.get()).toBeNull();

      const event = new MessageEvent('message', {
        data: {
          type: 'pinpoint:subframe-click',
          rect: { x: 100, y: 200, w: 40, h: 30 },
        },
        origin: 'https://evil.example',
        source: null,
      });
      window.dispatchEvent(event);

      // Cross-origin event must not open the popover.
      expect(host.store.popoverTarget.get()).toBeNull();
      cleanup();
    });

    it('ignores MessageEvents that are not the sub-frame relay envelope', () => {
      const { host, cleanup } = mountHost();

      // Wrong type
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'something-else', rect: { x: 1, y: 2, w: 3, h: 4 } },
          origin: window.location.origin,
        }),
      );
      // Missing rect
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'pinpoint:subframe-click' },
          origin: window.location.origin,
        }),
      );
      // Non-numeric rect fields
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'pinpoint:subframe-click',
            rect: { x: 'a', y: 'b', w: 'c', h: 'd' },
          },
          origin: window.location.origin,
        }),
      );
      // Plain string payload
      window.dispatchEvent(
        new MessageEvent('message', {
          data: 'hello',
          origin: window.location.origin,
        }),
      );

      expect(host.store.popoverTarget.get()).toBeNull();
      cleanup();
    });

    it('removes the message listener on disconnectedCallback so post-detach events are ignored', () => {
      const { host, cleanup } = mountHost();
      cleanup();

      // Now that the host is detached, a same-origin relay event must
      // not mutate the (still-reachable) store.
      const before = host.store.popoverTarget.get();
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'pinpoint:subframe-click',
            rect: { x: 1, y: 2, w: 3, h: 4 },
          },
          origin: window.location.origin,
          source: window,
        }),
      );
      expect(host.store.popoverTarget.get()).toBe(before);
    });
  });
});
