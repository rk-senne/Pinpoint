/**
 * `<fl-project-picker>` — Web Component for the manual project picker
 * fallback (Phase 19 of the pinpoint-app spec, Requirement 39.1).
 *
 * Shown when `GET /api/v1/projects/by-url` returns 404 and the Extension
 * cannot auto-detect a project for the current page. The picker lists the
 * user's accessible projects ordered by `lastUsedAt DESC` (most recent
 * first). On selection it persists the URL→Project mapping into
 * `chrome.storage.local` (Requirement 39.2, task 30.2) via the
 * `projectMappingStore` helper, then dispatches a bubbling, composed
 * `select` `CustomEvent` carrying the chosen `projectId`. The consumer
 * (`<fl-overlay-host>`) is responsible for switching the overlay's
 * `currentProjectId` in response.
 *
 * Shape mirrors the rest of the extension's Custom Elements:
 *   - HTMLElement subclass with an open Shadow Root.
 *   - `adoptStyles(shadowRoot)` from `../styles/sharedStyleSheet` so the
 *     shared constructable `CSSStyleSheet` (or `<style>` fallback under
 *     jsdom / older engines) is the single source of truth for theme +
 *     overlay rules.
 *   - Single `<template>` cloned per instance; subsequent renders swap the
 *     list contents in place — no React, no virtual DOM.
 *   - `#`-private fields and idempotent `customElements.define()` guard so
 *     repeated imports / HMR / test bootstraps do not throw "this name has
 *     already been used".
 *
 * Implements: Requirement 39.1.
 * Implements: Requirement 39.2 (cache write on selection).
 */
import { adoptStyles } from '../styles/sharedStyleSheet';
import { withBoundary } from '../lib/withBoundary';
import { rememberProject } from '../lib/projectMappingStore';

/**
 * Minimal project shape consumed by the picker. The dropdown only needs an
 * id to emit, a display name, and a `lastUsedAt` ISO 8601 timestamp used as
 * the sort key. Kept structural so the consumer can pass either a slice of
 * the full `Project` model from `@pinpoint/shared` or a compact
 * server-provided projection (e.g. `GET /api/v1/projects?recent=true`).
 */
export interface PickerProject {
  id: string;
  name: string;
  /**
   * ISO 8601 timestamp of when the user last accessed / selected the
   * project. Sort is descending — the most recently used project appears
   * first. Missing or unparseable values sort to the bottom.
   */
  lastUsedAt: string;
}

/**
 * Detail payload of the `select` `CustomEvent` dispatched on row click.
 * Only the `projectId` is included — the consumer already holds the full
 * project list and can re-derive the rest if it needs to.
 */
export interface ProjectPickerSelectEventDetail {
  projectId: string;
}

/**
 * Per-element CSS scoped by `:host` and the structural classes already
 * defined in the shared stylesheet. The dropdown reuses
 * `.fl-mention-dropdown` / `.fl-mention-item` rules from the shared sheet
 * so the visual surface matches the @mention dropdown next to it. No theme
 * hex codes are inlined here.
 */
const PICKER_CSS = `
:host {
  display: block;
}
.fl-project-picker {
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  padding: 12px;
  min-width: 280px;
  pointer-events: auto;
}
.fl-project-picker-header {
  font-weight: 600;
  font-size: 13px;
  margin: 4px 4px 8px;
  color: #333;
}
.fl-project-picker-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
}
.fl-project-picker-empty {
  padding: 16px;
  text-align: center;
  color: #999;
  font-size: 13px;
}
.fl-project-picker-item {
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.fl-project-picker-item:hover,
.fl-project-picker-item:focus {
  background: #f0f0f0;
  outline: none;
}
.fl-project-picker-name {
  font-weight: 500;
  color: #1a1a1a;
}
.fl-project-picker-meta {
  font-size: 11px;
  color: #999;
}
`;

/**
 * Single shared `<template>` cloned by every instance. The list `<ol>` is
 * the only mutable region; rows are stamped into it on each render.
 */
const TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <style>${PICKER_CSS}</style>
    <div class="fl-project-picker" part="picker" role="dialog" aria-label="Pick a project">
      <div class="fl-project-picker-header" part="header">Pick a project</div>
      <ol class="fl-project-picker-list" part="list" role="listbox"></ol>
    </div>
  `;
  return t;
})();

const ROW_TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <li class="fl-project-picker-item" role="option" tabindex="0">
      <span class="fl-project-picker-name"></span>
      <span class="fl-project-picker-meta"></span>
    </li>
  `;
  return t;
})();

/**
 * Parse an ISO 8601 timestamp into a sortable number. Returns
 * `Number.NEGATIVE_INFINITY` for missing / unparseable values so they sort
 * to the bottom of a descending list.
 */
