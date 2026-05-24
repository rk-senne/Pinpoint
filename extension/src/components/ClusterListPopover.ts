/**
 * `<fl-cluster-list-popover>` — Web Component for the popover surface that
 * opens when a user clicks (or activates with Enter / Space) a
 * `<fl-cluster-pin>`.
 *
 * Implements task 44.3 of the pinpoint-app spec (Requirement 52.2):
 * "On click, open a list popover showing the contained annotations; allow
 * drilling into one." This is a separate surface from `<fl-popover>` —
 * `<fl-popover>` is the per-annotation editor / viewer, while this list
 * popover is a small picker that lets the user pick one annotation out of
 * the cluster bucket. Selecting a row drills into the regular
 * `<fl-popover>` for that annotation, so the visual + interaction model is
 * "two-step: cluster → list → annotation".
 *
 * Public API
 * ----------
 *   - `annotations` (Annotation[])    — entries to render. Each row shows
 *                                       pin number, severity color dot, and
 *                                       the first line of the body.
 *   - `target` (PopoverTarget | null) — anchors the popover panel to a
 *                                       page-coordinate point. Mirrors the
 *                                       contract used by `<fl-popover>` so
 *                                       the host can reuse the same shape
 *                                       returned by `getBoundingClientRect()`
 *                                       on the cluster pin (see
 *                                       `popoverTargetFromRect()` below).
 *
 * Events (all `bubbles: true`, `composed: true`):
 *   - `annotation-select` — `{ detail: { annotationId } }` when a row is
 *     clicked or activated with Enter (matches `<fl-sidebar-panel>`'s
 *     `annotation-select` so the host can reuse the existing handler).
 *   - `close`             — fired when the dialog closes (Escape, native
 *     `<dialog>` close event, or a click outside the panel). The host uses
 *     this to drop its reference to this element.
 *
 * Reuses the shared stylesheet via `adoptStyles()` so severity dots resolve
 * via `--fl-severity-*` CSS Custom Properties — no hex codes inlined here
 * (Req 26.1, design key decision #11).
 *
 * Implements: Requirement 52.2.
 */
import type { Annotation } from '@pinpoint/shared';
import { adoptStyles } from '../styles/sharedStyleSheet';
import { withBoundary } from '../lib/withBoundary';

/**
 * Anchor descriptor used to position the popover panel. Same shape as
 * `<fl-popover>`'s `PopoverTarget` so the host can reuse a single
 * conversion helper from `DOMRect`.
 */
export interface ClusterListPopoverTarget {
  /** `pageX` of the anchor element's top-left in document coordinates. */
  pageX: number;
  /** `pageY` of the anchor element's top-left in document coordinates. */
  pageY: number;
}

/** Detail payload of the `annotation-select` `CustomEvent`. */
export interface ClusterListAnnotationSelectDetail {
  annotationId: string;
}

/**
 * Build a `ClusterListPopoverTarget` from a `DOMRect` produced by
 * `Element.getBoundingClientRect()` plus the page's current scroll offset.
 * Used by the overlay host to anchor the cluster list popover to the
 * cluster pin's bounding rect.
 */
export function popoverTargetFromRect(
  rect: { left: number; top: number },
  scroll: { x: number; y: number } = {
    x: typeof window !== 'undefined' ? window.scrollX : 0,
    y: typeof window !== 'undefined' ? window.scrollY : 0,
  },
): ClusterListPopoverTarget {
  return {
    pageX: rect.left + scroll.x,
    pageY: rect.top + scroll.y,
  };
}

/**
 * Per-element styles. Only declares rules that touch the `<dialog>`
 * defaults and the per-row layout — severity dots and text are styled
 * by reusing patterns from `<fl-sidebar-panel>`.
 */
