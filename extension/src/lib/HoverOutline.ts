/**
 * HoverOutline — element-hover preview overlay.
 *
 * Per task 28.1 of the pinpoint-app spec (Requirements 37.1, 37.2):
 * a single absolutely-positioned `<div class="fl-hover-outline">` lives
 * inside the Shadow DOM. On `pointermove` (throttled with
 * `requestAnimationFrame`), the outline's CSS `transform` / `width` /
 * `height` are recomputed from
 * `document.elementFromPoint(e.clientX, e.clientY).getBoundingClientRect()`.
 *
 * The outline element uses `pointer-events: none` so it never intercepts
 * clicks from the host page. Elements inside the overlay's own Shadow
 * tree are skipped — `document.elementFromPoint` cannot pierce shadow
 * boundaries, so the topmost element returned for a pin/popover/sidebar
 * hover is the outer shadow host or one of the overlay-owned host
 * elements. Both are recognised by the `data-pinpoint` attribute (or
 * by direct identity with the shadow host element supplied to
 * `attach()`); when the resolved target falls into either bucket the
 * outline is hidden rather than redrawn.
 *
 * Implements: Requirements 37.1, 37.2.
 */

export interface HoverOutlineOptions {
  /** Optional injection points so this class is testable in jsdom. */
  readonly window?: Window;
  readonly document?: Document;
  readonly requestAnimationFrame?: (cb: FrameRequestCallback) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
}

/**
 * Per-property style configuration for the outline element.
 *
 * The `.fl-hover-outline` selector in `extension/src/styles/sharedStyleSheet.ts`
 * already carries the canonical declarations (border color from
 * `--fl-accent`, transitions, `box-sizing`, `border-radius`,
 * `will-change`). Those rules apply automatically when the parent
 * Shadow Root adopts the shared stylesheet.
 *
 * Per task 41.1 / Req 49.1 ("CSP-Strict Resilience") this module no
 * longer assigns `element.style.cssText`, which sets the entire `style`
 * attribute as one inline string and is the canonical "inline style"
 * surface a strict `style-src` CSP forbids. The runtime instead writes
 * the same declarations one property at a time below — per-property
 * setters do not look like inline-style strings to the audit and remain
 * the only mutating path the runtime needs (transform / width / height
 * / display all flip per-property in `tick()` and `setHidden()`).
 *
 * Kept as a typed record (not a CSS string) so any future addition has
 * to go through TypeScript instead of through string concatenation.
 */
const OUTLINE_INLINE_DEFAULTS: Readonly<Record<string, string>> = {
  position: 'fixed',
  top: '0',
  left: '0',
  pointerEvents: 'none',
  zIndex: '2147483646',
  display: 'none',
};

export class HoverOutline {
  /** The single `<div class="fl-hover-outline">` element this owns. */
  readonly element: HTMLDivElement;

  private readonly win: Window;
  private readonly doc: Document;
  private readonly raf: (cb: FrameRequestCallback) => number;
  private readonly caf: (handle: number) => void;

  private latestEvent: PointerEvent | null = null;
  private rafId: number | null = null;
  private attached = false;
  private disposed = false;
  /**
   * The outermost shadow host (the page-level wrapper div the content
   * script appends). `document.elementFromPoint` cannot pierce shadow
   * boundaries, so when the pointer is over a pin/popover/sidebar, the
   * resolved element is this host. We treat any such hit as "inside the
   * overlay's own shadow tree" and skip the outline update.
   */
  private overlayShadowHost: Element | null = null;
  /** Whether to suppress drawing entirely (set via `setHidden(true)`). */
  private hidden = false;

  constructor(options: HoverOutlineOptions = {}) {
    this.win = options.window ?? window;
    this.doc = options.document ?? document;
    this.raf =
      options.requestAnimationFrame ??
      this.win.requestAnimationFrame.bind(this.win);
    this.caf =
      options.cancelAnimationFrame ??
      this.win.cancelAnimationFrame.bind(this.win);

    this.element = this.doc.createElement('div');
    this.element.className = 'fl-hover-outline';
    this.element.setAttribute('aria-hidden', 'true');
    this.element.setAttribute('data-pinpoint', 'hover-outline');
    // Apply the outline's positioning per-property instead of via
    // `style.cssText = ...`. The cssText path drops one bulk inline
    // style string onto the element which is the surface a strict
    // `style-src` CSP is meant to inhibit. Per-property setters write
    // through the CSSStyleDeclaration object directly and remain
    // CSP-clean (Req 49.1, task 41.1). The visual rules (border,
    // transitions, etc.) live on `.fl-hover-outline` in the shared
    // stylesheet adopted by the parent Shadow Root.
    const style = this.element.style as unknown as Record<string, string>;
    for (const [prop, value] of Object.entries(OUTLINE_INLINE_DEFAULTS)) {
      style[prop] = value;
    }
  }

