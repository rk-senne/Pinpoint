/**
 * `<fl-sidebar-panel>` — Web Component conversion of the React `SidebarPanel`
 * (extension/src/components/SidebarPanel.tsx).
 *
 * Per task 17.6 of the pinpoint-app spec (Requirement 31.3):
 *   1. Receives `annotations` via a property setter; on assignment, renders
 *      the Active and Resolved tab lists.
 *   2. Two tabs:
 *        - **Active**   — annotations with `status === 'active'` or
 *                         `status === 'in_progress'` (default tab).
 *        - **Resolved** — annotations with `status === 'resolved'`.
 *   3. Each list item is clickable. On click the host dispatches an
 *      `annotation-select` `CustomEvent` with `{ detail: { annotationId } }`
 *      that bubbles and crosses the Shadow Root boundary (`composed: true`).
 *   4. Severity color comes from the shared `--fl-severity-*` CSS Custom
 *      Properties (declared in `themeCss()` and adopted via the shared
 *      stylesheet). The inline `SEVERITY_COLORS` map that lived in the React
 *      version is removed here — the palette has a single source of truth in
 *      `@pinpoint/shared/theme`.
 *
 * Task 36.5 (Req 44.4): also hosts a `<fl-sync-conflict-tray>` element
 * above the tab list. The tray subscribes to `chrome.storage.onChanged`
 * for the `pinpoint_sync_conflicts` key and renders a Retry / Edit
 * / Discard action row per conflicted outbox entry.
 *
 * Style + structure mirror the rest of the extension's Custom Elements:
 *   - Open Shadow Root.
 *   - `adoptStyles(shadowRoot)` from `../styles/sharedStyleSheet` (with a
 *     `<style>` fallback when constructable stylesheets are unavailable).
 *   - A single `<template>` cloned per instance; subsequent renders swap the
 *     list contents in place, no React, no virtual DOM.
 *   - Idempotent `customElements.define()` so HMR / repeated test imports
 *     do not throw "this name has already been used".
 *
 * Implements: Requirement 31.3, Requirement 44.4 (tray slot).
 */
import type { Annotation, AnnotationStatus } from '@pinpoint/shared';
import { adoptStyles } from '../styles/sharedStyleSheet';
import { withBoundary } from '../lib/withBoundary';
import './SyncConflictTray';

/**
 * Detail payload of the `annotation-select` `CustomEvent` dispatched on row
 * click. Consumers (`<fl-overlay-host>`) read `detail.annotationId` and
 * delegate to the popover controller.
 */
export interface AnnotationSelectEventDetail {
  annotationId: string;
}

type SidebarTab = 'active' | 'resolved';

/**
 * Active = `status` is `'active'` or `'in_progress'`. Resolved = `'resolved'`.
 * Centralized so both the tab counts and the visible list use identical logic.
 */
function isActive(status: AnnotationStatus): boolean {
  return status !== 'resolved';
}

/**
 * Per-element CSS scoped by `:host` and the structural classes already
 * defined in the shared stylesheet (`.fl-sidebar`, `.fl-sidebar-tabs`,
 * `.fl-sidebar-item`). No severity hex codes are inlined here — the
 * severity dot reads `var(--fl-severity-…)` from the shared stylesheet
 * (Req 26.1, design key decision #11).
 */
const PANEL_CSS = `
:host {
  display: block;
}
.fl-sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
}
.fl-sidebar-header strong { font-size: 14px; }
.fl-close-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  color: inherit;
  padding: 4px;
}
.fl-sidebar-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.fl-sidebar-empty {
  padding: 24px;
  text-align: center;
  color: #999;
  font-size: 13px;
}
.fl-sidebar-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
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
.fl-pin-number { font-weight: 500; }
.fl-annotation-type {
  color: #666;
  text-transform: capitalize;
}
.fl-annotation-body {
  margin-top: 4px;
  font-size: 13px;
  color: #444;
}
`;

/**
 * Single shared `<template>` cloned by every instance. The two regions that
 * change between renders are the tab buttons (label + count + active class)
 * and the list `<ol>` underneath.
 */
const TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <style>${PANEL_CSS}</style>
    <div class="fl-sidebar" data-pinpoint="sidebar" part="sidebar">
      <div class="fl-sidebar-header">
        <strong>Annotations</strong>
        <button
          type="button"
          class="fl-close-btn"
          part="close"
          aria-label="Close sidebar"
        >✕</button>
      </div>
      <fl-sync-conflict-tray part="conflict-tray"></fl-sync-conflict-tray>
      <div class="fl-sidebar-tabs" role="tablist">
        <button
          type="button"
          class="fl-tab-active active"
          role="tab"
          data-tab="active"
          aria-selected="true"
        ></button>
        <button
          type="button"
          class="fl-tab-resolved"
          role="tab"
          data-tab="resolved"
          aria-selected="false"
        ></button>
      </div>
      <ol class="fl-sidebar-list" role="listbox" part="list" aria-label="Annotations" tabindex="0"></ol>
    </div>
  `;
  return t;
})();

const ROW_TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <li class="fl-sidebar-item" role="option" aria-selected="false" tabindex="-1">
      <div class="fl-sidebar-row-head">
        <span class="fl-severity-dot" aria-hidden="true"></span>
        <span class="fl-pin-number"></span>
        <span class="fl-annotation-type"></span>
      </div>
      <div class="fl-annotation-body"></div>
    </li>
  `;
  return t;
})();

