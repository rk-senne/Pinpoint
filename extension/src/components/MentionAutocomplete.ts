/**
 * `<fl-mention-autocomplete>` — leaf Web Component for the @mention dropdown.
 *
 * Implements task 17.4 (Requirement 31.3) of the pinpoint-app spec:
 *   - HTMLElement subclass + open Shadow Root
 *   - Adopts the shared stylesheet (constructable `CSSStyleSheet` with a
 *     `<style>` fallback for jsdom/older engines per design §35)
 *   - Receives `members` and `query` via property setters; on assignment,
 *     recomputes the filtered list by delegating to `filterMentionCandidates`
 *     in `lib/mentionFilter.ts` (intentionally untouched — Property 2 in
 *     `__tests__/properties/mentionFilter.property.test.ts` continues to
 *     hold against the underlying module)
 *   - Emits `select` `CustomEvent` (bubbling + composed) with
 *     `{ detail: { member } }` when a row is clicked
 *
 * Mirrors the shape of `<fl-annotation-pin>` / `<fl-comment-thread>`:
 * `#`-private fields, single `<template>` cloned per instance, idempotent
 * `customElements.define()` call guarded against duplicate registration so
 * HMR and repeated test imports do not throw.
 */
import { filterMentionCandidates, type MentionCandidate } from '../lib/mentionFilter';
import { adoptStyles } from '../styles/sharedStyleSheet';
import { withBoundary } from '../lib/withBoundary';

/**
 * Detail payload of the `select` `CustomEvent` dispatched when the user
 * clicks one of the dropdown rows. The full `MentionCandidate` is included
 * so the consumer (`<fl-popover>`) can substitute the chosen member into
 * the textarea without a second lookup.
 */
export interface MentionSelectEventDetail {
  member: MentionCandidate;
}

/**
 * Monotonic counter used to assign unique ids to the listbox / option
 * elements per task 33.2 (Req 42.1). The combobox input that opens the
 * dropdown points at these ids via `aria-controls` (the listbox id) and
 * `aria-activedescendant` (the highlighted option id), so screen readers
 * announce the active row even when DOM focus stays on the input.
 */
let mentionInstanceCounter = 0;

/**
 * Single shared `<template>` cloned by every instance. The list `<ol>`
 * is the only mutable region; rows are stamped into it on each render.
 *
 * `role="listbox"` per design §28 ARIA table; the runtime constructor
 * stamps a per-instance `id` so the consumer combobox can reference it
 * via `aria-controls`.
 */
const TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <ol class="fl-mention-dropdown" part="list" role="listbox" hidden></ol>
  `;
  return t;
})();

const ROW_TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <li class="fl-mention-item" role="option" aria-selected="false">
      <strong class="fl-mention-name"></strong>
      <span class="fl-mention-email"></span>
    </li>
  `;
  return t;
})();

export class FlMentionAutocomplete extends HTMLElement {
  static readonly tagName = 'fl-mention-autocomplete';

  #members: MentionCandidate[] = [];
  #query = '';
  #list!: HTMLOListElement;
  /**
   * Per-instance id stamped onto the listbox `<ol>` so the consumer
   * combobox (the popover textarea) can wire `aria-controls` and
   * `aria-activedescendant` to it. Exposed via `listboxId` and
   * `activeOptionId` getters.
   */
  #listboxId: string;
  /**
   * Currently highlighted option index within the filtered list. `-1`
   * when nothing is highlighted (the dropdown opens with the first row
   * pre-highlighted, but a fresh empty list has no highlight). The
   * highlight is independent of DOM focus — the textarea keeps focus
   * while the listbox tracks the active descendant.
   */
  #highlightedIndex = -1;
  /** Cached filtered list so keyboard navigation does not refilter. */
  #renderedFiltered: MentionCandidate[] = [];

  constructor() {
    super();
    mentionInstanceCounter += 1;
    this.#listboxId = `fl-mention-listbox-${mentionInstanceCounter}`;
    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    root.appendChild(TEMPLATE.content.cloneNode(true));

    this.#list = root.querySelector('ol.fl-mention-dropdown') as HTMLOListElement;
    this.#list.id = this.#listboxId;

    // One delegated click handler covers every row — saves attaching and
    // detaching listeners on every re-render.
    this.#list.addEventListener('click', this.#onListClick);
  }

