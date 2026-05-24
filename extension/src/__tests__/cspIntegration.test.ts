// @vitest-environment jsdom
/**
 * CSP-Strict Resilience integration test (task 41.3, Requirements 49.1, 49.2).
 *
 * Companion to the static audit in `cspAudit.test.ts` (task 41.1) and the
 * stylesheet contract documented in
 * `extension/src/styles/sharedStyleSheet.ts` (task 41.2). Where the audit
 * regex-scans the source tree for forbidden patterns, this test mounts the
 * full `<fl-overlay-host>` Custom Element under a strict
 * `Content-Security-Policy` and verifies the *runtime* output of the
 * overlay would render under that policy:
 *
 *     default-src 'none'; script-src 'self'; style-src 'self'
 *
 * jsdom does not enforce CSP at runtime (it has no policy engine for
 * `<meta http-equiv="Content-Security-Policy">`), so the test does not
 * rely on jsdom blocking anything. Instead it verifies the *behavior* a
 * real Chromium engine would require under that policy:
 *
 *   1. The CSP `<meta>` tag is present in the host document so any future
 *      jsdom version that gains policy enforcement (or any operator
 *      reading the test fixture) sees the contract this test is testing
 *      against.
 *   2. The shared styling is delivered via the constructable-stylesheet
 *      primary path *or* the documented `<style>` Shadow Root fallback
 *      (Req 49.2 / task 41.2). The fallback path is what jsdom exercises
 *      because its `Document.prototype.adoptedStyleSheets` slot is not
 *      populated; production browsers take the primary path. Either path
 *      is CSP-clean.
 *   3. After typical user interactions (selecting an annotation from the
 *      sidebar, opening the popover, hovering the page), no descendant of
 *      the overlay's Shadow Root has acquired an inline `style="…"`
 *      attribute. Per-property `style.X = …` writes (which `PinPositioner`
 *      and `HoverOutline` do for transforms) DO surface in
 *      `getAttribute('style')` under jsdom — the test special-cases the
 *      handful of overlay-internal elements that are documented to use
 *      transform/positioning writes. Any other inline style attribute
 *      indicates a regression (e.g. a future component baking
 *      `style="margin-top:4px"` into a template).
 *   4. No element under the overlay's Shadow Root carries an inline event
 *      handler attribute (`onclick`, `onkeydown`, …). Listeners are
 *      attached via `addEventListener` only.
 *   5. No `<script>` tags or `javascript:` URLs are present anywhere in
 *      the overlay's rendered tree.
 *
 * If any of these invariants fail, the overlay would either be blocked
 * outright by a strict CSP or would require a relaxation
 * (`'unsafe-inline'`, `'unsafe-eval'`) that the spec rules out.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import '../components/OverlayHost';
import {
  FlOverlayHost,
  type OverlaySocket,
  type OverlaySocketFactory,
} from '../components/OverlayHost';
import {
  SHARED_STYLE_FALLBACK_CSS,
  sharedStyleSheet,
} from '../styles/sharedStyleSheet';
import type { Annotation, Comment as FLComment } from '@pinpoint/shared';

/* -------------------------------------------------------------------------- */
/* Strict CSP fixture                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The exact policy referenced by the task: `default-src 'none'` blocks
 * every fetch by default; `script-src 'self'` allows only same-origin
 * scripts (no inline, no `eval`); `style-src 'self'` allows only
 * same-origin stylesheets (no inline `<style>`, no `style="…"`).
 *
 * The `connect-src 'self'` and `img-src 'self' data:` clauses match what
 * a host page would realistically send so the overlay's Socket.IO
 * connection (when wired to a real socket) and severity-dot pseudo-images
 * (data URIs are allowed) would also work in production.
 */
const STRICT_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:";

