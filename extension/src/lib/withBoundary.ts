/**
 * `withBoundary(target, methodName)` decorator-shaped helper + the
 * companion `<fl-error-tag>` Custom Element.
 *
 * Per task 42.1 of the pinpoint-app spec (Requirement 50.1) and
 * design §"Error Boundaries":
 *
 *   - Every Custom Element's `connectedCallback`, `disconnectedCallback`,
 *     and externally-callable methods are wrapped by this helper so that
 *     synchronous throws AND rejected promises are caught.
 *   - On error the helper logs to `console.error` with a structured
 *     payload (`{ component, method, error }`) and renders an inline
 *     `<fl-error-tag>` inside the affected element so the user gets a
 *     visible "something went wrong" indicator without the exception
 *     propagating into the host page's runtime.
 *   - The wrapper is idempotent with respect to its rendered indicator:
 *     repeated failures on the same element do NOT accumulate multiple
 *     `<fl-error-tag>` children. The first error tag stays; subsequent
 *     errors are only logged.
 *
 * Decorator shape: matches the legacy
 *   `function decorator(target, methodName) { ...mutate target... }`
 * signature so it can be used either inline as
 *   `withBoundary(this, '_connectedCallback')`
 * inside a constructor or as a future-stage class-method decorator. The
 * helper also returns the wrapped function for callers who prefer the
 * explicit `connectedCallback = withBoundary(this, '_cc')` form, mirroring
 * the design's `connectedCallback = withBoundary('fl-popover', this._cc)`
 * pattern.
 */

const ERROR_TAG_NAME = 'fl-error-tag';

/**
 * Marker attribute used to detect an already-rendered error tag inside an
 * affected element (or its Shadow Root). Lives as a `data-*` attribute so
 * it is valid HTML and survives node cloning. Idempotent rendering keys
 * off this marker — see `renderInlineErrorTag()`.
 */
const ERROR_TAG_MARKER = 'data-fl-error-tag';

/**
 * `<fl-error-tag>` — a tiny localized error indicator that is rendered
 * inside whichever Custom Element threw. Per design:
 *
 *   <span class="fl-error-tag" role="alert">Something went wrong</span>
 *
 * The element owns its own minimal styles inline (no dependency on the
 * shared theme stylesheet) so it remains visible even when the failure
 * happened during stylesheet adoption itself.
 */
export class FlErrorTag extends HTMLElement {
  static readonly tagName = ERROR_TAG_NAME;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const span = document.createElement('span');
    span.className = 'fl-error-tag';
    span.setAttribute('role', 'alert');
    span.textContent = 'Something went wrong';
    // Inline styling per-property (not via `style.cssText`) so the
    // indicator is visible even when shared stylesheet adoption has
    // failed AND the runtime stays CSP-clean under a strict
    // `style-src` policy (Req 49.1, task 41.1). `cssText` would set
    // the entire `style` attribute as one inline string, which is
    // exactly what a strict CSP is meant to inhibit. Each property
    // is written through the typed `CSSStyleDeclaration` object below.
    const errorTagStyle: Readonly<Record<string, string>> = {
      display: 'inline-block',
      padding: '2px 6px',
      background: '#fee',
      color: '#900',
      border: '1px solid #f99',
      borderRadius: '4px',
      fontSize: '12px',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      lineHeight: '1.4',
    };
    const styleObj = span.style as unknown as Record<string, string>;
    for (const [prop, value] of Object.entries(errorTagStyle)) {
      styleObj[prop] = value;
    }
    root.appendChild(span);
  }
}

// Idempotent registration so repeated imports / HMR / test bootstraps do
// not throw "this name has already been used".
if (typeof customElements !== 'undefined' && !customElements.get(FlErrorTag.tagName)) {
  customElements.define(FlErrorTag.tagName, FlErrorTag);
}

declare global {
  interface HTMLElementTagNameMap {
    'fl-error-tag': FlErrorTag;
  }
}

/**
 * Render exactly one `<fl-error-tag>` inside the affected element. Looks
 * for the `data-fl-error-tag` marker first and short-circuits on hit so
 * repeated failures on the same component never accumulate multiple
 * indicators (Req 50.1 — "render `<fl-error-tag>` inside the affected
 * element to indicate the failure"; the task explicitly requires that
 * "multiple calls don't accumulate error tags").
 *
 * Rendering target precedence:
 *   1. If the host element has an open Shadow Root, append the tag to the
 *      Shadow Root (so the indicator is co-located with the failed
 *      Custom Element's other rendered content).
 *   2. Otherwise append directly to the host element.
 *
 * Closed Shadow Roots are inaccessible from outside the element, so we
 * fall through to (2) — the indicator may end up as light-DOM content,
 * but the user still sees it.
 */
