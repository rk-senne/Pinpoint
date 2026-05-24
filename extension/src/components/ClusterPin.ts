/**
 * `<fl-cluster-pin>` — Web Component for a clustered annotation pin.
 *
 * Rendered by `OverlayHost` (task 44.3) for every `PinClusterer` bucket that
 * holds two or more annotation pins (Requirement 52.1, design §38, §"Pin
 * Clustering"). A cluster pin is a circular badge stamped with the contained
 * annotation count; its background color follows the highest severity in the
 * cluster, sourced from the shared `--fl-severity-*` CSS Custom Properties so
 * the palette matches `<fl-annotation-pin>` exactly.
 *
 * Position is owned exclusively by the parent (the eventual `OverlayHost`
 * tick that pairs `PinPositioner` and `PinClusterer`) — the parent writes
 * `transform: translate3d(x, y, 0)` onto the host element, mirroring how
 * `PinPositioner` already drives `<fl-annotation-pin>`. This element does
 * not position itself.
 *
 * Public API
 * ----------
 *   - `count` (number, ≥ 0)        — rendered inside the badge
 *   - `pinIds` (string[])          — ids of the contained annotations,
 *                                    accepted via property setter or via the
 *                                    `pin-ids` attribute as a comma-separated
 *                                    string (so the element can be hydrated
 *                                    purely from HTML).
 *   - `severity` (Severity | null) — the highest severity in the bucket;
 *                                    drives the background color via
 *                                    `data-severity` → `--fl-severity-*`.
 *
 * Reflection
 * ----------
 * `count` and `severity` are reflected to `data-count` and `data-severity`
 * host attributes so CSS rules in the shared stylesheet (and inside this
 * element's per-instance `<style>`) can target them without JavaScript.
 *
 * Events
 * ------
 * Emits `cluster-click` (bubbles, composed) on host click with
 * `detail: { pinIds }`. `e.stopPropagation()` is called first so the click
 * does not reach the page underneath as a "place a new annotation here"
 * gesture (mirrors `<fl-annotation-pin>`).
 *
 * Note: this task (44.2) only delivers the visual element. Wiring into
 * `PinClusterer` happens in tasks 44.3 (list popover) and 44.4 (re-cluster
 * on zoom / layout change).
 *
 * Implements: Requirement 52.1.
 */
import type { Severity } from '@pinpoint/shared';
import { adoptStyles } from '../styles/sharedStyleSheet';
import { withBoundary } from '../lib/withBoundary';

/**
 * Per-element styles. `:host` carries layout, geometry, and the
 * `data-severity` → background-color mapping that consumes the shared
 * `--fl-severity-*` CSS Custom Properties (no severity hex codes are inlined
 * in this file — the palette comes from `@pinpoint/shared/theme`).
 *
 * Sized slightly larger than `<fl-annotation-pin>` (32 px vs 28 px) so a
 * cluster reads as visually distinct from a single pin even when the count
 * is a single digit, and bordered with a thin white ring to keep the count
 * legible against any severity color.
 */
const CLUSTER_ELEMENT_CSS = `
:host {
  position: absolute;
  top: 0;
  left: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  border: 2px solid #fff;
  will-change: transform;
  z-index: 2147483646;
  user-select: none;
  background-color: var(--fl-severity-informational);
}
:host([data-severity="critical"])      { background-color: var(--fl-severity-critical); }
:host([data-severity="major"])         { background-color: var(--fl-severity-major); }
:host([data-severity="minor"])         { background-color: var(--fl-severity-minor); }
:host([data-severity="informational"]) { background-color: var(--fl-severity-informational); }
.cluster-count {
  pointer-events: none;
  display: inline-block;
  line-height: 1;
}
`;

const CLUSTER_TEMPLATE = document.createElement('template');
CLUSTER_TEMPLATE.innerHTML = `<style>${CLUSTER_ELEMENT_CSS}</style><span class="cluster-count" part="count"></span>`;

/**
 * Parse the comma-separated `pin-ids` attribute into a clean string[].
 * Trims whitespace and drops empty segments so `"a, b, "` → `['a', 'b']`.
 */
function parsePinIdsAttribute(value: string | null): string[] {
  if (value === null) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>([
  'critical',
  'major',
  'minor',
  'informational',
]);

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && VALID_SEVERITIES.has(value as Severity);
}

