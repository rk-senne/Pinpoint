/**
 * `<fl-comment-thread>` — Web Component conversion of the React
 * `CommentThread` (extension/src/components/CommentThread.tsx).
 *
 * Per task 17.5 of the pinpoint-app spec (Requirement 31.3):
 *   1. Receives `comments` via a property setter; on set, renders the list
 *      as an `<ol>` of comment templates (author, body, time).
 *   2. Below the list, renders a textarea + submit button.
 *   3. On submit, dispatches a `submit` `CustomEvent` (bubbling, composed)
 *      with `{ detail: { body, mentions } }`.
 *
 * Mention extraction reuses the same `/@(\w+)/g` regex as the legacy React
 * implementation so user-visible behavior is preserved (Req 31.5).
 *
 * The element follows the same Shadow DOM + adopted-stylesheet pattern as
 * the rest of the extension's Custom Elements:
 *   - Open Shadow Root
 *   - `adoptStyles(shadowRoot)` from `../styles/sharedStyleSheet`
 *   - A single `<template>` cloned on construction; subsequent renders
 *     swap the `<ol>` content in place (no React, no virtual DOM).
 */
import type { Comment as FLComment } from '@pinpoint/shared';
import { adoptStyles } from '../styles/sharedStyleSheet';
import { withBoundary } from '../lib/withBoundary';

const MENTION_REGEX = /@(\w+)/g;

/**
 * Detail payload of the `submit` `CustomEvent` dispatched on a successful
 * post. Consumers (e.g. `<fl-popover>`) read `detail.body` and
 * `detail.mentions` and persist the comment via the API client.
 */
export interface CommentThreadSubmitDetail {
  body: string;
  mentions: string[];
}

const TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <ol class="fl-comment-thread" part="comments" hidden></ol>
    <textarea
      class="fl-textarea"
      part="composer"
      placeholder="Add a comment…"
      aria-label="Add a comment"
    ></textarea>
    <div class="fl-btn-row">
      <button
        type="button"
        class="fl-btn fl-btn-primary"
        part="submit"
        disabled
      >Comment</button>
    </div>
  `;
  return t;
})();

/**
 * One comment row template. Cloned per comment so the element tree stays
 * declarative and there is no string-concatenation-driven HTML.
 */
const COMMENT_ITEM_TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <li class="fl-comment">
      <span class="fl-comment-author"></span>
      <span class="fl-comment-time"></span>
      <div class="fl-comment-body"></div>
    </li>
  `;
  return t;
})();

/**
 * Sort comments chronologically (ascending by `createdAt`). Defensive copy
 * so we do not mutate the caller's array. Invalid timestamps fall back to
 * `0`, matching the previous React behavior under `new Date(...)` of an
 * unparseable string.
 */
function sortChronologically(comments: readonly FLComment[]): FLComment[] {
  return [...comments].sort((a, b) => {
    const at = new Date(a.createdAt).getTime() || 0;
    const bt = new Date(b.createdAt).getTime() || 0;
    return at - bt;
  });
}

/** Extract `@handle` mentions from a comment body. */
function extractMentions(body: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // Reset regex state because it is module-scoped with the `g` flag.
  MENTION_REGEX.lastIndex = 0;
  while ((m = MENTION_REGEX.exec(body)) !== null) {
    out.push(m[1]);
  }
  return out;
}

export class FlCommentThread extends HTMLElement {
  static readonly tagName = 'fl-comment-thread';

  #comments: FLComment[] = [];
  #list!: HTMLOListElement;
  #textarea!: HTMLTextAreaElement;
  #submitBtn!: HTMLButtonElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    root.appendChild(TEMPLATE.content.cloneNode(true));