export function renderInlineErrorTag(host: Element | null | undefined): void {
  if (!host) return;
  if (typeof document === 'undefined') return;

  const root = pickRenderRoot(host);
  if (!root) return;

  const existing =
    typeof (root as ParentNode).querySelector === 'function'
      ? (root as ParentNode).querySelector(`[${ERROR_TAG_MARKER}]`)
      : null;
  if (existing) return;

  const tag = document.createElement(ERROR_TAG_NAME);
  tag.setAttribute(ERROR_TAG_MARKER, '');
  root.appendChild(tag);
}

/**
 * Resolve where to mount the error indicator: prefer an open Shadow Root,
 * fall back to the host element itself. A `null` Shadow Root (closed mode
 * or none attached) bypasses the Shadow Root branch.
 */
function pickRenderRoot(host: Element): Node | null {
  const shadow = (host as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
  if (shadow) return shadow;
  return host;
}

/**
 * Default fallback when a thrown value is not an `Error` instance — the
 * structured-log payload should still expose something meaningful.
 */
function normalizeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  try {
    return { name: 'NonError', message: String(err) };
  } catch {
    return { name: 'NonError', message: '<unprintable>' };
  }
}

/**
 * Internal: handle a caught error from a wrapped method. Logs via
 * `console.error` (the extension does not yet have a structured logger;
 * `console.error` is the canonical sink today — Req 27.* covers the
 * server-side structured logger, the client-side equivalent is tracked
 * separately) and renders the inline error tag when `self` is an
 * Element-like host.
 */
function handleBoundaryError(self: unknown, methodName: PropertyKey, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error('[pinpoint] withBoundary caught error', {
    method: String(methodName),
    error: normalizeError(err),
  });
  if (self instanceof Element) {
    renderInlineErrorTag(self);
  }
}

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Decorator-shaped helper. Reads `target[methodName]`, replaces it with a
 * wrapped version that catches sync throws AND rejected promises, and
 * returns the wrapped function so callers can chain it.
 *
 * Usage on a Custom Element prototype (canonical for lifecycle hooks —
 * the custom-elements spec caches lifecycle callbacks at `define()` time
 * by reading the class prototype, so wrapping on the prototype is what
 * lets `withBoundary` intercept `connectedCallback`/`disconnectedCallback`):
 *
 *     class FlPopover extends HTMLElement {
 *       connectedCallback() { ...real work... }
 *       disconnectedCallback() { ...real work... }
 *     }
 *     withBoundary(FlPopover.prototype, 'connectedCallback');
 *     withBoundary(FlPopover.prototype, 'disconnectedCallback');
 *     customElements.define('fl-popover', FlPopover);
 *
 * For event handlers stored as own-property bound functions on an
 * instance, wrap directly on the instance after constructing them:
 *
 *     class FlToolbar extends HTMLElement {
 *       constructor() {
 *         super();
 *         this.handleClick = this.handleClick.bind(this);
 *         withBoundary(this, 'handleClick');
 *       }
 *     }
 *
 * Either way `withBoundary` installs the wrapper as an own property of
 * `target`, leaving the prototype chain intact for other instances and
 * subclasses (when called on an instance).
 */
export function withBoundary<T extends object, K extends keyof T>(
  target: T,
  methodName: K,
): T[K] {
  const original = target[methodName] as unknown;
  if (typeof original !== 'function') {
    throw new TypeError(
      `withBoundary: ${String(methodName)} is not a function on the target ` +
        `(got ${original === null ? 'null' : typeof original})`,
    );
  }
  const fn = original as AnyFn;

  const wrapped = function wrappedByBoundary(this: unknown, ...args: unknown[]): unknown {
    try {
      const out = fn.apply(this, args);
      if (
        out !== null &&
        typeof out === 'object' &&
        typeof (out as { then?: unknown }).then === 'function'
      ) {
        return (out as Promise<unknown>).then(
          (value) => value,
          (err: unknown) => {
            handleBoundaryError(this, methodName, err);
            return undefined;
          },
        );
      }
      return out;
    } catch (err) {
      handleBoundaryError(this, methodName, err);
      return undefined;
    }
  };

  (target as Record<PropertyKey, unknown>)[methodName as PropertyKey] = wrapped;
  return wrapped as unknown as T[K];
}