export class ClusterPin extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['pin-ids'];
  }

  #count = 0;
  #pinIds: readonly string[] = [];
  #severity: Severity | null = null;
  #countEl: HTMLSpanElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    root.appendChild(CLUSTER_TEMPLATE.content.cloneNode(true));

    const countEl = root.querySelector<HTMLSpanElement>('.cluster-count');
    if (!countEl) {
      throw new Error('ClusterPin: template missing .cluster-count span');
    }
    this.#countEl = countEl;

    // `addEventListener` is not an attribute mutation, so it is permitted
    // in the constructor per the Custom Elements spec (and jsdom's
    // strict enforcement). Attribute setup happens in `connectedCallback`.
    this.addEventListener('click', this.#handleClick);
    this.addEventListener('keydown', this.#handleKeyDown);
  }

  connectedCallback(): void {
    if (!this.hasAttribute('role')) {
      this.setAttribute('role', 'button');
    }
    if (!this.hasAttribute('data-pinpoint')) {
      this.setAttribute('data-pinpoint', 'cluster-pin');
    }
    // Make the cluster pin keyboard-focusable so screen-reader and
    // keyboard-only users can open the contained-annotations list popover
    // (task 44.3, Req 52.2). Defaults to `0` so it joins the natural tab
    // order; consumers can override by setting `tabindex` explicitly
    // before insertion.
    if (!this.hasAttribute('tabindex')) {
      this.setAttribute('tabindex', '0');
    }
    // Re-stamp reflected state in case property setters ran before the
    // element was connected (e.g. created via `document.createElement`
    // and configured before `appendChild`).
    this.#renderCount();
    this.#renderSeverity();
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (name === 'pin-ids') {
      // Only update from the attribute when the in-memory state is empty
      // (initial hydration). Subsequent property setters take precedence
      // and own the reflected attribute themselves.
      const parsed = parsePinIdsAttribute(newValue);
      if (this.#pinIds.length === 0) {
        this.#pinIds = parsed;
      }
    }
  }

  /** Number of annotations represented by this cluster (≥ 0). */
  get count(): number {
    return this.#count;
  }

  set count(value: number) {
    if (!Number.isFinite(value) || value < 0) {
      // Keep the element resilient to bad inputs by clamping to 0; the
      // PinClusterer never produces negative counts so this is just a
      // defensive guard against direct property writes.
      this.#count = 0;
    } else {
      this.#count = Math.floor(value);
    }
    this.#renderCount();
  }

  /**
   * Ids of the contained annotations. Accepts an array (preferred) or a
   * comma-separated string for symmetry with the `pin-ids` HTML attribute.
   * Always returns a defensive copy so callers cannot mutate internal state.
   */
  get pinIds(): string[] {
    return [...this.#pinIds];
  }

  set pinIds(value: readonly string[] | string | null | undefined) {
    if (value == null) {
      this.#pinIds = [];
    } else if (typeof value === 'string') {
      this.#pinIds = parsePinIdsAttribute(value);
    } else {
      // Filter to non-empty strings so a stray empty id never sneaks into
      // the cluster-click event payload.
      this.#pinIds = value.filter((s) => typeof s === 'string' && s.length > 0);
    }
    // Reflect to the attribute so HTML inspection / CSS attribute selectors
    // can see the current state. Skip the round-trip via
    // `attributeChangedCallback` by checking the existing attribute first.
    const serialized = this.#pinIds.join(',');
    if (this.getAttribute('pin-ids') !== serialized) {
      if (serialized.length === 0) {
        this.removeAttribute('pin-ids');
      } else {
        this.setAttribute('pin-ids', serialized);
      }
    }
  }

  /**
   * The highest severity among the contained annotations. Drives the
   * background color via `:host([data-severity=…])` rules that resolve
   * `--fl-severity-${severity}`. Setting `null` clears the attribute and
   * the element falls back to `--fl-severity-informational`.
   */
  get severity(): Severity | null {
    return this.#severity;
  }

  set severity(value: Severity | null | undefined) {
    if (value == null) {
      this.#severity = null;
    } else if (isSeverity(value)) {
      this.#severity = value;
    } else {
      // Ignore invalid severities rather than throwing — the calling site
      // (PinClusterer + OverlayHost) controls the input shape, but we
      // prefer to render the default color over crashing the overlay.
      this.#severity = null;
    }
    this.#renderSeverity();
  }

  #renderCount(): void {
    this.#countEl.textContent = String(this.#count);
    // Reflect to a host attribute so CSS rules (e.g., font-size tweaks for
    // very large counts) can target the host without JavaScript.
    this.dataset.count = String(this.#count);
    this.setAttribute('aria-label', `Cluster of ${this.#count} annotations`);
    this.title = `${this.#count} annotations`;
  }

  #renderSeverity(): void {
    if (this.#severity) {
      this.dataset.severity = this.#severity;
    } else {
      delete this.dataset.severity;
    }
  }

  /**
   * Click handler — emits a `cluster-click` CustomEvent carrying the
   * contained pin ids so any ancestor listener (the eventual list popover
   * in task 44.3, including a listener outside the Shadow DOM) can react.
   *
   * `bubbles: true` + `composed: true` lets the event escape the Shadow
   * Root the way native UI events do (per design §35 "CSP-Strict
   * Resilience"). `e.stopPropagation()` prevents the click from being
   * interpreted by the page underneath as a "place new annotation here"
   * gesture, mirroring `<fl-annotation-pin>`.
   */
  #handleClick = (e: MouseEvent): void => {
    e.stopPropagation();
    this.#dispatchClusterClick();
  };

  /**
   * Keyboard handler — task 44.3 (Req 52.2): when the cluster pin has
   * keyboard focus, `Enter` or `Space` opens the cluster list popover.
   * Same payload as the click event so the host can use one
   * `cluster-click` listener regardless of input modality.
   * `preventDefault()` on `Space` keeps the page from scrolling, and
   * `stopPropagation()` keeps the activation from reaching the page as a
   * generic `keydown`.
   */
  #handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    e.stopPropagation();
    this.#dispatchClusterClick();
  };

  #dispatchClusterClick(): void {
    this.dispatchEvent(
      new CustomEvent<{ pinIds: string[] }>('cluster-click', {
        detail: { pinIds: [...this.#pinIds] },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

/**
 * Register exactly once. Guarded so a hot module reload, a duplicate import,
 * or a test re-import does not throw "this name has already been used".
 */
if (
  typeof customElements !== 'undefined' &&
  !customElements.get('fl-cluster-pin')
) {
  withBoundary(ClusterPin.prototype, 'connectedCallback');
  customElements.define('fl-cluster-pin', ClusterPin);
}

declare global {
  interface HTMLElementTagNameMap {
    'fl-cluster-pin': ClusterPin;
  }
  interface HTMLElementEventMap {
    'cluster-click': CustomEvent<{ pinIds: string[] }>;
  }
}