function lastUsedKey(p: PickerProject): number {
  if (typeof p.lastUsedAt !== 'string' || p.lastUsedAt.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const t = Date.parse(p.lastUsedAt);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * Sort projects by `lastUsedAt` descending without mutating the input.
 * Exposed so unit tests can verify the ordering rule directly without
 * round-tripping through the DOM.
 */
export function sortProjectsByRecency(
  projects: readonly PickerProject[],
): PickerProject[] {
  return [...projects].sort((a, b) => lastUsedKey(b) - lastUsedKey(a));
}

/**
 * Format a `lastUsedAt` ISO timestamp for the meta line under each row.
 * Falls back to the raw string when unparseable, and to an empty string
 * when missing — the meta `<span>` is removed in that case.
 */
function formatLastUsed(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return value;
  try {
    return new Date(t).toLocaleString();
  } catch {
    return value;
  }
}

export class FlProjectPicker extends HTMLElement {
  static readonly tagName = 'fl-project-picker';

  #projects: PickerProject[] = [];
  #list!: HTMLOListElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    root.appendChild(TEMPLATE.content.cloneNode(true));

    this.#list = root.querySelector('ol.fl-project-picker-list') as HTMLOListElement;

    // One delegated click handler covers every row — saves attaching and
    // detaching listeners on every re-render. Keyboard activation is also
    // routed through here via Enter / Space on focused rows.
    this.#list.addEventListener('click', this.#onListClick);
    this.#list.addEventListener('keydown', this.#onListKeydown);
  }

  connectedCallback(): void {
    this.#render();
  }

  /**
   * Public `projects` property. Assigning a new array re-renders the
   * recent-first list. The element stores a defensive copy so a later
   * in-place mutation by the caller does not silently invalidate the
   * rendered rows.
   */
  get projects(): readonly PickerProject[] {
    return this.#projects;
  }

  set projects(next: readonly PickerProject[] | null | undefined) {
    this.#projects = next ? [...next] : [];
    if (this.shadowRoot) {
      this.#render();
    }
  }

  /**
   * Returns the currently rendered project order (most-recent first).
   * Computed on each access by re-sorting the stored list. Exposed for
   * unit tests so they can verify the sort independent of DOM scraping.
   */
  get visibleProjects(): PickerProject[] {
    return sortProjectsByRecency(this.#projects);
  }

  #render(): void {
    const ordered = sortProjectsByRecency(this.#projects);
    this.#list.replaceChildren();

    if (ordered.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'fl-project-picker-empty';
      empty.textContent = 'No projects available';
      this.#list.appendChild(empty);
      return;
    }

    for (const p of ordered) {
      this.#list.appendChild(this.#renderRow(p));
    }
  }

  #renderRow(project: PickerProject): DocumentFragment {
    const node = ROW_TEMPLATE.content.cloneNode(true) as DocumentFragment;
    const li = node.querySelector('li.fl-project-picker-item') as HTMLLIElement;
    const name = node.querySelector('.fl-project-picker-name') as HTMLElement;
    const meta = node.querySelector('.fl-project-picker-meta') as HTMLElement;

    li.dataset.projectId = project.id;
    name.textContent = project.name;

    const metaText = formatLastUsed(project.lastUsedAt);
    if (metaText.length === 0) {
      meta.remove();
    } else {
      meta.textContent = metaText;
    }
    return node;
  }

  /**
   * Walk up from `start` until a `.fl-project-picker-item` row is found
   * (or until we reach the list root). Returns the row's `data-project-id`
   * when found, otherwise `null`.
   */
  #resolveRowProjectId(start: EventTarget | null): string | null {
    if (!(start instanceof Node)) return null;
    let node: Node | null = start;
    while (node && node !== this.#list) {
      if (
        node instanceof HTMLElement &&
        node.classList.contains('fl-project-picker-item')
      ) {
        return node.dataset.projectId ?? null;
      }
      node = node.parentNode;
    }
    return null;
  }

  /**
   * Delegated click handler. Resolves the clicked row's `projectId` and
   * dispatches a bubbling, composed `select` `CustomEvent`.
   */
  #onListClick = (event: Event): void => {
    const projectId = this.#resolveRowProjectId(event.target);
    if (projectId !== null) {
      this.#emitSelect(projectId);
    }
  };

  /**
   * Keyboard activation: Enter / Space on a focused row dispatches the
   * same `select` event a click would. Each row has `tabindex="0"`.
   */
  #onListKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const projectId = this.#resolveRowProjectId(event.target);
    if (projectId !== null) {
      event.preventDefault();
      this.#emitSelect(projectId);
    }
  };

  #emitSelect(projectId: string): void {
    // Persist the URL→Project mapping (Req 39.2, task 30.2) BEFORE emitting
    // the public `select` event so a downstream listener that immediately
    // re-enables the overlay can rely on the cache being seeded. The
    // `chrome.storage.local.set` round-trip is async but we initiate the
    // call synchronously here; the storage area itself serialises writes.
    // Errors are swallowed so a storage failure cannot break the user's
    // interaction with the picker.
    if (typeof window !== 'undefined' && typeof window.location !== 'undefined') {
      const { origin, pathname } = window.location;
      void rememberProject({ origin, pathname }, projectId).catch(() => {
        /* best-effort persistence — picker UX must not depend on storage */
      });
    }
    this.dispatchEvent(
      new CustomEvent<ProjectPickerSelectEventDetail>('select', {
        detail: { projectId },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

// Idempotent registration. Guarded so a duplicate import (HMR, repeated
// test bootstrap) does not throw "this name has already been used".
if (
  typeof customElements !== 'undefined' &&
  !customElements.get(FlProjectPicker.tagName)
) {
  withBoundary(FlProjectPicker.prototype, 'connectedCallback');
  customElements.define(FlProjectPicker.tagName, FlProjectPicker);
}

declare global {
  interface HTMLElementTagNameMap {
    'fl-project-picker': FlProjectPicker;
  }
}
