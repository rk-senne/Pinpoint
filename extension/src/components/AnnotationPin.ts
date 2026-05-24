/**
 * `<fl-annotation-pin>` — Web Component implementation of an annotation pin.
 *
 * Renders the pin number, picks its background color from the shared
 * `SEVERITY_COLORS` palette via the `--fl-severity-*` CSS Custom Properties
 * emitted by `themeCss()`, and emits a `pin-click` `CustomEvent` (bubbling +
 * composed) when activated.
 *
 * Position is owned exclusively by `PinPositioner` (Req 14.5): the positioner
 * writes `transform: translate3d(x, y, 0)` and the `data-fallback="true"`
 * attribute on the host element. The element exposes a `:host` rule that
 * picks up `data-fallback` so the warning ring style takes effect
 * automatically (Req 14.6, design key decision #6).
 *
 * Lifecycle notes (HTML Custom Elements spec):
 *   - The constructor only attaches the shadow root, adopts shared styles,
 *     stamps the template clone, and binds the click listener (event-listener
 *     registration is not an attribute mutation, so it is allowed in the
 *     constructor). Per spec, custom-element constructors must not mutate
 *     the host element's attributes or descendants — that work happens in
 *     `connectedCallback` and inside the `annotation` setter, both of which
 *     run after the upgrade dance completes.
 *
 * Implements: Requirements 31.2, 31.3.
 */

import type { Annotation } from '@pinpoint/shared';
import { adoptStyles } from '../styles/sharedStyleSheet';
import { withBoundary } from '../lib/withBoundary';

/**
 * Per-element styles. `:host` carries layout, geometry, and the
 * `data-severity` → background-color mapping that consumes the shared
 * `--fl-severity-*` CSS Custom Properties (no severity hex codes are inlined
 * in this file — the palette comes from `@pinpoint/shared/theme`).
 *
 * The `:host([data-fallback="true"])` rule renders the warning ring required
 * when `PinPositioner` cannot resolve the stored selector to a live DOM
 * element (Req 14.3, 14.6).
 */
const PIN_ELEMENT_CSS = `
:host {
  position: absolute;
  top: 0;
  left: 0;
  width: 28px;
  height: 28px;
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
  will-change: transform;
  z-index: 2147483646;
  user-select: none;
  background-color: var(--fl-severity-informational);
}
:host([data-severity="critical"]) { background-color: var(--fl-severity-critical); }
:host([data-severity="major"])    { background-color: var(--fl-severity-major); }
:host([data-severity="minor"])    { background-color: var(--fl-severity-minor); }
:host([data-severity="informational"]) { background-color: var(--fl-severity-informational); }
:host([data-fallback="true"]) {
  outline: 2px solid var(--fl-severity-major);
  outline-offset: 2px;
}
.pin-number {
  pointer-events: none;
  display: inline-block;
  line-height: 1;
}
`;

const PIN_TEMPLATE = document.createElement('template');
PIN_TEMPLATE.innerHTML = `<style>${PIN_ELEMENT_CSS}</style><span class="pin-number" part="number"></span>`;

export class AnnotationPin extends HTMLElement {
  #annotation: Annotation | null = null;
  #numberEl: HTMLSpanElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    root.appendChild(PIN_TEMPLATE.content.cloneNode(true));

    const numberEl = root.querySelector<HTMLSpanElement>('.pin-number');
    if (!numberEl) {
      throw new Error('AnnotationPin: template missing .pin-number span');
    }
    this.#numberEl = numberEl;

    // Attach the click listener directly on the host. `addEventListener`
    // is not an attribute mutation, so it does not run afoul of the
    // Custom Elements spec rule (and jsdom's enforcement) that constructors
    // must not mutate the host element's attributes or children.
    this.addEventListener('click', this.#handleClick);
  }

  connectedCallback(): void {
    // Attribute setup happens here, not in the constructor, per the
    // Custom Elements spec ("requirements for custom element constructors")
    // and to satisfy jsdom's strict validation.
    if (!this.hasAttribute('role')) {
      this.setAttribute('role', 'button');
    }
    if (!this.hasAttribute('data-pinpoint')) {
      this.setAttribute('data-pinpoint', 'pin');
    }
  }

  /**
   * The annotation this pin represents. Setting this updates the rendered
   * pin number, the `data-severity` attribute (which drives the host's
   * background color via `--fl-severity-${severity}`), and accessibility
   * labels. Setting `null` clears the rendering.
   */
  get annotation(): Annotation | null {
    return this.#annotation;
  }

  set annotation(value: Annotation | null) {
    this.#annotation = value;
    this.#renderFromAnnotation();
  }

  #renderFromAnnotation(): void {
    const annotation = this.#annotation;
    if (annotation) {
      this.#numberEl.textContent = String(annotation.pinNumber);
      this.dataset.severity = annotation.severity;
      this.dataset.annotationId = annotation.id;
      this.setAttribute('aria-label', `Annotation pin ${annotation.pinNumber}`);
      this.title = `Pin #${annotation.pinNumber}`;
    } else {
      this.#numberEl.textContent = '';
      delete this.dataset.severity;
      delete this.dataset.annotationId;
      this.removeAttribute('aria-label');
      this.removeAttribute('title');
    }
  }

  /**
   * Click handler — emits a `pin-click` CustomEvent carrying the annotation
   * id so listeners in any ancestor (including outside the Shadow DOM that
   * may host `<fl-overlay-host>`) can react.
   *
   * `bubbles: true` + `composed: true` lets the event escape the Shadow Root
   * the way native UI events do (per design §35 "CSP-Strict Resilience").
   * `e.stopPropagation()` prevents the click from also being interpreted by
   * the page underneath as a "place new annotation here" gesture (the
   * Extension's overlay click handler uses bubbling clicks on the host page
   * to trigger popover anchoring).
   */
  #handleClick = (e: MouseEvent): void => {
    e.stopPropagation();
    const annotation = this.#annotation;
    if (!annotation) return;
    this.dispatchEvent(
      new CustomEvent<{ annotationId: string }>('pin-click', {
        detail: { annotationId: annotation.id },
        bubbles: true,
        composed: true,
      }),
    );
  };
}

/**
 * Register exactly once. Guarded so a hot module reload, a duplicate import,
 * or a test re-import does not throw "this name has already been used".
 */
if (
  typeof customElements !== 'undefined' &&
  !customElements.get('fl-annotation-pin')
) {
  withBoundary(AnnotationPin.prototype, 'connectedCallback');
  customElements.define('fl-annotation-pin', AnnotationPin);
}

declare global {
  interface HTMLElementTagNameMap {
    'fl-annotation-pin': AnnotationPin;
  }
  interface HTMLElementEventMap {
    'pin-click': CustomEvent<{ annotationId: string }>;
  }
}