const POPOVER_CSS = `
:host { display: contents; }
dialog.fl-cluster-list {
  border: none;
  background: #fff;
  padding: 0;
  margin: 0;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  min-width: 240px;
  max-width: 320px;
  max-height: 280px;
  overflow: hidden;
  pointer-events: auto;
  z-index: 2147483647;
  position: absolute;
}
dialog.fl-cluster-list[open] { display: block; }
dialog.fl-cluster-list::backdrop { background: transparent; }
.fl-cluster-list-header {
  padding: 8px 12px;
  border-bottom: 1px solid #eee;
  font-size: 12px;
  font-weight: 600;
  color: #444;
}
.fl-cluster-list-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
}
.fl-cluster-list-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #f0f0f0;
  cursor: pointer;
  font-size: 13px;
  color: #333;
}
.fl-cluster-list-item:last-child { border-bottom: none; }
.fl-cluster-list-item:hover,
.fl-cluster-list-item:focus {
  background: #f5f5f5;
  outline: none;
}
.fl-cluster-list-item:focus-visible {
  background: #f0f0f0;
  outline: 2px solid var(--fl-severity-major);
  outline-offset: -2px;
}
.fl-severity-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--fl-severity-informational);
}
.fl-severity-dot[data-severity="critical"]      { background: var(--fl-severity-critical); }
.fl-severity-dot[data-severity="major"]         { background: var(--fl-severity-major); }
.fl-severity-dot[data-severity="minor"]         { background: var(--fl-severity-minor); }
.fl-severity-dot[data-severity="informational"] { background: var(--fl-severity-informational); }
.fl-cluster-list-pin-number {
  font-weight: 600;
  flex-shrink: 0;
  min-width: 28px;
}
.fl-cluster-list-body {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #555;
}
.fl-cluster-list-empty {
  padding: 16px 12px;
  text-align: center;
  color: #999;
  font-size: 13px;
}
`;

const TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <style>${POPOVER_CSS}</style>
    <dialog class="fl-cluster-list" part="dialog" data-pinpoint="cluster-list-popover" role="dialog" aria-label="Annotations in cluster">
      <div class="fl-cluster-list-header" part="header">
        <span class="fl-cluster-list-header-text"></span>
      </div>
      <ul class="fl-cluster-list-list" role="listbox" part="list"></ul>
    </dialog>
  `;
  return t;
})();

const ROW_TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <li class="fl-cluster-list-item" role="option" tabindex="0">
      <span class="fl-severity-dot" aria-hidden="true"></span>
      <span class="fl-cluster-list-pin-number"></span>
      <span class="fl-cluster-list-body"></span>
    </li>
  `;
  return t;
})();

/**
 * Extract the first non-empty line of an annotation body for the row
 * preview. Mirrors the visual density of `<fl-sidebar-panel>` rows but
 * tighter — the cluster list popover is a small picker so only one line
 * is shown, ellipsised by the CSS rule above.
 */
