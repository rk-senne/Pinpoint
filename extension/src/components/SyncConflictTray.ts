/**
 * `<fl-sync-conflict-tray>` — Custom Element that renders the queue of
 * outbox entries the server rejected on replay (403/404/409).
 *
 * Lives inside `<fl-sidebar-panel>` above the Active / Resolved tabs so
 * the user sees rejected entries the moment they open the sidebar
 * (Req 44.4, design §"Sync Conflict Tray Reasons", task 36.5).
 *
 * Per row:
 *   - Severity dot + pin number / type / a body preview, mirroring the
 *     sidebar list rows so the user recognises which annotation the
 *     conflict belongs to.
 *   - The classified reason wording (per the design table) plus the
 *     server's `error.message` when available.
 *   - Three action buttons:
 *       * **Retry**   — `conflict-retry` event with `detail.localUuid`.
 *         The host calls `retryConflict()` which moves the entry back
 *         to the outbox so the next Syncer drain re-attempts it.
 *       * **Edit**    — `conflict-edit` event with `detail.conflict`.
 *         The host opens the popover prefilled with the original
 *         payload; on save it calls `editAndRetryConflict()`.
 *       * **Discard** — `conflict-discard` event with `detail.localUuid`.
 *         The host calls `discardConflict()` which drops the local
 *         copy.
 *
 * Storage subscription: when running inside a Chrome extension context
 * the element subscribes to `chrome.storage.onChanged` and re-renders
 * whenever the `pinpoint_sync_conflicts` key mutates. Tests (and
 * environments where `chrome.storage.onChanged` is missing) drive the
 * element by assigning the `conflicts` property directly.
 *
 * Implements: Requirement 44.4.
 */
import { adoptStyles } from '../styles/sharedStyleSheet';
import { withBoundary } from '../lib/withBoundary';
import {
  CONFLICT_STORAGE_KEY,
  listConflicts,
  type SyncConflict,
  type SyncConflictReason,
} from '../lib/SyncConflictTray';

/**
 * Detail payload shared by all three action events. `Retry` and
 * `Discard` only need the id; `Edit` ships the full conflict so the
 * popover can prefill from `entry.payload`.
 */
export interface ConflictActionEventDetail {
  localUuid: string;
}

/** Detail for the `edit` event — carries the full conflict row. */
export interface ConflictEditEventDetail extends ConflictActionEventDetail {
  conflict: SyncConflict;
}

/**
 * UX wording table per design §"Sync Conflict Tray Reasons". The
 * single source of truth lives here so a future server-side change
 * (e.g., a new conflict reason) only needs to be added in one place.
 */
const REASON_WORDING: Record<SyncConflictReason, string> = {
  forbidden: 'You no longer have permission to make this change.',
  not_found:
    'The annotation or comment this refers to no longer exists on the server.',
  conflict: 'Someone else updated this annotation while you were offline.',
  validation:
    'The server rejected the contents — likely the body is too long or required fields are missing.',
  unknown: 'Sync failed. We have kept your local copy.',
};

const TRAY_CSS = `
:host {
  display: block;
}
:host([hidden]) {
  display: none;
}
.fl-conflict-tray {
  border-bottom: 1px solid #e5e5e5;
  padding: 8px 16px 12px;
}
.fl-conflict-tray-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fl-severity-major, #d97706);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 8px;
}
.fl-conflict-tray-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fl-conflict-row {
  border: 1px solid #f0c674;
  background: #fff8e6;
  border-radius: 6px;
  padding: 8px 10px;
}
.fl-conflict-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.fl-conflict-kind {
  font-weight: 500;
  text-transform: capitalize;
}
.fl-conflict-status {
  margin-left: auto;
  font-size: 11px;
  color: #555;
}
.fl-conflict-reason {
  margin-top: 4px;
  font-size: 12px;
  color: #444;
}
.fl-conflict-server-message {
  margin-top: 2px;
  font-size: 11px;
  color: #777;
  font-style: italic;
}
.fl-conflict-actions {
  margin-top: 8px;
  display: flex;
  gap: 6px;
}
.fl-conflict-actions button {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid #c0c0c0;
  background: #fff;
  cursor: pointer;
}
.fl-conflict-actions button:hover {
  background: #f4f4f4;
}
.fl-conflict-actions button[data-action="discard"] {
  color: #b91c1c;
  border-color: #fca5a5;
}
`;

const TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <style>${TRAY_CSS}</style>
    <section
      class="fl-conflict-tray"
      part="tray"
      role="region"
      aria-label="Sync conflicts"
    >
      <div class="fl-conflict-tray-header">
        <span aria-hidden="true">⚠</span>
        <span class="fl-conflict-tray-title"></span>
      </div>
      <ul class="fl-conflict-tray-list" part="list"></ul>
    </section>
  `;
  return t;
})();

const ROW_TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <li class="fl-conflict-row" role="listitem">
      <div class="fl-conflict-row-head">
        <span class="fl-conflict-kind"></span>
        <span class="fl-conflict-status"></span>
      </div>
      <div class="fl-conflict-reason"></div>
      <div class="fl-conflict-server-message" hidden></div>
      <div class="fl-conflict-actions">
        <button type="button" data-action="retry">Retry</button>
        <button type="button" data-action="edit">Edit</button>
        <button type="button" data-action="discard">Discard</button>
      </div>
    </li>
  `;
  return t;
})();

export class FlSyncConflictTray extends HTMLElement {
  static readonly tagName = 'fl-sync-conflict-tray';

  #conflicts: SyncConflict[] = [];
  #section!: HTMLElement;
  #title!: HTMLElement;
  #list!: HTMLUListElement;
  #storageListener: Parameters<
    typeof chrome.storage.onChanged.addListener
  >[0] | null = null;
  /**
   * Monotonically incrementing token used to invalidate stale storage
   * refreshes. Every call to `#refreshFromStorage` captures the current
   * token; if a `set conflicts` (or a more recent refresh) bumps the
   * token while the storage promise is still pending, the resolved
   * value is discarded so the explicit property assignment wins.
   *
   * Without this, a synchronous `el.conflicts = [...]` right after
   * mount gets clobbered by the in-flight refresh that was kicked off
   * in `connectedCallback`.
   */
  #refreshToken = 0;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    root.appendChild(TEMPLATE.content.cloneNode(true));