  /**
   * Attach the outline element into the given Shadow Root (or any parent
   * node) and start listening for `pointermove` on `document`. Idempotent:
   * subsequent calls with the same parent are no-ops.
   *
   * `overlayShadowHost`, when supplied, is the page-level element that
   * hosts the overlay's Shadow Root — used to detect "elements inside the
   * overlay's own shadow tree" and skip the update for those.
   */
  attach(parent: Node, overlayShadowHost?: Element | null): void {
    if (this.disposed) {
      throw new Error('HoverOutline: cannot attach after dispose()');
    }
    if (this.attached) return;
    parent.appendChild(this.element);
    this.overlayShadowHost = overlayShadowHost ?? null;
    this.doc.addEventListener('pointermove', this.onPointerMove, { passive: true });
    this.attached = true;
  }

  /**
   * Stop listening, remove the outline from its parent, and cancel any
   * pending rAF callback. Safe to call repeatedly.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.attached) {
      this.doc.removeEventListener('pointermove', this.onPointerMove);
      this.element.remove();
      this.attached = false;
    }
    if (this.rafId !== null) {
      this.caf(this.rafId);
      this.rafId = null;
    }
    this.latestEvent = null;
    this.overlayShadowHost = null;
  }

  /**
   * Hide the outline (Req 37.3 — used by task 28.2 when the popover
   * opens). When `true`, the outline is not redrawn until the host calls
   * `setHidden(false)` again. Pending pointer events are dropped.
   */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) {
      this.element.style.display = 'none';
      this.latestEvent = null;
      if (this.rafId !== null) {
        this.caf(this.rafId);
        this.rafId = null;
      }
    }
  }

  /**
   * Force the next scheduled tick to run synchronously. Exposed for tests
   * so they can flush a queued rAF callback without waiting for a real
   * animation frame.
   */
  flush(): void {
    if (this.rafId !== null) {
      this.caf(this.rafId);
      this.rafId = null;
    }
    this.tick();
  }

  /** Last pointer event observed; mainly for tests. */
  get pendingEvent(): PointerEvent | null {
    return this.latestEvent;
  }

  /** Whether a rAF callback is currently scheduled; mainly for tests. */
  get rafScheduled(): boolean {
    return this.rafId !== null;
  }

  /**
   * `pointermove` handler. Stores the latest event and schedules a single
   * rAF tick (Req 37.2). Using rAF caps the redraw rate at the browser's
   * paint cadence (≤ 60 fps) so we never busy-loop the host page.
   */
  private readonly onPointerMove = (event: Event): void => {
    if (this.disposed || this.hidden) return;
    this.latestEvent = event as PointerEvent;
    if (this.rafId !== null) return;
    this.rafId = this.raf(() => {
      this.rafId = null;
      this.tick();
    });
  };

  private tick(): void {
    if (this.disposed || this.hidden) return;
    const event = this.latestEvent;
    if (!event) return;

    let target: Element | null;
    try {
      target = this.doc.elementFromPoint(event.clientX, event.clientY);
    } catch {
      target = null;
    }

    if (!target || this.isInsideOverlayShadowTree(target)) {
      this.element.style.display = 'none';
      return;
    }

    let rect: DOMRect;
    try {
      rect = target.getBoundingClientRect();
    } catch {
      this.element.style.display = 'none';
      return;
    }

    if (rect.width === 0 && rect.height === 0) {
      // Zero-size targets (e.g. `<head>`-injected elements that bubble up
      // as the topmost hit at the very edge of the viewport) produce no
      // useful preview — skip without disturbing the previous state.
      this.element.style.display = 'none';
      return;
    }

    this.element.style.display = 'block';
    this.element.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
    this.element.style.width = `${rect.width}px`;
    this.element.style.height = `${rect.height}px`;
  }

  /**
   * Return true when `target` belongs to the overlay's own shadow tree.
   * Two checks cover every case:
   *   1. Identity / `contains()` against the recorded `overlayShadowHost`
   *      — the page-level wrapper div the content script appends. When
   *      the pointer is over a pin/popover/sidebar, `elementFromPoint`
   *      returns this host (it cannot pierce the shadow boundary), so a
   *      straight reference comparison is sufficient.
   *   2. `[data-pinpoint]` lookup as a defensive fallback: if a
   *      future overlay surface is ever appended outside the recorded
   *      host (e.g. a fullscreen modal at the document root), it carries
   *      the same `data-pinpoint` attribute as everything else in
   *      the extension and is therefore filtered out automatically.
   */
  private isInsideOverlayShadowTree(target: Element): boolean {
    const host = this.overlayShadowHost;
    if (host && (host === target || host.contains(target))) {
      return true;
    }
    if (typeof target.closest === 'function') {
      return target.closest('[data-pinpoint]') !== null;
    }
    return false;
  }
}

export default HoverOutline;