function firstLineOf(body: string): string {
  if (!body) return '';
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

export class FlClusterListPopover extends HTMLElement {
  static readonly tagName = 'fl-cluster-list-popover';

  // --- Public-property backing fields ---
  #annotations: Annotation[] = [];
  #target: ClusterListPopoverTarget | null = null;

  // --- Shadow refs (resolved in constructor) ---
  #dialog!: HTMLDialogElement;
  #list!: HTMLUListElement;
  #headerText!: HTMLElement;

  // --- Listener bookkeeping so we can detach on disconnect ---
  #outsideClickListener: ((e: MouseEvent) => void) | null = null;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    root.appendChild(TEMPLATE.content.cloneNode(true));

    this.#dialog = root.querySelector('dialog.fl-cluster-list') as HTMLDialogElement;
    this.#list = root.querySelector('ul.fl-cluster-list-list') as HTMLUListElement;
    this.#headerText = root.querySelector('.fl-cluster-list-header-text') as HTMLElement;

    // Constructor only attaches event listeners (not attribute mutations);
    // permitted by the Custom Elements spec and jsdom's strict checks.
    this.#dialog.addEventListener('close', this.#onDialogClose);
    this.#list.addEventListener('click', this.#onListClick);
    this.#list.addEventListener('keydown', this.#onListKeyDown);
  }

  connectedCallback(): void {
    if (!this.hasAttribute('data-pinpoint')) {
      this.setAttribute('data-pinpoint', 'cluster-list-popover-host');
    }
  }

  disconnectedCallback(): void {
    this.#detachOutsideClickListener();
  }

  /**
   * Annotations to render. The element stores a defensive copy so a later
   * in-place mutation by the caller does not silently invalidate the
   * rendered rows. Reassigning re-renders the visible list.
   */
  get annotations(): readonly Annotation[] {
    return this.#annotations;
  }

  set annotations(next: readonly Annotation[] | null | undefined) {
    this.#annotations = next ? [...next] : [];
    this.#render();
  }

  /**
   * Anchor target. Setting a non-null value opens the popover; setting
   * `null` closes it. Positions the `<dialog>` panel at
   * `(target.pageX, target.pageY + 30)` so the panel sits below the
   * cluster pin (matches `<fl-popover>`'s 30 px vertical offset).
   */
  get target(): ClusterListPopoverTarget | null {
    return this.#target;
  }

  set target(next: ClusterListPopoverTarget | null | undefined) {
    this.#target = next ?? null;
    if (this.#target) {
      this.#applyPosition(this.#target);
      this.#openDialog();
    } else {
      this.#closeDialogSilently();
    }
  }

  /**
   * Programmatically close the popover and emit a `close` event. Used by
   * the host when it wants to dismiss the popover without going through
   * `target = null` (e.g., after `annotation-select` has been handled).
   */
  close(): void {
    if (this.#dialog.open) {
      // Triggering the native `close` event lets `#onDialogClose` dispatch
      // `close` for us — no need to do it twice.
      try {
        this.#dialog.close();
      } catch {
        this.#dialog.removeAttribute('open');
        this.#emitClose();
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                           */
  /* ---------------------------------------------------------------- */

  #render(): void {
    this.#headerText.textContent = `${this.#annotations.length} annotations`;
    this.#list.replaceChildren();

    if (this.#annotations.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'fl-cluster-list-empty';
      empty.textContent = 'No annotations';
      this.#list.appendChild(empty);
      return;
    }

    for (const a of this.#annotations) {
      this.#list.appendChild(this.#renderRow(a));
    }
  }

  #renderRow(a: Annotation): DocumentFragment {
    const node = ROW_TEMPLATE.content.cloneNode(true) as DocumentFragment;
    const li = node.querySelector('li.fl-cluster-list-item') as HTMLLIElement;
    const dot = node.querySelector('.fl-severity-dot') as HTMLSpanElement;
    const num = node.querySelector('.fl-cluster-list-pin-number') as HTMLSpanElement;
    const body = node.querySelector('.fl-cluster-list-body') as HTMLSpanElement;

    li.dataset.annotationId = a.id;
    dot.dataset.severity = a.severity;
    num.textContent = `#${a.pinNumber}`;
    body.textContent = firstLineOf(a.body);
    li.setAttribute('aria-label', `Pin ${a.pinNumber} (${a.severity})`);
    return node;
  }

  /* ---------------------------------------------------------------- */
  /* Position + dialog lifecycle                                      */
  /* ---------------------------------------------------------------- */

  #applyPosition(target: ClusterListPopoverTarget): void {
    // Inline `style` overrides the user-agent dialog centering. The
    // +30 px vertical offset matches `<fl-popover>` so the cluster list
    // sits just below the cluster pin.
    this.#dialog.style.left = `${target.pageX}px`;
    this.#dialog.style.top = `${target.pageY + 30}px`;
  }

  #openDialog(): void {
    if (this.#dialog.open) return;
    if (typeof this.#dialog.showModal === 'function') {
      try {
        // Pin margin: 0 to defeat the UA's modal-centering top-layer rule
        // (same approach as `<fl-popover>`).
        this.#dialog.style.margin = '0';
        this.#dialog.showModal();
        this.#attachOutsideClickListener();
        // Move focus to the first row so keyboard users can press Enter
        // immediately. Defer a microtask so the dialog has a chance to
        // settle in the top layer first.
        Promise.resolve().then(() => this.#focusFirstRow());
        return;
      } catch {
        // jsdom and some older engines throw or no-op on `showModal()`;
        // fall through to the attribute-based path so the rest of the
        // popover (rendering, events) keeps working in those runtimes.
      }
    }
    this.#dialog.setAttribute('open', '');
    this.#attachOutsideClickListener();
    Promise.resolve().then(() => this.#focusFirstRow());
  }

  #closeDialogSilently(): void {
    this.#detachOutsideClickListener();
    // Detach the close listener for the duration of the close call so the
    // native `close` event does not re-enter and double-fire `close`.
    this.#dialog.removeEventListener('close', this.#onDialogClose);
    if (this.#dialog.open) {
      try {
        this.#dialog.close();
      } catch {
        this.#dialog.removeAttribute('open');
      }
    }
    this.#dialog.addEventListener('close', this.#onDialogClose);
  }

  #focusFirstRow(): void {
    const first = this.#list.querySelector<HTMLLIElement>('li.fl-cluster-list-item');
    if (first) {
      try {
        first.focus();
      } catch {
        /* swallow — focus is a best-effort UX nicety */
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Event handlers                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Click on the list — find the row, dispatch `annotation-select`. Uses
   * delegation so we wire one listener regardless of list length.
   */
  #onListClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    const row = this.#findRow(target);
    if (row) {
      this.#selectRow(row);
    }
  };

  /**
   * Keyboard handling on the list:
   *   - Enter or Space   → activate the focused row (annotation-select).
   *   - ArrowDown        → move focus to the next row, wrapping.
   *   - ArrowUp          → move focus to the previous row, wrapping.
   *   - Home / End       → jump to first / last row.
   * Escape closes the dialog naturally (handled by the UA on `<dialog>`
   * when opened with `showModal`); the `close` event listener picks that
   * up and forwards as a `close` CustomEvent.
   */
  #onListKeyDown = (event: KeyboardEvent): void => {
    if (!(event.target instanceof HTMLElement)) return;
    const row = this.#findRow(event.target);
    if (!row) return;

    switch (event.key) {
      case 'Enter':
      case ' ':
      case 'Spacebar':
        event.preventDefault();
        this.#selectRow(row);
        return;
      case 'ArrowDown':
        event.preventDefault();
        this.#focusNeighbor(row, 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        this.#focusNeighbor(row, -1);
        return;
      case 'Home':
        event.preventDefault();
        this.#focusEdge('first');
        return;
      case 'End':
        event.preventDefault();
        this.#focusEdge('last');
        return;
      default:
        return;
    }
  };

  /**
   * Walk up from the given node until we hit a `.fl-cluster-list-item`
   * inside our `<ul>`, returning that element or `null`.
   */
  #findRow(node: Node): HTMLLIElement | null {
    let current: Node | null = node;
    while (current && current !== this.#list) {
      if (
        current instanceof HTMLElement &&
        current.classList.contains('fl-cluster-list-item')
      ) {
        return current as HTMLLIElement;
      }
      current = current.parentNode;
    }
    return null;
  }

  #selectRow(row: HTMLLIElement): void {
    const annotationId = row.dataset.annotationId;
    if (!annotationId) return;
    this.dispatchEvent(
      new CustomEvent<ClusterListAnnotationSelectDetail>('annotation-select', {
        detail: { annotationId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  #focusNeighbor(row: HTMLLIElement, direction: 1 | -1): void {
    const rows = Array.from(
      this.#list.querySelectorAll<HTMLLIElement>('li.fl-cluster-list-item'),
    );
    if (rows.length === 0) return;
    const idx = rows.indexOf(row);
    if (idx < 0) return;
    const nextIdx = (idx + direction + rows.length) % rows.length;
    rows[nextIdx].focus();
  }

  #focusEdge(edge: 'first' | 'last'): void {
    const rows = this.#list.querySelectorAll<HTMLLIElement>('li.fl-cluster-list-item');
    if (rows.length === 0) return;
    const target = edge === 'first' ? rows[0] : rows[rows.length - 1];
    target.focus();
  }

  #onDialogClose = (): void => {
    this.#detachOutsideClickListener();
    this.#emitClose();
  };

  #emitClose(): void {
    this.dispatchEvent(
      new CustomEvent<void>('close', {
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Click-outside handler. The native `<dialog>` has a backdrop that
   * already swallows page clicks while open, but we also want clicks on
   * the backdrop itself to dismiss the popover. We listen on the
   * document and check if the click landed outside the panel — when it
   * did, we trigger `close()`.
   */
  #attachOutsideClickListener(): void {
    if (this.#outsideClickListener) return;
    const handler = (e: MouseEvent): void => {
      // The dialog's bounding rect tells us whether the click landed on
      // the backdrop (outside the panel) vs the panel itself. We use
      // `composedPath` so a click bubbling from inside our Shadow Root
      // is also handled correctly.
      if (!this.#dialog.open) return;
      const path = e.composedPath();
      if (path.includes(this.#dialog)) return;
      // If the click went through the host element (e.g. the cluster
      // pin that opened us), do not close — the host will reopen
      // on the next tick and we'd just oscillate.
      if (path.includes(this)) return;
      this.close();
    };
    this.#outsideClickListener = handler;
    // Defer the registration by a microtask so the same click that
    // opened the popover is not immediately interpreted as an
    // outside-click on the freshly-opened panel.
    Promise.resolve().then(() => {
      if (this.#outsideClickListener === handler && typeof document !== 'undefined') {
        document.addEventListener('click', handler, true);
      }
    });
  }

  #detachOutsideClickListener(): void {
    if (!this.#outsideClickListener) return;
    if (typeof document !== 'undefined') {
      document.removeEventListener('click', this.#outsideClickListener, true);
    }
    this.#outsideClickListener = null;
  }
}

if (
  typeof customElements !== 'undefined' &&
  !customElements.get(FlClusterListPopover.tagName)
) {
  withBoundary(FlClusterListPopover.prototype, 'connectedCallback');
  withBoundary(FlClusterListPopover.prototype, 'disconnectedCallback');
  customElements.define(FlClusterListPopover.tagName, FlClusterListPopover);
}

declare global {
  interface HTMLElementTagNameMap {
    'fl-cluster-list-popover': FlClusterListPopover;
  }
  interface HTMLElementEventMap {
    // `annotation-select` is already declared by SidebarPanel. We don't
    // redeclare it here (TS would error on duplicate); both elements emit
    // the same shape so consumers can listen with one handler.
  }
}

export default FlClusterListPopover;