    this.#section = root.querySelector('section.fl-conflict-tray') as HTMLElement;
    this.#title = root.querySelector('.fl-conflict-tray-title') as HTMLElement;
    this.#list = root.querySelector('ul.fl-conflict-tray-list') as HTMLUListElement;
  }

  connectedCallback(): void {
    this.#list.addEventListener('click', this.#onListClick);
    this.#subscribeStorage();
    // Seed initial state. If `chrome.storage.local` is unavailable we
    // still render whatever was set via the `conflicts` property.
    void this.#refreshFromStorage();
    this.#render();
  }

  disconnectedCallback(): void {
    this.#list.removeEventListener('click', this.#onListClick);
    this.#unsubscribeStorage();
  }

  /**
   * Public `conflicts` property. Assigning a new array re-renders the
   * tray and overrides whatever was last loaded from storage. Useful
   * for tests (and for the host to drive the tray from a higher-level
   * store if it ever wants to).
   */
  get conflicts(): readonly SyncConflict[] {
    return this.#conflicts;
  }

  set conflicts(next: readonly SyncConflict[] | null | undefined) {
    // Bump the refresh token so any in-flight storage load gets
    // discarded — an explicit property assignment is the latest word.
    this.#refreshToken += 1;
    this.#conflicts = next ? [...next] : [];
    if (this.shadowRoot) {
      this.#render();
    }
  }

  #subscribeStorage(): void {
    if (
      typeof chrome === 'undefined' ||
      !chrome.storage?.onChanged?.addListener
    ) {
      return;
    }
    this.#storageListener = (changes, areaName) => {
      if (areaName !== 'local') return;
      if (!(CONFLICT_STORAGE_KEY in changes)) return;
      void this.#refreshFromStorage();
    };
    chrome.storage.onChanged.addListener(this.#storageListener);
  }

  #unsubscribeStorage(): void {
    if (
      this.#storageListener &&
      typeof chrome !== 'undefined' &&
      chrome.storage?.onChanged?.removeListener
    ) {
      chrome.storage.onChanged.removeListener(this.#storageListener);
    }
    this.#storageListener = null;
  }

  async #refreshFromStorage(): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    this.#refreshToken += 1;
    const token = this.#refreshToken;
    try {
      const next = await listConflicts();
      // A more recent refresh or property assignment has happened
      // since this load started — drop the result rather than racing.
      if (token !== this.#refreshToken) return;
      this.#conflicts = next;
      this.#render();
    } catch {
      // Storage read failure — leave the in-memory list untouched.
    }
  }

  #render(): void {
    const count = this.#conflicts.length;
    if (count === 0) {
      // Hide the section entirely so the sidebar's tab list sits flush
      // with the header when there are no conflicts to show.
      this.#section.hidden = true;
      this.#list.replaceChildren();
      return;
    }
    this.#section.hidden = false;
    this.#title.textContent = `Sync conflicts (${count})`;

    this.#list.replaceChildren();
    for (const conflict of this.#conflicts) {
      this.#list.appendChild(this.#renderRow(conflict));
    }
  }

  #renderRow(conflict: SyncConflict): DocumentFragment {
    const node = ROW_TEMPLATE.content.cloneNode(true) as DocumentFragment;
    const li = node.querySelector('li.fl-conflict-row') as HTMLLIElement;
    const kind = node.querySelector('.fl-conflict-kind') as HTMLElement;
    const status = node.querySelector('.fl-conflict-status') as HTMLElement;
    const reason = node.querySelector('.fl-conflict-reason') as HTMLElement;
    const message = node.querySelector('.fl-conflict-server-message') as HTMLElement;

    li.dataset.localUuid = conflict.localUuid;
    li.id = `fl-conflict-${conflict.localUuid}`;

    // Translate the kind to a human label without a separate dictionary
    // — the kind already reads like English when hyphens become spaces.
    kind.textContent = conflict.entry.kind.replace(/-/g, ' ');
    status.textContent = `HTTP ${conflict.httpStatus}`;
    reason.textContent = REASON_WORDING[conflict.reason];

    if (conflict.serverMessage) {
      message.textContent = `Server: ${conflict.serverMessage}`;
      message.hidden = false;
    } else {
      message.textContent = '';
      message.hidden = true;
    }

    return node;
  }

  /**
   * Delegated click handler for the action buttons. Walks up from the
   * click target to find both the row (`.fl-conflict-row`) and the
   * button's `data-action` so a single listener serves all three
   * actions.
   */
  #onListClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest('button[data-action]') as HTMLButtonElement | null;
    if (!button) return;
    const row = button.closest('li.fl-conflict-row') as HTMLLIElement | null;
    if (!row) return;
    const localUuid = row.dataset.localUuid;
    if (!localUuid) return;
    const action = button.dataset.action;

    switch (action) {
      case 'retry':
        this.dispatchEvent(
          new CustomEvent<ConflictActionEventDetail>('conflict-retry', {
            detail: { localUuid },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      case 'discard':
        this.dispatchEvent(
          new CustomEvent<ConflictActionEventDetail>('conflict-discard', {
            detail: { localUuid },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      case 'edit': {
        const conflict = this.#conflicts.find(
          (c) => c.localUuid === localUuid,
        );
        if (!conflict) return;
        this.dispatchEvent(
          new CustomEvent<ConflictEditEventDetail>('conflict-edit', {
            detail: { localUuid, conflict },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
      default:
        return;
    }
  };
}

if (
  typeof customElements !== 'undefined' &&
  !customElements.get(FlSyncConflictTray.tagName)
) {
  withBoundary(FlSyncConflictTray.prototype, 'connectedCallback');
  withBoundary(FlSyncConflictTray.prototype, 'disconnectedCallback');
  customElements.define(FlSyncConflictTray.tagName, FlSyncConflictTray);
}

// NOTE: We intentionally use the `conflict-` prefix on the event names
// (`conflict-retry`, `conflict-edit`, `conflict-discard`) because the
// bare verbs collide with existing entries in `lib.dom.d.ts`'s
// `HTMLElementEventMap` (e.g. `change`, `error`) and the host element
// emits `close` already. Prefixing keeps the types disjoint and the
// listener semantics unambiguous.
declare global {
  interface HTMLElementTagNameMap {
    'fl-sync-conflict-tray': FlSyncConflictTray;
  }
  interface HTMLElementEventMap {
    'conflict-retry': CustomEvent<ConflictActionEventDetail>;
    'conflict-edit': CustomEvent<ConflictEditEventDetail>;
    'conflict-discard': CustomEvent<ConflictActionEventDetail>;
  }
}