export class FlSidebarPanel extends HTMLElement {
  static readonly tagName = 'fl-sidebar-panel';

  #annotations: Annotation[] = [];
  #tab: SidebarTab = 'active';
  /**
   * Index of the highlighted row within the currently visible list
   * (Active or Resolved). `-1` when the list is empty. Arrow keys move
   * the highlight; Enter activates the highlighted row by dispatching
   * the same `annotation-select` event a click would dispatch.
   * Independent of DOM focus — we keep the listbox itself focused and
   * mirror the active descendant via `aria-activedescendant`.
   */
  #highlightedIndex = -1;
  /** Cached list of annotations rendered in the visible tab. */
  #visible: Annotation[] = [];

  #activeBtn!: HTMLButtonElement;
  #resolvedBtn!: HTMLButtonElement;
  #list!: HTMLOListElement;
  #closeBtn!: HTMLButtonElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    root.appendChild(TEMPLATE.content.cloneNode(true));

    this.#activeBtn = root.querySelector('button.fl-tab-active') as HTMLButtonElement;
    this.#resolvedBtn = root.querySelector('button.fl-tab-resolved') as HTMLButtonElement;
    this.#list = root.querySelector('ol.fl-sidebar-list') as HTMLOListElement;
    this.#closeBtn = root.querySelector('button.fl-close-btn') as HTMLButtonElement;
  }

  connectedCallback(): void {
    this.#activeBtn.addEventListener('click', this.#onSelectActiveTab);
    this.#resolvedBtn.addEventListener('click', this.#onSelectResolvedTab);
    this.#list.addEventListener('click', this.#onListClick);
    this.#list.addEventListener('keydown', this.#onListKeydown);
    this.#closeBtn.addEventListener('click', this.#onClose);
    this.#render();
  }

  disconnectedCallback(): void {
    this.#activeBtn.removeEventListener('click', this.#onSelectActiveTab);
    this.#resolvedBtn.removeEventListener('click', this.#onSelectResolvedTab);
    this.#list.removeEventListener('click', this.#onListClick);
    this.#list.removeEventListener('keydown', this.#onListKeydown);
    this.#closeBtn.removeEventListener('click', this.#onClose);
  }

  /**
   * Public `annotations` property. Assigning a new array re-renders the tab
   * counts and the visible list. The element stores a defensive copy so a
   * later in-place mutation by the caller does not silently invalidate the
   * rendered rows.
   */
  get annotations(): readonly Annotation[] {
    return this.#annotations;
  }

  set annotations(next: readonly Annotation[] | null | undefined) {
    this.#annotations = next ? [...next] : [];
    if (this.shadowRoot) {
      this.#render();
    }
  }

  /** Currently selected tab. Exposed for tests; default is `'active'`. */
  get tab(): SidebarTab {
    return this.#tab;
  }

  set tab(next: SidebarTab) {
    if (next !== 'active' && next !== 'resolved') return;
    if (this.#tab === next) return;
    this.#tab = next;
    if (this.shadowRoot) {
      this.#render();
    }
  }

  #render(): void {
    const activeCount = this.#annotations.filter((a) => isActive(a.status)).length;
    const resolvedCount = this.#annotations.length - activeCount;

    this.#activeBtn.textContent = `Active (${activeCount})`;
    this.#resolvedBtn.textContent = `Resolved (${resolvedCount})`;

    const activeTab = this.#tab === 'active';
    this.#activeBtn.classList.toggle('active', activeTab);
    this.#resolvedBtn.classList.toggle('active', !activeTab);
    this.#activeBtn.setAttribute('aria-selected', String(activeTab));
    this.#resolvedBtn.setAttribute('aria-selected', String(!activeTab));

    const visible = this.#annotations.filter((a) =>
      activeTab ? isActive(a.status) : a.status === 'resolved',
    );
    this.#visible = visible;

    this.#list.replaceChildren();

    if (visible.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'fl-sidebar-empty';
      empty.textContent = `No ${this.#tab} annotations`;
      this.#list.appendChild(empty);
      this.#highlightedIndex = -1;
      this.#list.removeAttribute('aria-activedescendant');
      return;
    }

    visible.forEach((a, idx) => {
      this.#list.appendChild(this.#renderRow(a, idx));
    });

    // Reset highlight to the first row whenever the list is rebuilt so
    // ArrowDown / Enter has a sensible default and `aria-activedescendant`
    // points at a real option.
    this.#highlightedIndex = 0;
    this.#applyHighlight();
  }

  #renderRow(a: Annotation, index: number): DocumentFragment {
    const node = ROW_TEMPLATE.content.cloneNode(true) as DocumentFragment;
    const li = node.querySelector('li.fl-sidebar-item') as HTMLLIElement;
    const dot = node.querySelector('.fl-severity-dot') as HTMLSpanElement;
    const num = node.querySelector('.fl-pin-number') as HTMLSpanElement;
    const type = node.querySelector('.fl-annotation-type') as HTMLSpanElement;
    const body = node.querySelector('.fl-annotation-body') as HTMLDivElement;

    li.dataset.annotationId = a.id;
    li.dataset.optionIndex = String(index);
    li.id = `fl-sidebar-option-${a.id}`;
    dot.dataset.severity = a.severity;
    num.textContent = `#${a.pinNumber}`;
    type.textContent = a.type;
    body.textContent = a.body.length > 80 ? `${a.body.slice(0, 80)}…` : a.body;
    return node;
  }

  /**
   * Mirror `#highlightedIndex` onto the rendered rows: each row's
   * `aria-selected` reflects whether it is the active descendant, and
   * `<ol>`'s `aria-activedescendant` points at the active row's id so
   * screen readers announce it without DOM focus moving onto each row.
   */
  #applyHighlight(): void {
    const items = this.#list.querySelectorAll<HTMLLIElement>('li.fl-sidebar-item');
    let activeId: string | null = null;
    items.forEach((li, idx) => {
      const selected = idx === this.#highlightedIndex;
      li.setAttribute('aria-selected', selected ? 'true' : 'false');
      li.classList.toggle('fl-sidebar-item-active', selected);
      if (selected) activeId = li.id;
    });
    if (activeId) {
      this.#list.setAttribute('aria-activedescendant', activeId);
    } else {
      this.#list.removeAttribute('aria-activedescendant');
    }
  }

  #setHighlight(index: number): void {
    if (index === this.#highlightedIndex) return;
    this.#highlightedIndex = index;
    this.#applyHighlight();
  }

  #onSelectActiveTab = (): void => {
    this.tab = 'active';
  };

  #onSelectResolvedTab = (): void => {
    this.tab = 'resolved';
  };

  /**
   * Delegated click handler for the `<ol>` list. Walks up from the click
   * target until it finds a `.fl-sidebar-item` row, reads the data attribute
   * and dispatches `annotation-select` carrying the annotation id.
   */
  #onListClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;

    let node: Node | null = target;
    while (node && node !== this.#list) {
      if (node instanceof HTMLElement && node.classList.contains('fl-sidebar-item')) {
        const annotationId = node.dataset.annotationId;
        if (annotationId) {
          // Sync the keyboard highlight so a follow-up Arrow key starts
          // from the clicked row, not from wherever the highlight was.
          const idx = Number.parseInt(node.dataset.optionIndex ?? '-1', 10);
          if (Number.isInteger(idx) && idx >= 0) {
            this.#setHighlight(idx);
          }
          this.#dispatchSelect(annotationId);
        }
        return;
      }
      node = node.parentNode;
    }
  };

  /**
   * Keyboard navigation on the listbox (task 33.2 / Req 42.1):
   *   - ArrowUp / ArrowDown move the highlight (with wrap-around).
   *   - Home / End jump to the first / last visible row.
   *   - Enter activates the highlighted row by dispatching
   *     `annotation-select` — the same event a click would dispatch so
   *     consumers (`<fl-overlay-host>`) need only one listener.
   * No-ops when the visible list is empty (e.g. an empty Active tab).
   */
  #onListKeydown = (event: KeyboardEvent): void => {
    if (this.#visible.length === 0) return;
    const len = this.#visible.length;
    let next = this.#highlightedIndex;
    switch (event.key) {
      case 'ArrowDown':
        next = next < 0 ? 0 : (next + 1) % len;
        break;
      case 'ArrowUp':
        next = next < 0 ? len - 1 : (next - 1 + len) % len;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = len - 1;
        break;
      case 'Enter':
      case ' ': {
        if (this.#highlightedIndex < 0) return;
        const annotation = this.#visible[this.#highlightedIndex];
        if (!annotation) return;
        event.preventDefault();
        this.#dispatchSelect(annotation.id);
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    this.#setHighlight(next);
  };

  #dispatchSelect(annotationId: string): void {
    this.dispatchEvent(
      new CustomEvent<AnnotationSelectEventDetail>('annotation-select', {
        detail: { annotationId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  #onClose = (): void => {
    this.dispatchEvent(
      new CustomEvent<void>('close', {
        bubbles: true,
        composed: true,
      }),
    );
  };
}

// Idempotent registration. Guarded so a duplicate import (HMR, repeated
// test bootstrap) does not throw "this name has already been used".
if (
  typeof customElements !== 'undefined' &&
  !customElements.get(FlSidebarPanel.tagName)
) {
  withBoundary(FlSidebarPanel.prototype, 'connectedCallback');
  withBoundary(FlSidebarPanel.prototype, 'disconnectedCallback');
  customElements.define(FlSidebarPanel.tagName, FlSidebarPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    'fl-sidebar-panel': FlSidebarPanel;
  }
  interface HTMLElementEventMap {
    'annotation-select': CustomEvent<AnnotationSelectEventDetail>;
  }
}
