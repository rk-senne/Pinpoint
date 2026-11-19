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
 * Mentions: the composer offers `<fl-mention-autocomplete>` over the
 * project `members`; `detail.mentions` carries USER IDS (what the API
 * resolves for notifications), not raw `@word` tokens.
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
import { upgradeShadowTree } from '../lib/upgradeShadowTree';
import { withBoundary } from '../lib/withBoundary';
import type { MentionCandidate } from '../lib/mentionFilter';
import './MentionAutocomplete';
import type { FlMentionAutocomplete, MentionSelectEventDetail } from './MentionAutocomplete';

const MENTION_REGEX = /@(\w+)/g;
/** The server resolves `@<uuid>` mentions (and the explicit list) to users. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // eslint-disable-next-line no-restricted-syntax -- static <template> markup built from module constants, no user data; parsed inertly
  t.innerHTML = `
    <ol class="fl-comment-thread" part="comments" hidden></ol>
    <div class="fl-comment-composer">
      <textarea
        class="fl-textarea"
        part="composer"
        placeholder="Add a comment… (type @ to mention)"
        aria-label="Add a comment"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="false"
        aria-haspopup="listbox"
      ></textarea>
      <fl-mention-autocomplete part="mention-autocomplete" hidden></fl-mention-autocomplete>
    </div>
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
  // eslint-disable-next-line no-restricted-syntax -- static <template> markup built from module constants, no user data; parsed inertly
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
  static readonly tagName = 'pp-comment-thread';

  #comments: FLComment[] = [];
  #members: MentionCandidate[] = [];
  /** Members picked from the autocomplete, keyed by the inserted `@Name`. */
  #picked = new Map<string, string>();
  #mentionStart = -1;
  #list!: HTMLOListElement;
  #textarea!: HTMLTextAreaElement;
  #submitBtn!: HTMLButtonElement;
  #mention!: FlMentionAutocomplete;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    root.appendChild(TEMPLATE.content.cloneNode(true));

    this.#list = root.querySelector('ol.fl-comment-thread') as HTMLOListElement;
    this.#textarea = root.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    this.#submitBtn = root.querySelector('button.fl-btn-primary') as HTMLButtonElement;
    this.#mention = root.querySelector('fl-mention-autocomplete') as FlMentionAutocomplete;
  }

  connectedCallback(): void {
    // Upgrade child Custom Elements BEFORE assigning their properties
    // (isolated-world polyfill upgrades late — see upgradeShadowTree.ts).
    upgradeShadowTree(this.shadowRoot);
    this.#textarea.addEventListener('input', this.#onInput);
    this.#submitBtn.addEventListener('click', this.#onSubmit);
    this.#textarea.addEventListener('keydown', this.#onKeydown);
    this.#mention.addEventListener('select', this.#onMentionSelect);
    this.#mention.addEventListener('cancel', this.#onMentionCancel);
    if (this.#mention.listboxId) {
      this.#textarea.setAttribute('aria-controls', this.#mention.listboxId);
    }
    this.#mention.members = this.#members;
    this.#mention.hidden = true;
    this.#renderList();
    this.#syncSubmitDisabled();
  }

  disconnectedCallback(): void {
    this.#textarea.removeEventListener('input', this.#onInput);
    this.#submitBtn.removeEventListener('click', this.#onSubmit);
    this.#textarea.removeEventListener('keydown', this.#onKeydown);
    this.#mention.removeEventListener('select', this.#onMentionSelect);
    this.#mention.removeEventListener('cancel', this.#onMentionCancel);
  }

  /**
   * Project members: offered by the composer's @mention autocomplete and
   * used to show comment authors by NAME (the API returns only
   * `authorId`, which used to be rendered verbatim as a UUID).
   */
  get members(): readonly MentionCandidate[] {
    return this.#members;
  }

  set members(next: readonly MentionCandidate[] | null | undefined) {
    this.#members = next ? [...next] : [];
    if (this.#mention) {
      this.#mention.members = this.#members;
      if (this.#mentionStart < 0) this.#mention.hidden = true;
    }
    if (this.isConnected) this.#renderList();
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
      author.textContent = this.#authorName(c.authorId);
      time.textContent = formatTime(c.createdAt);
      body.textContent = c.body;
      this.#list.appendChild(node);
    }
  }

  #syncSubmitDisabled(): void {
    this.#submitBtn.disabled = this.#textarea.value.trim().length === 0;
  }

  #authorName(authorId: string): string {
    const m = this.#members.find((x) => x.userId === authorId);
    if (m) return m.name || m.email;
    // Never show a raw UUID as a person's name.
    return UUID_RE.test(authorId) ? 'Former member' : authorId;
  }

  #onInput = (): void => {
    this.#syncSubmitDisabled();
    const ta = this.#textarea;
    const cursor = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, cursor);
    const lastAt = before.lastIndexOf('@');
    const query = lastAt >= 0 ? before.slice(lastAt + 1) : '';
    const atWordStart = lastAt === 0 || (lastAt > 0 && /\s/.test(before[lastAt - 1]));
    if (lastAt >= 0 && atWordStart && !/\s/.test(query) && this.#members.length > 0) {
      this.#mentionStart = lastAt;
      this.#mention.members = this.#members;
      this.#mention.query = query;
      this.#mention.hidden = false;
    } else {
      this.#mentionStart = -1;
      this.#mention.hidden = true;
    }
    this.#syncMentionAria();
  };

  #syncMentionAria(): void {
    const open = !this.#mention.hidden;
    this.#textarea.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  #onMentionSelect = (event: Event): void => {
    event.stopPropagation();
    const detail = (event as CustomEvent<MentionSelectEventDetail>).detail;
    if (!detail || this.#mentionStart < 0) return;
    const ta = this.#textarea;
    const queryEnd = this.#mentionStart + 1 + (this.#mention.query?.length ?? 0);
    const label = `@${detail.member.name}`;
    ta.value = `${ta.value.slice(0, this.#mentionStart)}${label} ${ta.value.slice(queryEnd)}`;
    this.#picked.set(label, detail.member.userId);
    const caret = this.#mentionStart + label.length + 1;
    ta.setSelectionRange?.(caret, caret);
    this.#mention.hidden = true;
    this.#mentionStart = -1;
    ta.focus();
    this.#syncMentionAria();
    this.#syncSubmitDisabled();
  };

  /** Escape in the dropdown dismisses it — NOT the surrounding popover. */
  #onMentionCancel = (event: Event): void => {
    event.stopPropagation();
    this.#mentionStart = -1;
    this.#mention.hidden = true;
    this.#textarea.focus();
    this.#syncMentionAria();
  };

  /**
   * Resolve the user ids mentioned in `body`: members picked from the
   * autocomplete whose `@Name` is still present, `@handle` tokens that match
   * a member's first name / email local-part, and raw `@<uuid>` tokens.
   */
  #resolveMentions(body: string): string[] {
    const ids = new Set<string>();
    for (const [label, userId] of this.#picked) {
      if (body.includes(label)) ids.add(userId);
    }
    for (const handle of extractMentions(body)) {
      if (UUID_RE.test(handle)) {
        ids.add(handle);
        continue;
      }
      const h = handle.toLowerCase();
      const m = this.#members.find(
        (x) =>
          x.name.split(/\s+/)[0]?.toLowerCase() === h ||
          x.name.replace(/\s+/g, '').toLowerCase() === h ||
          x.email.split('@')[0]?.toLowerCase() === h,
      );
      if (m) ids.add(m.userId);
    }
    return Array.from(ids);
  }

  #onKeydown = (e: KeyboardEvent): void => {
    if (!this.#mention.hidden && this.#mention.handleKeydown(e)) {
      e.preventDefault();
      e.stopPropagation();
      this.#syncMentionAria();
      return;
    }
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
    const mentions = this.#resolveMentions(trimmed);
    const detail: CommentThreadSubmitDetail = { body: trimmed, mentions };
    this.dispatchEvent(
      new CustomEvent<CommentThreadSubmitDetail>('submit', {
        detail,
        bubbles: true,
        composed: true,
      })
    );
    this.#textarea.value = '';
    this.#picked.clear();
    this.#mention.hidden = true;
    this.#mentionStart = -1;
    this.#syncMentionAria();
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
  const flCommentTag = FlCommentThread.tagName.replace('pp-', 'fl-');
  if (!customElements.get(flCommentTag)) {
    const LegacyComment = class extends FlCommentThread {};
    customElements.define(flCommentTag, LegacyComment);
  }
  // Legacy fl- alias for backwards compatibility (Mission E4)
  const legacy_FlCommentThread_tag = FlCommentThread.tagName.replace('pp-', 'fl-');
  if (!customElements.get(legacy_FlCommentThread_tag)) {
    const LegacyFlCommentThread = class extends FlCommentThread {};
    customElements.define(legacy_FlCommentThread_tag, LegacyFlCommentThread);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'fl-comment-thread': FlCommentThread;
  }
}