  connectedCallback(): void {
    this.#render();
  }

  /**
   * Full member list. Setting triggers a re-filter and re-render; the
   * value is defensively copied so a later mutation by the caller does
   * not silently invalidate the rendered rows.
   */
  get members(): readonly MentionCandidate[] {
    return this.#members;
  }
  set members(next: readonly MentionCandidate[] | null | undefined) {
    this.#members = next ? [...next] : [];
    this.#render();
  }

  /**
   * Substring typed after `@`. Setting triggers a re-filter and re-render.
   */
  get query(): string {
    return this.#query;
  }
  set query(next: string | null | undefined) {
    this.#query = typeof next === 'string' ? next : '';
    this.#render();
  }

  /**
   * Currently filtered candidate list. Computed on each access by
   * delegating to `filterMentionCandidates` so the property-based test in
   * `__tests__/properties/mentionFilter.property.test.ts` continues to
   * govern the actual matching semantics.
   */
  get filtered(): MentionCandidate[] {
    return filterMentionCandidates(this.#members, this.#query);
  }

  /**
   * `id` of the inner `<ol role="listbox">`. Exposed so the consumer
   * combobox (the popover textarea) can wire `aria-controls` to it
   * (task 33.2 / Req 42.1).
   */
  get listboxId(): string {
    return this.#listboxId;
  }

  /**
   * `id` of the currently highlighted `<li role="option">`, or `null`
   * when no option is highlighted (empty list, dropdown closed). The
   * consumer combobox sets `aria-activedescendant` to this value so
   * screen readers announce the active row even though DOM focus stays
   * on the textarea.
   */
  get activeOptionId(): string | null {
    if (this.#highlightedIndex < 0) return null;
    if (this.#highlightedIndex >= this.#renderedFiltered.length) return null;
    return `${this.#listboxId}-option-${this.#highlightedIndex}`;
  }

  /**
   * Currently highlighted candidate, or `null` when nothing is highlighted.
   * Exposed for tests + the popover so it can resolve the row Enter
   * should activate without re-querying the DOM.
   */
  get highlightedMember(): MentionCandidate | null {
    if (this.#highlightedIndex < 0) return null;
    if (this.#highlightedIndex >= this.#renderedFiltered.length) return null;
    return this.#renderedFiltered[this.#highlightedIndex];
  }

  /**
   * Move the highlight up / down through the filtered list. Wraps at the
   * ends so a long list is reachable in either direction without paging.
   * No-ops when the dropdown is hidden / empty.
   */
  highlightNext(): void {
    if (this.#renderedFiltered.length === 0) return;
    const len = this.#renderedFiltered.length;
    const nextIndex =
      this.#highlightedIndex < 0 ? 0 : (this.#highlightedIndex + 1) % len;
    this.#setHighlight(nextIndex);
  }

  highlightPrev(): void {
    if (this.#renderedFiltered.length === 0) return;
    const len = this.#renderedFiltered.length;
    const nextIndex =
      this.#highlightedIndex < 0 ? len - 1 : (this.#highlightedIndex - 1 + len) % len;
    this.#setHighlight(nextIndex);
  }

  /**
   * Dispatch the `select` `CustomEvent` for the currently highlighted
   * option. Returns `true` when an event was dispatched (Enter handled),
   * `false` otherwise so the caller can fall through to default
   * behavior (e.g. inserting a newline in the textarea).
   */
  selectHighlighted(): boolean {
    const member = this.highlightedMember;
    if (!member) return false;
    this.dispatchEvent(
      new CustomEvent<MentionSelectEventDetail>('select', {
        detail: { member },
        bubbles: true,
        composed: true,
      }),
    );
    return true;
  }

  /**
   * Convenience entry point for a consumer combobox: forward a `KeyboardEvent`
   * captured on the textarea and let the listbox handle ArrowUp / ArrowDown
   * (move highlight), Enter (select), and Escape (close). Returns `true`
   * when the event was handled — the caller should `preventDefault()` /
   * `stopPropagation()` accordingly to keep the textarea from inserting
   * a newline or losing focus.
   */
  handleKeydown(event: KeyboardEvent): boolean {
    if (this.hidden || this.#renderedFiltered.length === 0) return false;
    switch (event.key) {
      case 'ArrowDown':
        this.highlightNext();
        return true;
      case 'ArrowUp':
        this.highlightPrev();
        return true;
      case 'Enter':
        return this.selectHighlighted();
      case 'Escape':
        this.hidden = true;
        this.dispatchEvent(
          new CustomEvent<void>('cancel', {
            bubbles: true,
            composed: true,
          }),
        );
        return true;
      default:
        return false;
    }
  }

  #setHighlight(index: number): void {
    if (index === this.#highlightedIndex) return;
    this.#highlightedIndex = index;
    this.#applyHighlight();
  }

  #applyHighlight(): void {
    const items = this.#list.querySelectorAll<HTMLLIElement>('li.fl-mention-item');
    items.forEach((li, idx) => {
      const selected = idx === this.#highlightedIndex;
      li.setAttribute('aria-selected', selected ? 'true' : 'false');
      li.classList.toggle('fl-mention-item-active', selected);
    });
  }

  #render(): void {
    const candidates = this.filtered;
    this.#renderedFiltered = candidates;

    // Hide the host element entirely when there is nothing to show —
    // matches the React version's `{showDropdown && candidates.length > 0}`
    // guard so the dropdown never paints an empty box.
    this.hidden = candidates.length === 0;

    this.#list.hidden = candidates.length === 0;
    this.#list.replaceChildren();
    candidates.forEach((m, idx) => {
      this.#list.appendChild(this.#renderRow(m, idx));
    });

    // Reset highlight to the first row whenever the list is rebuilt so
    // ArrowDown / Enter has a sensible default and `aria-activedescendant`
    // points at a real option. When the list is empty there is nothing
    // to highlight and `activeOptionId` returns `null`.
    this.#highlightedIndex = candidates.length > 0 ? 0 : -1;
    this.#applyHighlight();
  }

  #renderRow(member: MentionCandidate, index: number): DocumentFragment {
    const node = ROW_TEMPLATE.content.cloneNode(true) as DocumentFragment;
    const li = node.querySelector('li.fl-mention-item') as HTMLLIElement;
    const name = node.querySelector('.fl-mention-name') as HTMLElement;
    const email = node.querySelector('.fl-mention-email') as HTMLElement;

    li.id = `${this.#listboxId}-option-${index}`;
    li.dataset.userId = member.userId;
    li.dataset.optionIndex = String(index);
    name.textContent = member.name;
    if (member.email) {
      email.textContent = member.email;
    } else {
      email.remove();
    }
    return node;
  }

  /**
   * Delegated click handler for the `<ol>` list. Walks up from the click
   * target until it finds a `.fl-mention-item` row, resolves the matching
   * candidate by `userId`, and dispatches the `select` CustomEvent.
   *
   * Defined as an arrow-property so it has stable identity (no need to
   * `bind(this)`) and uses the element instance as `this`.
   */
  #onListClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;

    let node: Node | null = target;
    while (node && node !== this.#list) {
      if (node instanceof HTMLElement && node.classList.contains('fl-mention-item')) {
        const userId = node.dataset.userId;
        const member = this.#members.find((m) => m.userId === userId);
        if (member) {
          // Sync the highlight so a follow-up Enter / arrow-key sees the
          // clicked row as the starting point.
          const idx = Number.parseInt(node.dataset.optionIndex ?? '-1', 10);
          if (Number.isInteger(idx) && idx >= 0) {
            this.#setHighlight(idx);
          }
          this.dispatchEvent(
            new CustomEvent<MentionSelectEventDetail>('select', {
              detail: { member },
              bubbles: true,
              composed: true,
            }),
          );
        }
        return;
      }
      node = node.parentNode;
    }
  };
}

// Idempotent registration. Guarded so a duplicate import (HMR, repeated
// test bootstrap) does not throw "this name has already been used".
if (
  typeof customElements !== 'undefined' &&
  !customElements.get(FlMentionAutocomplete.tagName)
) {
  withBoundary(FlMentionAutocomplete.prototype, 'connectedCallback');
  customElements.define(FlMentionAutocomplete.tagName, FlMentionAutocomplete);
}

declare global {
  interface HTMLElementTagNameMap {
    'fl-mention-autocomplete': FlMentionAutocomplete;
  }
}