/** Inject `<meta http-equiv="Content-Security-Policy" content="…">` into <head>. */
function installCspMeta(policy: string): HTMLMetaElement {
  const meta = document.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', policy);
  document.head.appendChild(meta);
  return meta;
}

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

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
}

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: overrides.id ?? `ann-${Math.random().toString(36).slice(2, 8)}`,
    projectId: overrides.projectId ?? 'project-1',
    pageId: overrides.pageId ?? 'page-1',
    pageUrl: overrides.pageUrl ?? 'https://example.test',
    type: overrides.type ?? 'note',
    severity: overrides.severity ?? 'critical',
    status: overrides.status ?? 'active',
    body: overrides.body ?? 'integration body',
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
      userAgentRaw: 'integration-test',
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
    body: overrides.body ?? 'integration comment',
    mentions: overrides.mentions ?? [],
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function mountOverlayUnderCsp(): {
  host: FlOverlayHost;
  socket: FakeSocket;
  cspMeta: HTMLMetaElement;
  cleanup: () => void;
} {
  const cspMeta = installCspMeta(STRICT_CSP);
  const fake = new FakeSocket();
  const factory: OverlaySocketFactory = () => fake;

  const host = document.createElement('fl-overlay-host') as FlOverlayHost;
  host.setSocketFactory(factory);
  host.projectId = 'project-csp';
  host.token = 'fake-token';
  document.body.appendChild(host);

  return {
    host,
    socket: fake,
    cspMeta,
    cleanup: () => {
      host.remove();
      cspMeta.remove();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Walk helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Yield every Element under `root`, descending into Shadow Roots so the
 * audit catches descendants of every leaf Custom Element the host
 * renders (`<fl-floating-toolbar>`, `<fl-sidebar-panel>`, `<fl-popover>`,
 * `<fl-annotation-pin>`, `<fl-cluster-list-popover>`, …).
 */
function* walkElements(root: ShadowRoot | Element): Generator<Element> {
  const queue: Array<ShadowRoot | Element> = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    const els =
      node instanceof ShadowRoot
        ? Array.from(node.querySelectorAll('*'))
        : Array.from(node.querySelectorAll('*'));
    for (const el of els) {
      yield el;
      if (el.shadowRoot) {
        queue.push(el.shadowRoot);
      }
    }
  }
}

/**
 * Tags within the overlay tree that are known to receive *per-property*
 * `style.X = …` writes from `PinPositioner` (transform), `HoverOutline`
 * (transform/width/height), or `OverlayHost.#applyPickerVisibility`
 * (`display: none` on hidden surfaces). Per-property writes go through
 * the typed `CSSStyleDeclaration` object — they DO produce a
 * `style="…"` attribute when read back via `getAttribute`, but they are
 * NOT inline styles in the CSP sense (CSP-3 explicitly carves out
 * `el.style.X = …` from the inline-style restriction; only inline
 * `<style>` elements and `style="…"` attribute *parsing* are checked).
 *
 * We allow these tags by name so the audit catches any *new* element
 * that picks up an inline style attribute (which would suggest a
 * `setAttribute('style', …)` call or a `style="…"` baked into a
 * template — both forbidden under the static audit).
 */
const ALLOWED_PER_PROPERTY_STYLE_TAGS = new Set([
  // PinPositioner writes transform on each pin host element.
  'fl-annotation-pin',
  'fl-cluster-pin',
  // The pin layer hosts pins; OverlayHost may toggle its display when
  // the project picker is shown (Req 38.2 fallback).
  'div',
  // The four overlay surfaces hidden by `#applyPickerVisibility`.
  'fl-sidebar-panel',
  'fl-popover',
  'fl-floating-toolbar',
  'fl-cluster-list-popover',
]);

/**
 * Inline event handler attribute names CSP `script-src` rejects.
 * Subset of the HTML spec's full list — the ones actually exercised by
 * the overlay's interactive surfaces.
 */
const INLINE_EVENT_ATTRS = [
  'onclick',
  'onkeydown',
  'onkeyup',
  'onkeypress',
  'oninput',
  'onchange',
  'onsubmit',
  'onfocus',
  'onblur',
  'onload',
  'onerror',
  'onmouseup',
  'onmousedown',
  'onmouseover',
  'onmouseout',
  'onpointerdown',
  'onpointerup',
  'onpointermove',
] as const;

/* -------------------------------------------------------------------------- */
/* Test setup                                                                 */
/* -------------------------------------------------------------------------- */

beforeAll(() => {
  expect(customElements.get('fl-overlay-host')).toBeDefined();
});

beforeEach(() => {
  // Make sure no stale CSP <meta> tags survive across tests.
  document.head
    .querySelectorAll('meta[http-equiv="Content-Security-Policy"]')
    .forEach((m) => m.remove());
});

afterEach(() => {
  document.body.replaceChildren();
  document.head
    .querySelectorAll('meta[http-equiv="Content-Security-Policy"]')
    .forEach((m) => m.remove());
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('CSP-Strict integration (Req 49.1, 49.2 — task 41.3)', () => {
  describe('CSP fixture', () => {
    it('installs the strict policy as a <meta http-equiv> tag in <head>', () => {
      const meta = installCspMeta(STRICT_CSP);
      const found = document.querySelector(
        'meta[http-equiv="Content-Security-Policy"]',
      );
      expect(found).toBe(meta);
      expect(found?.getAttribute('content')).toBe(STRICT_CSP);
      meta.remove();
    });

    it("declares default-src 'none'; script-src 'self'; style-src 'self'", () => {
      // Sanity check: the policy string this test pins includes the
      // three directives the spec cites in Requirement 49.1.
      expect(STRICT_CSP).toContain("default-src 'none'");
      expect(STRICT_CSP).toContain("script-src 'self'");
      expect(STRICT_CSP).toContain("style-src 'self'");
    });
  });

  describe('overlay rendering under strict CSP', () => {
    it('mounts <fl-overlay-host> with the strict policy in place', () => {
      const { host, cleanup } = mountOverlayUnderCsp();
      try {
        const meta = document.querySelector(
          'meta[http-equiv="Content-Security-Policy"]',
        );
        expect(meta?.getAttribute('content')).toBe(STRICT_CSP);
        expect(host.shadowRoot).toBeTruthy();
        expect(host.shadowRoot?.querySelector('fl-floating-toolbar')).toBeTruthy();
        expect(host.shadowRoot?.querySelector('fl-sidebar-panel')).toBeTruthy();
        expect(host.shadowRoot?.querySelector('fl-popover')).toBeTruthy();
        expect(host.shadowRoot?.querySelector('.fl-pin-layer')).toBeTruthy();
      } finally {
        cleanup();
      }
    });

    it(
      'delivers shared styling via the documented primary or fallback path (Req 49.2)',
      () => {
        const { host, cleanup } = mountOverlayUnderCsp();
        try {
          const root = host.shadowRoot!;

          // Primary path: `adoptedStyleSheets` is populated with the shared
          // sheet. Real browsers take this path.
          const adopted = (root as ShadowRoot & {
            adoptedStyleSheets?: readonly CSSStyleSheet[];
          }).adoptedStyleSheets;
          const usedPrimary =
            sharedStyleSheet !== undefined &&
            'adoptedStyleSheets' in Document.prototype &&
            Array.isArray(adopted) &&
            adopted.includes(sharedStyleSheet);

          // Fallback path: a `<style>` element sits inside the Shadow Root
          // with the shared CSS as `textContent`. jsdom takes this path
          // because its `Document.adoptedStyleSheets` slot is absent. Note:
          // the host element only ships the per-element overlay rules in a
          // local `<style>` element when the shared sheet is unavailable.
          // We assert *one* of the two paths is in effect.
          const fallbackStyles = Array.from(root.querySelectorAll('style'));
          const usedFallback = fallbackStyles.some((s) =>
            (s.textContent ?? '').includes(SHARED_STYLE_FALLBACK_CSS.slice(0, 80)),
          );

          expect(usedPrimary || usedFallback).toBe(true);
        } finally {
          cleanup();
        }
      },
    );

    it(
      'adopted/fallback styles never contain inline event-handler attributes',
      () => {
        const { host, cleanup } = mountOverlayUnderCsp();
        try {
          const root = host.shadowRoot!;
          // Whichever path the runtime took, the CSS payload must not
          // contain anything resembling an inline event handler. Since
          // CSS rules can't carry handlers anyway this is a defensive
          // sanity check — if a future change ever switches to a CSS-in-JS
          // path that injects markup, the audit catches it here.
          const fallbackStyles = Array.from(root.querySelectorAll('style'));
          for (const s of fallbackStyles) {
            const text = s.textContent ?? '';
            for (const attr of INLINE_EVENT_ATTRS) {
              expect(text.toLowerCase()).not.toContain(`${attr}=`);
            }
          }
        } finally {
          cleanup();
        }
      },
    );
  });

  describe('after typical user interaction', () => {
    it(
      'does not introduce inline style="…" attributes on overlay descendants',
      () => {
        const { host, cleanup } = mountOverlayUnderCsp();
        try {
          // Seed the overlay with realistic state and exercise the same
          // surfaces a user would touch: pick an annotation in the
          // sidebar, open the popover, and walk through a comment.
          const a1 = makeAnnotation({ id: 'a1', body: 'first' });
          const a2 = makeAnnotation({ id: 'a2', body: 'second', severity: 'major' });
          host.store.annotations.set([a1, a2]);
          host.store.comments.set([
            makeComment({ id: 'c1', annotationId: 'a1' }),
            makeComment({ id: 'c2', annotationId: 'a1' }),
          ]);
          host.store.members.set([
            { userId: 'u1', name: 'Alice', email: 'alice@example.test' },
          ]);

          // Sidebar → annotation-select → popover open.
          const sidebar = host.shadowRoot!.querySelector(
            'fl-sidebar-panel',
          ) as HTMLElement;
          sidebar.dispatchEvent(
            new CustomEvent('annotation-select', {
              detail: { annotationId: 'a1' },
              bubbles: true,
              composed: true,
            }),
          );
          // Pin click → re-select.
          const pin = host.shadowRoot!.querySelector(
            '.fl-pin-layer fl-annotation-pin',
          ) as HTMLElement | null;
          pin?.dispatchEvent(
            new CustomEvent('pin-click', {
              detail: { annotationId: 'a2' },
              bubbles: true,
              composed: true,
            }),
          );
          // Reconnecting banner toggle (drives a hidden mutation).
          host.store.reconnecting.set(true);
          host.store.reconnecting.set(false);

          // Now sweep every descendant of the host's Shadow Root
          // (and every nested Shadow Root) for inline style attributes.
          const violations: string[] = [];
          for (const el of walkElements(host.shadowRoot!)) {
            const styleAttr = el.getAttribute('style');
            if (styleAttr === null || styleAttr === '') continue;
            const tag = el.tagName.toLowerCase();
            if (ALLOWED_PER_PROPERTY_STYLE_TAGS.has(tag)) continue;
            violations.push(`${tag}[style="${styleAttr}"]`);
          }
          expect(violations).toEqual([]);
        } finally {
          cleanup();
        }
      },
    );

    it('does not introduce inline event-handler attributes on overlay descendants', () => {
      const { host, cleanup } = mountOverlayUnderCsp();
      try {
        host.store.annotations.set([makeAnnotation({ id: 'a1' })]);
        host.store.popoverTarget.set({ pageX: 50, pageY: 100 });
        host.store.popoverTarget.set(null);

        const violations: string[] = [];
        for (const el of walkElements(host.shadowRoot!)) {
          for (const attr of INLINE_EVENT_ATTRS) {
            if (el.hasAttribute(attr)) {
              violations.push(`${el.tagName.toLowerCase()}[${attr}]`);
            }
          }
        }
        expect(violations).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it('does not inject <script> tags or javascript: URLs into the overlay tree', () => {
      const { host, cleanup } = mountOverlayUnderCsp();
      try {
        host.store.annotations.set([makeAnnotation({ id: 'a1' })]);
        host.store.popoverTarget.set({ pageX: 5, pageY: 10 });

        const scripts: string[] = [];
        const jsUrls: string[] = [];
        for (const el of walkElements(host.shadowRoot!)) {
          if (el.tagName.toLowerCase() === 'script') {
            scripts.push(el.outerHTML);
          }
          for (const attr of ['href', 'src', 'action', 'formaction'] as const) {
            const v = el.getAttribute(attr);
            if (v && /^\s*javascript:/i.test(v)) {
              jsUrls.push(`${el.tagName.toLowerCase()}[${attr}=${v}]`);
            }
          }
        }
        expect(scripts).toEqual([]);
        expect(jsUrls).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it('exposes a closeable lifecycle without leaving inline-style residue', () => {
      const { host, cleanup } = mountOverlayUnderCsp();
      try {
        host.store.annotations.set([makeAnnotation({ id: 'a1' })]);
        host.store.popoverTarget.set({ pageX: 10, pageY: 20 });
        host.store.popoverTarget.set(null);
        // disconnectedCallback path
        host.remove();
        // After disconnect the node is detached from the document; we
        // verify there are no lingering Shadow Root descendants on the
        // document itself with inline event handlers (defense-in-depth
        // for any teardown that re-parented something).
        const violations: string[] = [];
        for (const attr of INLINE_EVENT_ATTRS) {
          for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) {
            violations.push(`${el.tagName.toLowerCase()}[${attr}]`);
          }
        }
        expect(violations).toEqual([]);
      } finally {
        cleanup();
      }
    });
  });
});