    this.#list = root.querySelector('ol.fl-comment-thread') as HTMLOListElement;
    this.#textarea = root.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    this.#submitBtn = root.querySelector('button.fl-btn-primary') as HTMLButtonElement;
  }

  connectedCallback(): void {
    this.#textarea.addEventListener('input', this.#onInput);
    this.#submitBtn.addEventListener('click', this.#onSubmit);
    this.#textarea.addEventListener('keydown', this.#onKeydown);
    this.#renderList();
    this.#syncSubmitDisabled();
  }

  disconnectedCallback(): void {
    this.#textarea.removeEventListener('input', this.#onInput);
    this.#submitBtn.removeEventListener('click', this.#onSubmit);
    this.#textarea.removeEventListener('keydown', this.#onKeydown);
  }

  /**
   * Public `comments` property. Assigning a new array re-renders the
   * `<ol>` in place. The element accepts any iterable of `FLComment` and
   * stores its own defensive copy.
   */
  get comments(): readonly FLComment[] {
    return this.#comments;
  }

  set comments(next: readonly FLComment[] | null | undefined) {
    this.#comments = next ? [...next] : [];
    if (this.isConnected) {
      this.#renderList();
    }
  }

  /** Read the current composer body (mostly for tests). */
  get value(): string {
    return this.#textarea?.value ?? '';
  }

  /** Set the composer body programmatically. */
  set value(next: string) {
    if (this.#textarea) {
      this.#textarea.value = next;
      this.#syncSubmitDisabled();
    }
  }

  #renderList(): void {
    const sorted = sortChronologically(this.#comments);
    // Replace the `<ol>` content in one pass.
    this.#list.replaceChildren();
    if (sorted.length === 0) {
      this.#list.hidden = true;
      return;
    }
    this.#list.hidden = false;
    for (const c of sorted) {
      const node = COMMENT_ITEM_TEMPLATE.content.cloneNode(true) as DocumentFragment;
      const li = node.querySelector('li') as HTMLLIElement;
      const author = node.querySelector('.fl-comment-author') as HTMLSpanElement;
      const time = node.querySelector('.fl-comment-time') as HTMLSpanElement;
      const body = node.querySelector('.fl-comment-body') as HTMLDivElement;

      li.dataset.commentId = c.id;
      author.textContent = c.authorId;
      time.textContent = formatTime(c.createdAt);
      body.textContent = c.body;
      this.#list.appendChild(node);
    }
  }

  #syncSubmitDisabled(): void {
    this.#submitBtn.disabled = this.#textarea.value.trim().length === 0;
  }

  #onInput = (): void => {
    this.#syncSubmitDisabled();
  };

  #onKeydown = (e: KeyboardEvent): void => {
    // Ctrl/Cmd+Enter submits — matches Req 42 a11y row in design.md
    // ("`<fl-comment-thread>` composer | Ctrl/Cmd+Enter submits"). The
    // legacy React implementation did not support this; adding it here
    // is purely additive and does not change any existing form field.
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      this.#onSubmit();
    }
  };

  #onSubmit = (): void => {
    const trimmed = this.#textarea.value.trim();
    if (!trimmed) return;
    const mentions = extractMentions(trimmed);
    const detail: CommentThreadSubmitDetail = { body: trimmed, mentions };
    this.dispatchEvent(
      new CustomEvent<CommentThreadSubmitDetail>('submit', {
        detail,
        bubbles: true,
        composed: true,
      })
    );
    this.#textarea.value = '';
    this.#syncSubmitDisabled();
  };
}

/**
 * Format an ISO 8601 timestamp the same way the React implementation did
 * (`new Date(...).toLocaleString()`), with a guard for unparseable values
 * so a malformed string never throws during render.
 */
function formatTime(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleString();
}

// Register the element. Guarded against duplicate registration so HMR /
// repeated module evaluation in tests does not throw.
if (typeof customElements !== 'undefined' && !customElements.get(FlCommentThread.tagName)) {
  withBoundary(FlCommentThread.prototype, 'connectedCallback');
  withBoundary(FlCommentThread.prototype, 'disconnectedCallback');
  customElements.define(FlCommentThread.tagName, FlCommentThread);
}

declare global {
  interface HTMLElementTagNameMap {
    'fl-comment-thread': FlCommentThread;
  }
}
