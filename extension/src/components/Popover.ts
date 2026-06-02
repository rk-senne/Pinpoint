/**
 * `<fl-popover>` — Web Component conversion of the React `PopoverController`
 * (extension/src/components/PopoverController.tsx).
 *
 * Per task 17.7 of the pinpoint-app spec (Requirement 31.3):
 *   1. HTMLElement subclass with an open Shadow Root + `adoptStyles()`.
 *   2. The Shadow Root hosts a native `<dialog>` for the popover panel.
 *      Per task 33.1 (Req 42.1, 42.2, 42.3) the dialog is opened via
 *      `showModal()` so we get the user-agent's native focus-trap and
 *      `Escape`-closes-dialog semantics for free. To keep our
 *      `(pageX, pageY+30)` anchoring working under modal mode — the UA
 *      would otherwise center the dialog with `margin: auto` — we set
 *      `dialog.style.margin = '0'` programmatically before each
 *      `showModal()` call and we override `dialog::backdrop` to be
 *      transparent so the page underneath is still visible. Older
 *      engines without `showModal` (some test runtimes) fall back to
 *      `setAttribute('open', '')`. Task 33.3 (Req 42.3) layers on
 *      explicit focus restore: just before `showModal()` we capture
 *      `document.activeElement` (descended through any open shadow
 *      roots) into `#previouslyFocused`, and on close — Escape, submit,
 *      cancel, or programmatic — `#restoreFocus` walks back to that
 *      element, falling through to the floating toolbar and finally
 *      `<body>` when the original target is gone or no longer
 *      focusable.
 *   3. Properties: `target`, `annotation`, `comments`, `members`,
 *      `nextPinNumber`. Each setter triggers a re-render of the affected
 *      regions; setting `target` to a non-null value opens the popover and
 *      `null` closes it.
 *   4. Tabs (Note / Suggestion / Guideline) at the top. Severity selector,
 *      textarea, and submit/cancel buttons in create mode (no annotation set).
 *      In view mode (annotation set) the body of the existing annotation,
 *      its environment-metadata `<details>`, an embedded
 *      `<fl-comment-thread>`, and resolve/reopen/close buttons render
 *      instead.
 *   5. The popover composes two leaf Custom Elements rather than slotting
 *      them via `<slot>` — keeps the orchestration self-contained:
 *        - `<fl-mention-autocomplete>` shown under the textarea when the
 *          user types `@…` (toggled by hooking `input` on the textarea).
 *        - `<fl-comment-thread>` rendered inside the view-mode section
 *          when `annotation` is set.
 *   6. Events (all `bubbles: true`, `composed: true` so they cross the
 *      Shadow Root boundary):
 *        - `submit`  — `{ detail: { annotation } }`. The detail is the
 *           freshly built `Annotation` including `environment` populated
 *           via `parseUserAgent(navigator.userAgent)` and then layered
 *           with `await detectBraveAndArcOverrides(meta)` (both helpers
 *           re-exported from `@pinpoint/shared`). Brave and Arc both
 *           masquerade as Chrome in the UA string, so the override pass
 *           is what lets us emit `browserFamily: 'Brave' | 'Arc'`. The
 *           submit event is dispatched on the next microtask after the
 *           click — the form clears synchronously so the user sees the
 *           dialog dismiss immediately. (Task 19.1, Req 17.1, 17.3.)
 *        - `cancel`  — fired when the cancel button is clicked.
 *        - `close`   — fired when the dialog's native `close` event fires
 *           (Escape key, the close button, or programmatic `.close()`).
 *        - `status-change` — `{ detail: { annotationId, status } }` fired
 *           by the resolve/reopen buttons. Not in the core three-event
 *           list but kept for parity with the legacy React component;
 *           consumers (the future `<fl-overlay-host>`) wire this through
 *           the API.
  *        - `comment-submit` — `{ detail: { annotationId, body, mentions } }`
 *           forwarded from the embedded `<fl-comment-thread>`.
 *        - `screenshot-error` — `{ detail: { annotationId, code, message } }`
 *           dispatched when the optional capture-and-upload pipeline
 *           (Req 34.1, task 25.3) fails. The annotation create has
 *           already succeeded by the time this fires; the event is
 *           informational so a host can surface a toast without
 *           rolling back any user data.
 *   7. Idempotent `customElements.define()` so HMR / repeated test imports
 *      do not throw "this name has already been used".
 *
 * Create-mode environment summary (task 19.2, Req 17.1, 17.5):
 *   The create section also shows a small badge/details panel below the
 *   textarea — `Will attach: Chrome 124 · macOS 14 · desktop` — populated by
 *   the same UA pipeline used at submit time:
 *     1. `parseUserAgent(navigator.userAgent)` synchronously on construct.
 *     2. `await detectBraveAndArcOverrides(meta)` so Brave/Arc are surfaced
 *        even though they masquerade as Chrome in the UA string.
 *   The badge is purely informational; the actual `environment` attached on
 *   submit is recomputed by the same helpers in `#dispatchSubmit` (so a
 *   refresh of `navigator.userAgent` between construct and submit can never
 *   leak a stale environment to the server).
 *   8. Co-viewer presence (Req 6.6, 6.7 — task 14.2):
 *        - The popover dispatches `annotation:open` (`{ detail: { id } }`)
 *          when it transitions into view-mode-with-an-open-dialog (target
 *          non-null AND annotation non-null), and `annotation:close`
 *          (`{ detail: { id } }`) when that state transitions away
 *          (annotation cleared, target cleared, dialog closed, or the
 *          element disconnected). Both events bubble + compose so the
 *          ancestor `<fl-overlay-host>` (task 17.8) can forward them onto
 *          the Socket.IO connection (`socket.emit('annotation:open', { id })`
 *          etc.). The popover does NOT touch the socket directly — that
 *          orchestration is the host's job.
 *        - A `viewers: string[]` property accepts the latest co-viewer
 *          list (typically `viewersByAnnotation[selectedAnnotationId]` from
 *          the overlay store). When non-empty, the popover header renders
 *          a row of initial-bubbles labelled "n viewing", one per id.
 *
 * Implements: Requirement 31.3, partial Requirements 6.6, 6.7.
 */
import type {
  Annotation,
  AnnotationStatus,
  AnnotationType,
  CapturedConsoleEntry,
  CapturedNetworkEntry,
  Comment as FLComment,
  DOMTarget,
  EnvironmentMetadata,
  Severity,
} from '@pinpoint/shared';
import { parseUserAgent, detectBraveAndArcOverrides } from '@pinpoint/shared';
import './MentionAutocomplete';
import './CommentThread';
import './ScreenshotViewer';
import './DisclosureModal';
import { adoptStyles } from '../styles/sharedStyleSheet';
import { withBoundary } from '../lib/withBoundary';
import type { FlMentionAutocomplete, MentionSelectEventDetail } from './MentionAutocomplete';
import type { FlCommentThread, CommentThreadSubmitDetail } from './CommentThread';
import type { FlScreenshotViewer } from './ScreenshotViewer';
import type { FlDisclosureModal } from './DisclosureModal';
import type { MentionCandidate } from '../lib/mentionFilter';
import { apiFetch, apiFetchRaw } from '../lib/api';
import { deleteDraft, loadDraft, saveDraft } from '../lib/draftStore';
import {
  readDisclosureSeen,
  writeDisclosureSeen,
} from '../lib/disclosureSeenStore';
import type { CaptureBuffer } from '../lib/CaptureBuffer';
import { computeRedactionRects, serializeRedactionRects } from '../lib/redaction';
import type { BoundingBox } from '../lib/redaction';
import type { FlMarkupEditor } from './MarkupEditor';

/**
 * `chrome.storage.local` key the popover uses to persist the user's
 * "Attach screenshot" preference between sessions (Req 34.2 / Task 25.4).
 * Read on `connectedCallback` so the toggle defaults to whatever the user
 * picked last time; written every time the `captureScreenshot` setter
 * fires so a peer popover (or a fresh page load) sees the same choice.
 */
const STORAGE_KEY_CAPTURE_PREF = 'fl_capture_screenshot_pref';

/**
 * Debounce window (ms) for the per-URL draft persistence pipeline
 * (Req 41.1, task 32.1). Every input/severity/tab change in the popover
 * schedules a `saveDraft` call after this delay; rapid successive
 * changes coalesce into a single `chrome.storage.session` write so we
 * never spam the storage area while the user is mid-keystroke.
 */
const DRAFT_DEBOUNCE_MS = 300;

/**
 * Decode a `data:image/png;base64,…` URL — what the service worker hands
 * back from `chrome.tabs.captureVisibleTab` — into a `Blob` we can attach
 * as the `image` field on the multipart upload (Req 34.1 / Task 25.3).
 * Returns `null` when the input is not a recognisable base64 dataURL so
 * the caller can surface a clean upload error rather than throwing
 * mid-flow.
 */
function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  const mime = match[1];
  const base64 = match[2];
  try {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

/**
 * Position + DOM-target descriptor used to anchor the popover and (when
 * creating a new annotation) build the resulting `Annotation.target`.
 * Compatible with the legacy `ResolvedTarget` shape produced by
 * `DOMTargetResolver.resolve`.
 */
export interface PopoverTarget {
  /** `pageX` of the anchor element's top-left in document coordinates. */
  pageX: number;
  /** `pageY` of the anchor element's top-left in document coordinates. */
  pageY: number;
  /**
   * The DOM-target descriptor stored on a new annotation. Required when
   * the popover is in create mode (no `annotation` property set); ignored
   * in view mode because the existing annotation already carries its own
   * `target`.
   */
  domTarget?: DOMTarget;
}

/** Detail payload of the `submit` `CustomEvent`. */
export interface PopoverSubmitDetail {
  annotation: Annotation;
}

/** Detail payload of the `status-change` `CustomEvent`. */
export interface PopoverStatusChangeDetail {
  annotationId: string;
  status: AnnotationStatus;
}

/** Detail payload of the `comment-submit` `CustomEvent`. */
export interface PopoverCommentSubmitDetail extends CommentThreadSubmitDetail {
  annotationId: string;
}

/**
 * Detail payload of the `screenshot-error` `CustomEvent`. The popover
 * dispatches this when the optional capture-and-upload pipeline (Req 34.1,
 * Task 25.3) fails — e.g. the service worker rejects the `chrome.tabs.
 * captureVisibleTab` call on a `chrome://` page, or the multipart upload
 * to `POST /api/v1/annotations/:id/screenshot` returns a non-2xx status.
 *
 * The annotation create flow has already succeeded by the time this fires
 * (the screenshot is uploaded after the annotation row exists), so the
 * event is purely informational: a host can show a toast / inline notice
 * without rolling back any user data.
 */
export interface PopoverScreenshotErrorDetail {
  annotationId: string;
  /** Stable error code so listeners can branch without parsing `message`. */
  code: 'capture-failed' | 'upload-failed' | 'unsupported';
  /** Human-readable explanation suitable for display in a toast. */
  message: string;
}

const TAB_OPTIONS: ReadonlyArray<{ value: AnnotationType; label: string }> = [
  { value: 'note', label: 'Note' },
  { value: 'suggestion', label: 'Suggestion' },
  { value: 'guideline', label: 'Guideline' },
];

const SEVERITY_OPTIONS: ReadonlyArray<{
  value: Severity;
  label: string;
  className: string;
}> = [
  { value: 'critical', label: 'Critical', className: 'fl-severity-critical' },
  { value: 'major', label: 'Major', className: 'fl-severity-major' },
  { value: 'minor', label: 'Minor', className: 'fl-severity-minor' },
  { value: 'informational', label: 'Info', className: 'fl-severity-informational' },
];

/**
 * Element-scoped CSS layered on top of the shared overlay stylesheet. We
 * only declare rules that touch the `<dialog>` defaults (border, padding,
 * UA-modal centering) and the autocomplete positioning; the rest of the
 * popover (`.fl-popover`, `.fl-popover-tabs`, `.fl-severity-*`, `.fl-btn`,
 * `.fl-textarea`) is already styled by the shared stylesheet so the palette
 * has a single source of truth (Req 26.1, design key decision #11).
 */
const POPOVER_CSS = `
:host { display: contents; }
dialog.fl-popover {
  border: none;
  background: #fff;
  padding: 16px;
  /* Defeat the user-agent's modal-centering for top-layer dialogs.
     showModal() (task 33.1) places the dialog in the top layer where the
     UA stylesheet applies margin: auto to center it; we want our inline
     style.left/top (set by #applyPosition) to win so the popover
     anchors at (pageX, pageY+30) like the legacy React placement. The
     #openDialog method also sets style.margin = '0' programmatically as
     a belt-and-braces guard against host pages that override these
     selectors. */
  margin: 0;
  /* The .fl-popover rule in the shared stylesheet already sets
     position:absolute, box-shadow, border-radius, min-width,
     pointer-events, and z-index. The rules above just neutralize the
     user-agent dialog defaults so the shared rule wins. */
}
dialog.fl-popover[open] { display: block; }
/* Transparent backdrop so the page underneath stays visible while the
   modal dialog has focus-trap + Escape semantics (Req 42.1, 42.2, 42.3). */
dialog.fl-popover::backdrop { background: transparent; }
.fl-popover-textarea-wrap { position: relative; }
.fl-popover-textarea-wrap fl-mention-autocomplete {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 1;
}
.fl-annotation-summary { margin-bottom: 8px; }
.fl-annotation-summary .fl-annotation-type { text-transform: capitalize; }
.fl-annotation-body { margin-bottom: 12px; white-space: pre-wrap; }
.fl-environment-details { margin-bottom: 8px; font-size: 12px; }
.fl-environment-details pre { font-size: 11px; white-space: pre-wrap; }
/* Captured Console / Network sections (Req 36.3, task 27.4).
   Both render below the environment <details> in view mode whenever the
   annotation carries a non-empty buffer. The list is monospace so log
   lines line up; max-height + scroll keeps a noisy buffer from making
   the popover taller than the viewport. */
.fl-capture-details { margin-bottom: 8px; font-size: 12px; }
.fl-capture-details[hidden] { display: none; }
.fl-capture-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  max-height: 180px;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  line-height: 1.4;
}
.fl-capture-list li {
  padding: 2px 4px;
  border-bottom: 1px solid #f0f0f0;
  word-break: break-word;
}
.fl-capture-list li:last-child { border-bottom: none; }
.fl-capture-console-level {
  display: inline-block;
  min-width: 36px;
  padding: 0 4px;
  margin-right: 6px;
  border-radius: 3px;
  text-transform: uppercase;
  font-weight: 600;
  font-size: 10px;
  color: #fff;
  background: #555;
}
.fl-capture-console-level[data-level="warn"] { background: #d97706; }
.fl-capture-console-level[data-level="error"] { background: #c53030; }
.fl-capture-console-time { color: #888; margin-right: 6px; }
.fl-capture-console-stack { margin: 4px 0 0; font-size: 10px; color: #666; }
.fl-capture-console-stack pre {
  white-space: pre-wrap;
  font-size: 10px;
  margin: 0;
  padding: 4px 6px;
  background: #f7f7f7;
  border-radius: 3px;
}
.fl-capture-network-method {
  display: inline-block;
  min-width: 36px;
  margin-right: 6px;
  font-weight: 600;
  color: #2c5282;
}
.fl-capture-network-status { color: #555; }
.fl-capture-network-status[data-bad="true"] { color: #c53030; font-weight: 600; }
/* Create-mode environment summary (task 19.2, Req 17.1, 17.5).
   A compact one-line badge rendered below the textarea/mentions block
   and above the button row so the user sees the browser/OS/device that
   will be attached on submit. The label text is filled in by
   #renderEnvironmentSummary() from the same parseUserAgent +
   Brave/Arc override pipeline used at submit time. */
.fl-environment-summary {
  display: block;
  margin: 6px 0 4px;
  padding: 4px 8px;
  background: #f5f5f5;
  color: #555;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
}
.fl-environment-summary[hidden] { display: none; }
.fl-environment-summary-label {
  font-weight: 600;
  color: #333;
  margin-right: 6px;
}
/* Co-viewer presence row (Req 6.6, 6.7). Rendered in the popover view-mode
   header beside the type/severity summary. Hidden when no other members
   are viewing the same annotation. */
.fl-popover-viewers {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 12px;
  color: #555;
}
.fl-popover-viewers[hidden] { display: none; }
.fl-popover-viewers-list {
  display: inline-flex;
  align-items: center;
}
.fl-popover-viewer-bubble {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #1a1a1a;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  margin-right: -6px;
  border: 2px solid #fff;
}
.fl-popover-viewer-bubble:last-child { margin-right: 0; }
.fl-popover-viewers-label { margin-left: 6px; }
/* Target-stale warning (Req 44.6, task 36.7). Rendered above the
   annotation summary in view mode whenever the optimistic pin's
   stored selector failed to re-resolve on Outbox replay — mirrors the
   warning ring on fl-annotation-pin[data-fallback="true"] so the
   pin and the popover surface the same signal. The element is kept
   in the template (rather than created on demand) so the focus
   trap inside <dialog> does not have to recompute its tabbable
   set on every render. */
.fl-target-stale-warning {
  display: block;
  margin-bottom: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  background: #fff8e1;
  border: 1px solid #f5c542;
  color: #5c4400;
  font-size: 12px;
  font-weight: 600;
}
.fl-target-stale-warning[hidden] { display: none; }
/* "Attach screenshot" toggle in the create-section button row (Req 34.2 /
   Task 25.4). Sits between the Cancel and Submit buttons so the
   per-annotation choice is one glance away from the action it modifies. */
.fl-popover-capture-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: auto;
  font-size: 12px;
  color: #444;
  cursor: pointer;
  user-select: none;
}
.fl-popover-capture-toggle input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
}
`;

const TEMPLATE = (() => {
  const t = document.createElement('template');
  // The dialog is built once and cloned per instance. We render BOTH
  // modes' DOM up-front and toggle visibility via the `hidden` attribute
  // on `.fl-popover-create` / `.fl-popover-view` — avoids re-stamping
  // templates on every state change and keeps the focus-trap target
  // (the `<dialog>`) stable.
  t.innerHTML = `
    <style>${POPOVER_CSS}</style>
    <dialog class="fl-popover" part="dialog" data-pinpoint="popover">
      <div class="fl-popover-tabs" role="tablist">
        ${TAB_OPTIONS.map(
          (tab) => `<button
              type="button"
              role="tab"
              data-tab="${tab.value}"
              aria-selected="false"
            >${tab.label}</button>`,
        ).join('')}
      </div>

      <section class="fl-popover-create" part="create" hidden>
        <div class="fl-severity-selector" role="radiogroup" aria-label="Severity">
          ${SEVERITY_OPTIONS.map(
            (s) => `<button
                type="button"
                class="fl-severity-btn ${s.className}"
                role="radio"
                data-severity="${s.value}"
                aria-checked="false"
                title="${s.label}"
                aria-label="Severity: ${s.label}"
              ></button>`,
          ).join('')}
        </div>
        <div class="fl-popover-textarea-wrap">
          <textarea
            class="fl-textarea"
            part="textarea"
            placeholder="Add your feedback…"
            aria-label="Annotation body"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="false"
            aria-haspopup="listbox"
          ></textarea>
          <fl-mention-autocomplete part="mention-autocomplete" hidden></fl-mention-autocomplete>
        </div>
        <div
          class="fl-environment-summary"
          part="environment-summary"
          role="note"
          aria-label="Environment that will be attached on submit"
        >
          <span class="fl-environment-summary-label">Will attach:</span>
          <span class="fl-environment-summary-text"></span>
        </div>
        <div class="fl-btn-row">
          <button
            type="button"
            class="fl-btn fl-btn-secondary"
            data-action="cancel"
          >Cancel</button>
          <label class="fl-popover-capture-toggle" part="capture-toggle">
            <input
              type="checkbox"
              class="fl-popover-capture-checkbox"
              data-action="capture-toggle"
              checked
            />
            <span>Attach screenshot</span>
          </label>
          <button
            type="button"
            class="fl-btn fl-btn-primary"
            data-action="submit"
            disabled
          >Submit</button>
        </div>
      </section>

      <section class="fl-popover-view" part="view" hidden>
        <div class="fl-popover-viewers" part="viewers" hidden>
          <span class="fl-popover-viewers-list" aria-label="Co-viewers"></span>
          <span class="fl-popover-viewers-label"></span>
        </div>
        <div class="fl-target-stale-warning" part="target-stale-warning" role="status" hidden>
          Target may have moved
        </div>
        <div class="fl-annotation-summary">
          <strong class="fl-annotation-type"></strong>
          <span class="fl-annotation-severity"></span>
        </div>
        <div class="fl-annotation-body"></div>
        <fl-screenshot-viewer
          class="fl-popover-screenshot"
          part="screenshot"
          hidden
        ></fl-screenshot-viewer>
        <details class="fl-environment-details" hidden>
          <summary>Browser metadata</summary>
          <pre class="fl-environment-pre"></pre>
        </details>
        <details class="fl-capture-details fl-capture-console-details" data-role="console-panel" hidden>
          <summary class="fl-capture-summary">Console (<span class="fl-capture-console-count">0</span>)</summary>
          <ul class="fl-capture-list fl-capture-console-list" data-role="console-list"></ul>
        </details>
        <details class="fl-capture-details fl-capture-network-details" data-role="network-panel" hidden>
          <summary class="fl-capture-summary">Network (<span class="fl-capture-network-count">0</span>)</summary>
          <ul class="fl-capture-list fl-capture-network-list" data-role="network-list"></ul>
        </details>
        <fl-comment-thread part="comment-thread"></fl-comment-thread>
        <div class="fl-btn-row">
          <button
            type="button"
            class="fl-btn fl-btn-primary fl-popover-resolve"
            data-action="resolve"
          >Resolve</button>
          <button
            type="button"
            class="fl-btn fl-btn-primary fl-popover-reopen"
            data-action="reopen"
            hidden
          >Reopen</button>
          <button
            type="button"
            class="fl-btn fl-btn-secondary"
            data-action="close"
          >Close</button>
        </div>
      </section>
    </dialog>
    <fl-disclosure-modal part="disclosure"></fl-disclosure-modal>
  `;
  return t;
})();

/**
 * Derive an initial-bubble label (1–2 chars) from a user id when the
 * popover does not have a member-name lookup. Falls back to "?" for empty
 * input. The host wires the proper initials via the same `viewers`
 * setter once it has the member directory loaded; this helper exists so
 * the popover stays useful with raw user ids during early load.
 */
function initialsFromId(id: string): string {
  if (!id) return '?';
  const trimmed = id.trim();
  if (!trimmed) return '?';
  // Favor the leading two alphanumerics so a UUID like
  // `a1b2c3d4-5678-…` renders as `A1`.
  const match = trimmed.match(/[a-zA-Z0-9]{1,2}/);
  return (match ? match[0] : trimmed.slice(0, 2)).toUpperCase();
}

/**
 * Format a `(family, version)` pair from `EnvironmentMetadata` for the
 * create-mode "Will attach" badge (task 19.2). Drops the family entirely
 * when it is the literal string `unknown` so the badge stays useful in
 * environments where Bowser couldn't classify the UA. Appends the
 * version with a leading space when present (e.g. `Chrome 124.0.6367.91`,
 * `macOS`).
 */
function formatFamilyAndVersion(family: string, version: string | null): string {
  if (!family || family === 'unknown') return '';
  if (version && version.length > 0) return `${family} ${version}`;
  return family;
}

/**
 * Build a `<li>` row for a captured console entry (Req 36.3, task 27.4).
 * Format: `[level] timestamp — message` with the stack folded into a
 * nested `<details>` when present so a noisy stack does not dominate the
 * popover. The level pill is colored via `data-level` so error / warn
 * pop visually without bloating the row.
 */
function renderConsoleEntry(entry: CapturedConsoleEntry): HTMLLIElement {
  const li = document.createElement('li');
  const level = document.createElement('span');
  level.className = 'fl-capture-console-level';
  level.dataset.level = entry.level;
  level.textContent = entry.level;
  const time = document.createElement('span');
  time.className = 'fl-capture-console-time';
  time.textContent = entry.timestamp;
  const message = document.createElement('span');
  message.className = 'fl-capture-console-message';
  message.textContent = ` — ${entry.message}`;
  li.appendChild(level);
  li.appendChild(time);
  li.appendChild(message);
  if (entry.stack && entry.stack.length > 0) {
    const stackDetails = document.createElement('details');
    stackDetails.className = 'fl-capture-console-stack';
    const stackSummary = document.createElement('summary');
    stackSummary.textContent = 'stack';
    const pre = document.createElement('pre');
    pre.textContent = entry.stack;
    stackDetails.appendChild(stackSummary);
    stackDetails.appendChild(pre);
    li.appendChild(stackDetails);
  }
  return li;
}

/**
 * Build a `<li>` row for a captured network entry (Req 36.3, task 27.4).
 * Format: `method? name (status, duration ms)` — the request method is
 * omitted when not present on the entry because `PerformanceObserver`
 * does not surface it on every Resource Timing record. Duration is
 * rounded to the nearest millisecond so the numbers stay readable.
 */
function renderNetworkEntry(entry: CapturedNetworkEntry): HTMLLIElement {
  const li = document.createElement('li');
  const method = (entry as { method?: string }).method;
  if (method) {
    const methodEl = document.createElement('span');
    methodEl.className = 'fl-capture-network-method';
    methodEl.textContent = method;
    li.appendChild(methodEl);
  }
  const name = document.createElement('span');
  name.className = 'fl-capture-network-name';
  name.textContent = entry.name;
  li.appendChild(name);
  const meta = document.createElement('span');
  meta.className = 'fl-capture-network-status';
  const statusText =
    typeof entry.responseStatus === 'number' ? String(entry.responseStatus) : '—';
  if (typeof entry.responseStatus === 'number' && entry.responseStatus >= 400) {
    meta.dataset.bad = 'true';
  }
  const durationMs = Math.round(entry.duration);
  meta.textContent = ` (${statusText}, ${durationMs} ms)`;
  li.appendChild(meta);
  return li;
}

/**
 * Walk down through every open shadow root to find the truly-focused
 * leaf element. `document.activeElement` only surfaces the shallowest
 * host when focus is inside a shadow tree, so a popover anchored to a
 * Custom Element on the page would otherwise capture the host element
 * instead of the inner `<input>` or `<button>` the user was actually on.
 *
 * Returns `null` when no element has focus (e.g. focus is on
 * `document.body`) — callers fall back to a sensible default in that
 * case (Req 42.3 / task 33.3).
 */
function deepActiveElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let current: Element | null = document.activeElement;
  // The browser parks focus on <body> when nothing else has it; treat
  // that the same as "no previous focus" so we restore to the toolbar /
  // body fallback rather than re-focusing <body> only to lose it again.
  if (!current || current === document.body || current === document.documentElement) {
    return null;
  }
  while (current && (current as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) {
    const inner: Element | null = (current as Element & { shadowRoot: ShadowRoot }).shadowRoot.activeElement;
    if (!inner) break;
    current = inner;
  }
  return current instanceof HTMLElement ? current : null;
}

/**
 * Decide whether `el` is a viable focus target on popover close
 * (Req 42.3 / task 33.3). The element must (a) still be connected to a
 * document, (b) expose a callable `focus()` method, and (c) not be a
 * disabled form control. Hidden / `display:none` ancestors are not
 * checked here because the browser silently no-ops `focus()` on them
 * and we want to fall through to the body/toolbar fallback rather than
 * silently land focus where no caret is visible.
 */
function isFocusable(el: HTMLElement | null): el is HTMLElement {
  if (!el) return false;
  if (typeof el.focus !== 'function') return false;
  if (!el.isConnected) return false;
  // Disabled form controls reject focus; querying `disabled` works for
  // <button>, <input>, <select>, <textarea>, <fieldset> in lib.dom.
  const maybeDisabled = el as HTMLElement & { disabled?: boolean };
  if (maybeDisabled.disabled === true) return false;
  return true;
}

export class FlPopover extends HTMLElement {
  static readonly tagName = 'fl-popover';

  // --- Public-property backing fields ---
  #target: PopoverTarget | null = null;
  #annotation: Annotation | null = null;
  #comments: FLComment[] = [];
  #members: MentionCandidate[] = [];
  #nextPinNumber = 1;
  /** Co-viewer user ids surfaced from the overlay store (Req 6.6, 6.7). */
  #viewers: string[] = [];
  /**
   * Whether the network is currently offline (Req 44.5 / task 36.6).
   * Driven by `<fl-overlay-host>` from `connectionMonitor.isOffline` —
   * the popover never reads `navigator.onLine` itself. When `true` AND
   * the current annotation is still unsynced (its `pinNumber === 0`),
   * the Resolve / Reopen buttons in view mode are disabled with an
   * "Cannot resolve while offline — pending sync" tooltip so the user
   * knows why the action is unavailable. Defaults to `false` (online).
   *
   * The "is unsynced" half of the gate is computed locally from the
   * annotation's `pinNumber` (the Syncer's 36.4 remap rewrites the
   * placeholder `0` written by `api.ts` to the server-assigned value
   * on success), so the host only has to forward one signal — the
   * connection state — into this property.
   */
  #isOffline = false;
  /**
   * Whether to capture a screenshot of the visible viewport on submit
   * (Req 34.1, 34.2 / Tasks 25.3, 25.4). Defaults to `true` so the
   * happy path matches the requirement; once `connectedCallback` resolves
   * the persisted preference from `chrome.storage.local` we update this in
   * place. The user can flip it via the per-annotation toggle in the
   * popover footer (task 25.4 wires the UI; this setter is independent so
   * tests can drive it directly).
   */
  #captureScreenshot = true;
  /**
   * Optional source of capture-buffer snapshots attached to bug-report
   * submissions (Req 36.2 / Task 27.3). When present, `#dispatchSubmit`
   * reads `getConsoleEntries()` / `getNetworkEntries()` and folds the
   * arrays into the outgoing `Annotation` for `type=note` submissions
   * with severity `critical` or `major`. Other tab/severity combos do
   * not include captures even when the source is set, so a Suggestion
   * never carries debug noise.
   *
   * Typed loosely (an object with the two getters) rather than as the
   * concrete `CaptureBuffer` class so tests can supply a stub without
   * pulling in the wrapped console / `PerformanceObserver`.
   */
  #captureBuffer: Pick<CaptureBuffer, 'getConsoleEntries' | 'getNetworkEntries'> | null =
    null;
  /**
   * Tracks whether we have most recently dispatched `annotation:open` for
   * the current annotation. Used to ensure exactly one paired
   * `annotation:close` is dispatched on transitions away (annotation
   * cleared, target cleared, dialog closed, element disconnected).
   */
  #presenceOpenForId: string | null = null;

  /**
   * Element that held DOM focus immediately before the dialog opened
   * (Req 42.3 / task 33.3). Captured at the top of `#openDialog` BEFORE
   * `dialog.showModal()` shifts focus into the modal so we have a stable
   * reference to the page element the user was working with.
   *
   * On close (Escape, submit, cancel, or programmatic) the popover walks
   * back to this element and calls `.focus()` so screen-reader / keyboard
   * users land where they were instead of at `document.body`. Cleared
   * after each restore so a stale reference cannot survive across open
   * cycles.
   *
   * Captured via a deep-active-element walk: `document.activeElement`
   * surfaces only the shallowest host when focus is inside a shadow tree,
   * so we descend through every `shadowRoot.activeElement` until we hit
   * the leaf — covers focus inside the page, inside another open shadow
   * tree, and the regular light-DOM case.
   */
  #previouslyFocused: HTMLElement | null = null;

  /**
   * Pending debounce timer id for `saveDraft` (Req 41.1, task 32.1).
   * Each input / severity / tab change cancels any in-flight timer and
   * schedules a fresh write 300 ms later, so rapid keystrokes coalesce
   * into a single `chrome.storage.session` round-trip. Cleared in
   * `disconnectedCallback` so a popover that is detached mid-debounce
   * does not leak the timer.
   */
  #draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Tracks the URL whose persisted draft has already been loaded into
   * the create-mode form (Req 41.2 / task 32.2). Set after a successful
   * prefill (or after we observed there is nothing to prefill) so a
   * second open of the popover on the same URL — without an intervening
   * navigation or submit — does not clobber the user's new keystrokes
   * with the stale value we just wrote out via `saveDraft`. Reset to
   * `null` on submit success (after `deleteDraft`) and on
   * `disconnectedCallback` so the next mount starts clean.
   */
  #draftHydratedForUrl: string | null = null;

  // --- Internal create-mode form state ---
  #activeTab: AnnotationType = 'note';
  #severity: Severity = 'informational';
  #mentionStart = -1;
  /**
   * Latest resolved `EnvironmentMetadata` for the create-mode "Will attach"
   * summary (task 19.2). Populated synchronously from
   * `parseUserAgent(navigator.userAgent)` on first connect, then refined by
   * `await detectBraveAndArcOverrides(meta)` on the next microtask.
   */
  #envSummary: EnvironmentMetadata | null = null;

  // --- Shadow-tree references (resolved in constructor) ---
  #dialog!: HTMLDialogElement;
  #createSection!: HTMLElement;
  #viewSection!: HTMLElement;
  #tabButtons!: HTMLButtonElement[];
  #severityButtons!: HTMLButtonElement[];
  #textarea!: HTMLTextAreaElement;
  #mentionAutocomplete!: FlMentionAutocomplete;
  #commentThread!: FlCommentThread;
  #cancelBtn!: HTMLButtonElement;
  #submitBtn!: HTMLButtonElement;
  #captureCheckbox!: HTMLInputElement;
  #resolveBtn!: HTMLButtonElement;
  #reopenBtn!: HTMLButtonElement;
  #viewCloseBtn!: HTMLButtonElement;
  #typeLabel!: HTMLElement;
  #severityLabel!: HTMLElement;
  #bodyView!: HTMLElement;
  #envDetails!: HTMLDetailsElement;
  #envPre!: HTMLElement;
  #viewersRow!: HTMLElement;
  #viewersList!: HTMLElement;
  #viewersLabel!: HTMLElement;
  /**
   * Target-stale warning row (Req 44.6, task 36.7). Rendered above the
   * annotation summary in view mode whenever the popover's annotation
   * carries `targetStale: true` — the Syncer flips that flag on Outbox
   * replay when the stored selector fails to re-resolve, mirroring
   * the warning ring on `<fl-annotation-pin data-fallback="true">`.
   */
  #targetStaleWarningRow!: HTMLElement;
  #screenshotViewer!: FlScreenshotViewer;
  /**
   * Create-mode environment summary row (task 19.2). Shows the
   * `EnvironmentMetadata` that will be attached on submit so the user can
   * verify what's being sent. Populated lazily on first connect via the
   * same `parseUserAgent` + Brave/Arc override pipeline used by
   * `#dispatchSubmit`.
   */
  #envSummaryRow!: HTMLElement;
  #envSummaryText!: HTMLElement;
  /**
   * Captured console / network sections (Req 36.3, task 27.4). Rendered
   * below the environment `<details>` whenever the annotation carries a
   * non-empty buffer; hidden otherwise. Each is a native `<details>` so
   * the host's user can collapse a noisy log without leaving the popover.
   */
  #consolePanel!: HTMLDetailsElement;
  #consoleList!: HTMLElement;
  #consoleCount!: HTMLElement;
  #networkPanel!: HTMLDetailsElement;
  #networkList!: HTMLElement;
  #networkCount!: HTMLElement;
  /**
   * One-time disclosure modal rendered the first time the popover opens
   * on a host (task 39.1, Req 47.1). Composed inside the popover's
   * Shadow Root rather than slotted so the open flow can intercept the
   * `target` setter and show the disclosure before the popover dialog.
   */
  #disclosureModal!: FlDisclosureModal;
  /**
   * Cached `disclosure-seen-${host}` flag for the current host (task 39.1,
   * Req 47.1). `null` means we have not yet read the flag from
   * `chrome.storage.sync`; once the read resolves we cache the boolean
   * so subsequent popover opens on the same host are instant. Reset to
   * `null` on host change (e.g. SPA navigation that updates
   * `window.location.host`) so the disclosure surfaces again on the new
   * host.
   */
  #disclosureSeen: boolean | null = null;
  /**
   * Cached host string the `#disclosureSeen` flag was read for. Used to
   * detect SPA navigations between hosts so a stale "seen" cached for
   * `a.example.com` does not suppress the disclosure on
   * `b.example.com`.
   */
  #disclosureSeenForHost: string | null = null;
  /**
   * Holds the most recent `target` setter call while the disclosure
   * modal is open. On `acknowledge` we re-enter `set target` with this
   * value so the popover dialog opens against the original anchor.
   */
  #pendingTarget: PopoverTarget | null = null;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    root.appendChild(TEMPLATE.content.cloneNode(true));

    this.#dialog = root.querySelector('dialog.fl-popover') as HTMLDialogElement;
    this.#createSection = root.querySelector('.fl-popover-create') as HTMLElement;
    this.#viewSection = root.querySelector('.fl-popover-view') as HTMLElement;
    this.#tabButtons = Array.from(
      root.querySelectorAll<HTMLButtonElement>('.fl-popover-tabs button[role="tab"]'),
    );
    this.#severityButtons = Array.from(
      root.querySelectorAll<HTMLButtonElement>('.fl-severity-btn'),
    );
    this.#textarea = root.querySelector('textarea.fl-textarea') as HTMLTextAreaElement;
    this.#mentionAutocomplete = root.querySelector(
      'fl-mention-autocomplete',
    ) as FlMentionAutocomplete;
    this.#commentThread = root.querySelector('fl-comment-thread') as FlCommentThread;
    this.#cancelBtn = root.querySelector(
      'button[data-action="cancel"]',
    ) as HTMLButtonElement;
    this.#submitBtn = root.querySelector(
      'button[data-action="submit"]',
    ) as HTMLButtonElement;
    this.#captureCheckbox = root.querySelector(
      'input.fl-popover-capture-checkbox',
    ) as HTMLInputElement;
    this.#resolveBtn = root.querySelector(
      'button[data-action="resolve"]',
    ) as HTMLButtonElement;
    this.#reopenBtn = root.querySelector(
      'button[data-action="reopen"]',
    ) as HTMLButtonElement;
    this.#viewCloseBtn = root.querySelector(
      'button[data-action="close"]',
    ) as HTMLButtonElement;
    this.#typeLabel = root.querySelector('.fl-annotation-type') as HTMLElement;
    this.#severityLabel = root.querySelector('.fl-annotation-severity') as HTMLElement;
    this.#bodyView = root.querySelector('.fl-annotation-body') as HTMLElement;
    this.#envDetails = root.querySelector(
      '.fl-environment-details',
    ) as HTMLDetailsElement;
    this.#envPre = root.querySelector('.fl-environment-pre') as HTMLElement;
    this.#viewersRow = root.querySelector('.fl-popover-viewers') as HTMLElement;
    this.#viewersList = root.querySelector(
      '.fl-popover-viewers-list',
    ) as HTMLElement;
    this.#viewersLabel = root.querySelector(
      '.fl-popover-viewers-label',
    ) as HTMLElement;
    this.#targetStaleWarningRow = root.querySelector(
      '.fl-target-stale-warning',
    ) as HTMLElement;
    this.#envSummaryRow = root.querySelector(
      '.fl-environment-summary',
    ) as HTMLElement;
    this.#envSummaryText = root.querySelector(
      '.fl-environment-summary-text',
    ) as HTMLElement;
    this.#consolePanel = root.querySelector(
      'details[data-role="console-panel"]',
    ) as HTMLDetailsElement;
    this.#consoleList = root.querySelector(
      '[data-role="console-list"]',
    ) as HTMLElement;
    this.#consoleCount = root.querySelector(
      '.fl-capture-console-count',
    ) as HTMLElement;
    this.#networkPanel = root.querySelector(
      'details[data-role="network-panel"]',
    ) as HTMLDetailsElement;
    this.#networkList = root.querySelector(
      '[data-role="network-list"]',
    ) as HTMLElement;
    this.#networkCount = root.querySelector(
      '.fl-capture-network-count',
    ) as HTMLElement;
    this.#screenshotViewer = root.querySelector(
      'fl-screenshot-viewer.fl-popover-screenshot',
    ) as FlScreenshotViewer;
    this.#disclosureModal = root.querySelector(
      'fl-disclosure-modal',
    ) as FlDisclosureModal;

    // Combobox/listbox ARIA wiring between the textarea and the
    // `<fl-mention-autocomplete>` it triggers (task 33.2 / Req 42.1) is
    // deferred to `connectedCallback`. Custom-element upgrades for
    // elements stamped from `<template>` contents happen lazily once
    // the host enters a connected document — querying `listboxId` from
    // the constructor would resolve to `undefined`. By the time the
    // popover connects, the inner autocomplete has been upgraded.
  }

  connectedCallback(): void {
    if (!this.hasAttribute('data-pinpoint')) {
      this.setAttribute('data-pinpoint', 'popover-host');
    }
    // Force-upgrade the inner mention-autocomplete now that the popover
    // host is in a connected document; without this the element stamped
    // from the template above remains an inert HTMLElement and the
    // `listboxId` getter returns `undefined`. `aria-controls` is set
    // here (rather than in the constructor) for the same reason.
    if (typeof customElements?.upgrade === 'function') {
      customElements.upgrade(this.#mentionAutocomplete);
    }
    this.#textarea.setAttribute(
      'aria-controls',
      this.#mentionAutocomplete.listboxId,
    );
    for (const btn of this.#tabButtons) {
      btn.addEventListener('click', this.#onTabClick);
    }
    for (const btn of this.#severityButtons) {
      btn.addEventListener('click', this.#onSeverityClick);
    }
    this.#textarea.addEventListener('input', this.#onTextInput);
    this.#textarea.addEventListener('keydown', this.#onTextareaKeydown);
    this.#mentionAutocomplete.addEventListener('select', this.#onMentionSelect);
    this.#mentionAutocomplete.addEventListener('cancel', this.#onMentionCancel);
    this.#cancelBtn.addEventListener('click', this.#onCancelClick);
    this.#submitBtn.addEventListener('click', this.#onSubmitClick);
    this.#captureCheckbox.addEventListener('change', this.#onCaptureToggleChange);
    this.#resolveBtn.addEventListener('click', this.#onResolveClick);
    this.#reopenBtn.addEventListener('click', this.#onReopenClick);
    this.#viewCloseBtn.addEventListener('click', this.#onViewCloseClick);
    this.#commentThread.addEventListener('submit', this.#onCommentSubmit);
    this.#dialog.addEventListener('close', this.#onDialogClose);
    this.#disclosureModal.addEventListener('acknowledge', this.#onDisclosureAcknowledge);
    this.#disclosureModal.addEventListener('open-settings', this.#onDisclosureOpenSettings);

    this.#renderTabs();
    this.#renderSeverity();
    // Show a synchronous (parseUserAgent-only) summary immediately so the
    // user sees what will be attached even before the async Brave/Arc
    // override pass settles. The async pass updates the badge in place.
    this.#renderEnvironmentSummary();
    void this.#refreshEnvironmentSummary();
    // Hydrate the persisted "Attach screenshot" preference (Req 34.2 /
    // Task 25.4). The hydration is best-effort — outside a browser
    // extension (jsdom tests, dashboard) `chrome.storage.local` is
    // undefined and we keep the default `true`.
    this.#syncCaptureCheckbox();
    void this.#hydrateCaptureScreenshotPref();
  }

  disconnectedCallback(): void {
    for (const btn of this.#tabButtons) {
      btn.removeEventListener('click', this.#onTabClick);
    }
    for (const btn of this.#severityButtons) {
      btn.removeEventListener('click', this.#onSeverityClick);
    }
    this.#textarea.removeEventListener('input', this.#onTextInput);
    this.#textarea.removeEventListener('keydown', this.#onTextareaKeydown);
    this.#mentionAutocomplete.removeEventListener('select', this.#onMentionSelect);
    this.#mentionAutocomplete.removeEventListener('cancel', this.#onMentionCancel);
    this.#cancelBtn.removeEventListener('click', this.#onCancelClick);
    this.#submitBtn.removeEventListener('click', this.#onSubmitClick);
    this.#captureCheckbox.removeEventListener('change', this.#onCaptureToggleChange);
    this.#resolveBtn.removeEventListener('click', this.#onResolveClick);
    this.#reopenBtn.removeEventListener('click', this.#onReopenClick);
    this.#viewCloseBtn.removeEventListener('click', this.#onViewCloseClick);
    this.#commentThread.removeEventListener('submit', this.#onCommentSubmit);
    this.#dialog.removeEventListener('close', this.#onDialogClose);
    this.#disclosureModal.removeEventListener('acknowledge', this.#onDisclosureAcknowledge);
    this.#disclosureModal.removeEventListener(
      'open-settings',
      this.#onDisclosureOpenSettings,
    );
    // Clear any in-flight draft-save debounce so a popover that is
    // detached mid-keystroke does not leak the timer (Req 41.1).
    if (this.#draftSaveTimer !== null) {
      clearTimeout(this.#draftSaveTimer);
      this.#draftSaveTimer = null;
    }
    // Clear the hydration latch so a re-mount on the same URL re-runs
    // the `loadDraft` round-trip (Req 41.2 / task 32.2). A re-mount
    // typically follows a navigation or page reload, and that is
    // exactly the case we want to prefill for.
    this.#draftHydratedForUrl = null;
    // Drop any captured focus reference so we don't hold an element
    // across reconnects (Req 42.3 / task 33.3). The host that re-opens
    // the popover will recapture from the live `document.activeElement`.
    this.#previouslyFocused = null;
    // Flush an outstanding presence claim so the host's listener emits
    // the matching `annotation:close` before the element is GC'd.
    if (this.#presenceOpenForId !== null) {
      this.dispatchEvent(
        new CustomEvent<{ id: string }>('annotation:close', {
          detail: { id: this.#presenceOpenForId },
          bubbles: true,
          composed: true,
        }),
      );
      this.#presenceOpenForId = null;
    }
  }

  // --- Public properties -----------------------------------------------------

  /**
   * Anchor target. Setting a non-null value opens the popover; setting
   * `null` closes it. The popover positions its `<dialog>` panel at
   * `(target.pageX, target.pageY + 30)` so it sits below the clicked element,
   * matching the legacy React `popoverStyle` offset.
   */
  get target(): PopoverTarget | null {
    return this.#target;
  }

  set target(next: PopoverTarget | null | undefined) {
    this.#target = next ?? null;
    if (this.#target) {
      this.#applyPosition(this.#target);
      // Disclosure gate (Req 47.1, task 39.1): on first popover open per
      // host (or after a settings change resets the seen-flag — task
      // 39.2), render the one-time disclosure modal instead of the
      // popover dialog. The disclosure modal's `acknowledge` event
      // re-enters this open path with the cached `#pendingTarget` so
      // the popover dialog ultimately opens against the original
      // anchor.
      //
      // Best-effort: when `chrome.storage.sync` is unavailable (jsdom
      // unit tests without a chrome stub, dashboard host) we treat the
      // disclosure as already seen so the popover behaves as before.
      if (this.#shouldGateOnDisclosure()) {
        this.#pendingTarget = this.#target;
        void this.#runDisclosureGate();
      } else {
        this.#openDialog();
        // On open in create mode (no annotation), look up any persisted
        // draft for the current URL and prefill the form. View mode does
        // not consume drafts — the existing annotation owns the textarea
        // content. Best-effort: failures inside `loadDraft` are swallowed
        // (see lib/draftStore.ts) so a storage outage cannot break the
        // open transition. (Req 41.2 / task 32.2.)
        if (this.#annotation === null) {
          void this.#hydrateDraft();
        }
      }
    } else {
      this.#pendingTarget = null;
      this.#disclosureModal.close();
      this.#closeDialogSilently();
    }
    this.#syncPresence();
  }

  /**
   * Annotation being viewed. `null` = create mode (form). Setting an
   * annotation switches the popover to view mode, populates the summary,
   * and re-renders the embedded comment thread.
   */
  get annotation(): Annotation | null {
    return this.#annotation;
  }

  set annotation(next: Annotation | null | undefined) {
    this.#annotation = next ?? null;
    if (this.#annotation) {
      this.#activeTab = this.#annotation.type;
      this.#severity = this.#annotation.severity;
      this.#renderTabs();
      this.#renderSeverity();
    }
    this.#renderMode();
    this.#renderCommentThread();
    this.#renderViewers();
    this.#syncPresence();
  }

  /** Comments shown in the embedded `<fl-comment-thread>` (view mode). */
  get comments(): readonly FLComment[] {
    return this.#comments;
  }

  set comments(next: readonly FLComment[] | null | undefined) {
    this.#comments = next ? [...next] : [];
    this.#renderCommentThread();
  }

  /** Project members surfaced to `<fl-mention-autocomplete>`. */
  get members(): readonly MentionCandidate[] {
    return this.#members;
  }

  set members(next: readonly MentionCandidate[] | null | undefined) {
    this.#members = next ? [...next] : [];
    this.#mentionAutocomplete.members = this.#members;
  }

  /** Pin number assigned to the new annotation when created. */
  get nextPinNumber(): number {
    return this.#nextPinNumber;
  }

  set nextPinNumber(next: number | null | undefined) {
    this.#nextPinNumber = typeof next === 'number' && Number.isFinite(next) ? next : 1;
  }

  /**
   * Co-viewer user ids for the currently-displayed annotation (Req 6.6,
   * 6.7). Typically the overlay host binds this to
   * `viewersByAnnotation[selectedAnnotationId]`. Setting this re-renders
   * the header bubble row in view mode; in create mode the bubbles are
   * hidden because there is no annotation id yet.
   */
  get viewers(): readonly string[] {
    return this.#viewers;
  }

  set viewers(next: readonly string[] | null | undefined) {
    this.#viewers = next ? [...next] : [];
    this.#renderViewers();
  }

  /**
   * Whether the network is currently offline (Req 44.5 / task 36.6).
   * Set by `<fl-overlay-host>` from the store's `isOffline` slice (which
   * is itself driven by `connectionMonitor`). Re-renders the view-mode
   * Resolve / Reopen buttons so they reflect the combined
   * (offline AND unsynced) gate without the host having to know which
   * surfaces care about offline state. Reading `navigator.onLine`
   * directly would couple the popover to the connection monitor's
   * heuristics; routing through the host keeps the source of truth in
   * one place.
   */
  get isOffline(): boolean {
    return this.#isOffline;
  }

  set isOffline(next: boolean | null | undefined) {
    const value = next === true;
    if (value === this.#isOffline) return;
    this.#isOffline = value;
    this.#renderResolveReopen();
  }

  /**
   * Convenience read: whether the currently-displayed annotation is
   * still pending a server replay (Req 44.5 / task 36.6). Computed from
   * `annotation.pinNumber === 0` — the placeholder sentinel `api.ts`
   * writes onto the optimistic row at create time. The Syncer's 36.4
   * remap rewrites `pinNumber` to the server-assigned value on success,
   * so a value of `0` is a reliable "still in the outbox" signal.
   * Returns `false` in create mode (no annotation) so callers can
   * combine it with `isOffline` without nullable plumbing.
   */
  get isUnsynced(): boolean {
    const a = this.#annotation;
    return a !== null && a.pinNumber === 0;
  }

  /**
   * Whether the popover should request a screenshot of the visible
   * viewport on submit and upload it via
   * `POST /api/v1/annotations/:id/screenshot` (Req 34.1, 34.2).
   *
   * Defaults to `true`. The setter persists the choice to
   * `chrome.storage.local.fl_capture_screenshot_pref` so the next popover
   * (or the next page load) defaults to the user's last selection. The
   * persistence call is fire-and-forget and silently no-ops outside a
   * browser-extension context (e.g. jsdom unit tests) — failures here
   * must never break annotation creation.
   */
  get captureScreenshot(): boolean {
    return this.#captureScreenshot;
  }

  set captureScreenshot(next: boolean | null | undefined) {
    const value = next === undefined || next === null ? true : Boolean(next);
    if (value === this.#captureScreenshot) return;
    this.#captureScreenshot = value;
    void this.#persistCaptureScreenshotPref(value);
  }

  /**
   * Source of console + network capture snapshots attached to bug-report
   * submissions (Req 36.2 / Task 27.3). The host (`<fl-overlay-host>`)
   * sets this to the live `CaptureBuffer` instance once mounted; tests
   * can pass a stub exposing `getConsoleEntries()` / `getNetworkEntries()`.
   *
   * The popover never starts or stops the buffer — it only reads
   * snapshots at submit time. Setting `null` disables capture
   * forwarding entirely (the resulting annotation has no
   * `capturedConsole` / `capturedNetwork` fields).
   */
  get captureBuffer():
    | Pick<CaptureBuffer, 'getConsoleEntries' | 'getNetworkEntries'>
    | null {
    return this.#captureBuffer;
  }

  set captureBuffer(
    next:
      | Pick<CaptureBuffer, 'getConsoleEntries' | 'getNetworkEntries'>
      | null
      | undefined,
  ) {
    this.#captureBuffer = next ?? null;
  }

  // --- Render helpers --------------------------------------------------------

  /**
   * Resolve the current host string used to namespace the
   * disclosure-seen flag. Returns the empty string when
   * `window.location` is unavailable (e.g. unit tests without jsdom);
   * the gate falls through in that case so the popover behaves
   * exactly as before.
   */
  #currentHost(): string {
    if (typeof window === 'undefined' || !window.location) return '';
    return (window.location.host ?? '').trim();
  }

  /**
   * Read access to the `chrome.storage.sync.get` surface, returning
   * `null` when it is not available (jsdom without a chrome stub, the
   * dashboard host, or any environment where the user has explicitly
   * disabled sync storage). Callers fall through to the
   * legacy / non-disclosure path when this returns `null`.
   */
  #syncStorage(): chrome.storage.StorageArea | null {
    const c = (globalThis as unknown as { chrome?: typeof chrome }).chrome;
    const area = c?.storage?.sync;
    if (!area || typeof area.get !== 'function' || typeof area.set !== 'function') {
      return null;
    }
    return area;
  }

  /**
   * Whether the popover open flow should detour through the disclosure
   * modal before showing the dialog. Returns `false` when:
   *   - `chrome.storage.sync` is unavailable (no chrome stub in tests,
   *     dashboard host) — preserves existing behavior.
   *   - The host is empty (no `window.location`) — same fallback.
   *   - The flag is cached as `true` for the current host — disclosure
   *     has already been acknowledged in this session.
   *   - The disclosure modal is already open — re-entrant guard.
   */
  #shouldGateOnDisclosure(): boolean {
    if (this.#disclosureModal.open) return false;
    if (this.#syncStorage() === null) return false;
    const host = this.#currentHost();
    if (!host) return false;
    if (this.#disclosureSeen === true && this.#disclosureSeenForHost === host) {
      return false;
    }
    return true;
  }

  /**
   * Async disclosure-gate orchestration. Reads the persisted seen-flag
   * from `chrome.storage.sync` via `readDisclosureSeen` (task 39.2);
   * on hit the cached value is updated and the popover dialog opens
   * normally. On miss the disclosure modal is shown and the popover
   * dialog stays closed until the user clicks "Acknowledge".
   */
  async #runDisclosureGate(): Promise<void> {
    const host = this.#currentHost();
    const area = this.#syncStorage();
    if (area === null || !host) {
      // Defensive: caller should have gated on these already, but a
      // race (e.g. chrome stub stripped between checks) must not block
      // the popover.
      this.#proceedAfterDisclosure();
      return;
    }
    const seen = await readDisclosureSeen(host);
    this.#disclosureSeen = seen;
    this.#disclosureSeenForHost = host;
    if (this.#pendingTarget === null) {
      // The user closed the popover (target=null) while we were
      // waiting on the storage round-trip. Bail without opening
      // anything.
      return;
    }
    if (seen) {
      this.#proceedAfterDisclosure();
    } else {
      this.#disclosureModal.show();
    }
  }

  /**
   * Open the popover dialog with the previously-cached pending target.
   * Called either directly from the synchronous open path, or after
   * the user acknowledges the disclosure modal.
   */
  #proceedAfterDisclosure(): void {
    const target = this.#pendingTarget ?? this.#target;
    if (!target) return;
    this.#pendingTarget = null;
    this.#openDialog();
    if (this.#annotation === null) {
      void this.#hydrateDraft();
    }
  }

  /**
   * "Acknowledge" handler for the disclosure modal (Req 47.1, task
   * 39.1). Persists the seen-flag to `chrome.storage.sync` via
   * `writeDisclosureSeen` (task 39.2) and continues to the popover
   * dialog. The write is best-effort: a storage failure inside the
   * helper is swallowed so the popover never stays stuck behind a
   * broken `chrome.storage.sync`. The next mount will simply re-prompt.
   */
  #onDisclosureAcknowledge = (): void => {
    const host = this.#currentHost();
    if (host) {
      // Fire-and-forget: a storage failure inside the helper is
      // swallowed; the cache update below keeps the same-session
      // popover open flow snappy.
      void writeDisclosureSeen(host, true);
      this.#disclosureSeen = true;
      this.#disclosureSeenForHost = host;
    }
    this.#proceedAfterDisclosure();
  };

  /**
   * "Open Settings" handler for the disclosure modal. The modal itself
   * calls `chrome.runtime.openOptionsPage()` directly when the runtime
   * API is available (task 39.3, Req 47.2); this handler simply
   * forwards the event onto the popover host so consumers do not have
   * to listen on the disclosure modal directly. The forwarded
   * `disclosure-open-settings` event bubbles + composes so the
   * `<fl-overlay-host>` can react regardless of whether the runtime
   * call succeeded (e.g. the popover host might also dismiss its own
   * UI when the user navigates to the options page).
   */
  #onDisclosureOpenSettings = (): void => {
    this.dispatchEvent(
      new CustomEvent<Record<string, never>>('disclosure-open-settings', {
        detail: {},
        bubbles: true,
        composed: true,
      }),
    );
  };

  #applyPosition(target: PopoverTarget): void {
    // Inline `style` overrides the user-agent dialog centering. The +30px
    // vertical offset matches the legacy React `popoverStyle = { left,
    // top: pageY + 30 }`. Width / max-height come from the shared stylesheet.
    this.#dialog.style.left = `${target.pageX}px`;
    this.#dialog.style.top = `${target.pageY + 30}px`;
  }

  #openDialog(): void {
    if (this.#dialog.open) return;
    // Capture the element that held focus BEFORE we show the modal —
    // showModal() will move focus inside the dialog, so anything we
    // read after this point would be a control inside the popover
    // (defeating the point of "restore on close"). Walk through open
    // shadow roots so a focused control inside another Custom Element
    // is captured at the leaf, not at its host (Req 42.3 / task 33.3).
    this.#previouslyFocused = deepActiveElement();
    // Open as a modal so we get the platform's native focus-trap and
    // `Escape`-closes-dialog semantics for free (Req 42.1, 42.2, 42.3 /
    // task 33.1). The user-agent stylesheet for top-layer dialogs applies
    // `margin: auto` to center the panel, which would override our inline
    // `style.left/top` anchoring; pin `margin: 0` programmatically so our
    // `(pageX, pageY+30)` placement wins. The `dialog::backdrop` is
    // styled transparent in `POPOVER_CSS` so the page underneath stays
    // visible.
    if (typeof this.#dialog.showModal === 'function') {
      try {
        this.#dialog.style.margin = '0';
        this.#dialog.showModal();
        return;
      } catch {
        // jsdom and some older engines throw or no-op on `showModal()` —
        // fall through to the attribute-based fallback so the rest of the
        // popover (rendering, events) keeps working in those runtimes.
      }
    }
    this.#dialog.setAttribute('open', '');
  }

  /**
   * Close the dialog without dispatching a `close` event. We use this when
   * the popover is closed because `target` was set to `null` (the host
   * already knows the popover is closing) or when we're about to dispatch
   * a more specific event (`submit`, `cancel`).
   */
  #closeDialogSilently(): void {
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
    // Restore focus to whoever was focused before we opened — this path
    // covers cancel, submit, and target=null close (Req 42.3 / task
    // 33.3). The native `close` event handler runs the same restore so
    // Escape and external `dialog.close()` are also covered.
    this.#restoreFocus();
    // Dialog is now closed — drop any in-flight presence claim so the
    // host emits the matching `annotation:close` even when it does not
    // immediately reset `target`.
    this.#syncPresence();
  }

  /**
   * Walk back to the element that held focus when the dialog opened and
   * call `.focus()` on it. Falls back to the floating toolbar (the
   * persistent overlay control) and finally `document.body` when the
   * captured element is no longer focusable — disabled, removed from
   * the DOM, or never captured. Always clears `#previouslyFocused`
   * before returning so the next open cycle starts clean (Req 42.3 /
   * task 33.3).
   *
   * Defensive against:
   *   - jsdom / SSR: returns early when `document` is missing.
   *   - The captured element being removed from the DOM mid-dialog
   *     (e.g. the host re-rendered while the popover was open).
   *   - The captured element becoming disabled while the dialog was
   *     open (a form control toggled by another script).
   */
  #restoreFocus(): void {
    const previous = this.#previouslyFocused;
    this.#previouslyFocused = null;
    if (typeof document === 'undefined') return;
    if (isFocusable(previous)) {
      try {
        previous.focus();
        return;
      } catch {
        // Some elements (cross-origin iframes, detached subtrees) reject
        // focus() with a SecurityError — fall through to the toolbar
        // fallback rather than crash the close path.
      }
    }
    // Fallback target #1: the floating toolbar, which is the persistent
    // overlay control surface a keyboard user can navigate from. The
    // popover lives in the `<fl-overlay-host>`'s shadow root, so the
    // toolbar is a sibling inside the same root — `getRootNode()`
    // returns that shadow root (or `document` when the popover was
    // mounted at the page level for a test). We search the containing
    // root first and fall back to the document only when the toolbar is
    // hosted somewhere unusual.
    const root = this.getRootNode();
    let toolbar: HTMLElement | null = null;
    if (
      root instanceof ShadowRoot ||
      root instanceof Document ||
      root instanceof DocumentFragment
    ) {
      toolbar = (root as ParentNode).querySelector<HTMLElement>(
        'fl-floating-toolbar',
      );
    }
    if (!isFocusable(toolbar)) {
      toolbar = document.querySelector<HTMLElement>('fl-floating-toolbar');
    }
    if (isFocusable(toolbar)) {
      try {
        toolbar.focus();
        return;
      } catch {
        /* fall through */
      }
    }
    // Fallback target #2: <body>. Setting tabindex=-1 first so .focus()
    // is honored even when the body has no intrinsic focusability —
    // Chrome/Firefox accept this; jsdom no-ops harmlessly.
    const body = document.body;
    if (body) {
      try {
        body.focus();
      } catch {
        /* nothing more to do */
      }
    }
  }

  #renderTabs(): void {
    const isViewing = this.#annotation !== null;
    for (const btn of this.#tabButtons) {
      const value = btn.dataset.tab as AnnotationType;
      const active = value === this.#activeTab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
      btn.disabled = isViewing;
    }
  }

  #renderSeverity(): void {
    for (const btn of this.#severityButtons) {
      const value = btn.dataset.severity as Severity;
      const selected = value === this.#severity;
      btn.classList.toggle('selected', selected);
      btn.setAttribute('aria-checked', String(selected));
    }
  }

  #renderMode(): void {
    const viewing = this.#annotation !== null;
    this.#createSection.hidden = viewing;
    this.#viewSection.hidden = !viewing;
    if (viewing && this.#annotation) {
      this.#typeLabel.textContent = this.#annotation.type;
      this.#severityLabel.textContent = ` — ${this.#annotation.severity}`;
      this.#bodyView.textContent = this.#annotation.body;
      // Task 36.7 / Req 44.6 — surface the "Target may have moved"
      // notice when the Syncer flagged this annotation's pin as
      // stale on Outbox replay. Done here (not in #renderViewers)
      // so a future swap from view-mode to a different annotation
      // resets the warning naturally.
      this.#targetStaleWarningRow.hidden = this.#annotation.targetStale !== true;
      const env = this.#annotation.environment;
      if (env) {
        this.#envDetails.hidden = false;
        this.#envPre.textContent = JSON.stringify(env, null, 2);
      } else {
        this.#envDetails.hidden = true;
      }
      this.#renderCaptureBuffers();
      this.#renderResolveReopen();
      this.#renderScreenshot();
    } else {
      this.#targetStaleWarningRow.hidden = true;
      this.#screenshotViewer.imageUrl = null;
      this.#screenshotViewer.annotationId = null;
      this.#screenshotViewer.markupDocument = null;
      this.#screenshotViewer.hidden = true;
      this.#consolePanel.hidden = true;
      this.#consoleList.replaceChildren();
      this.#networkPanel.hidden = true;
      this.#networkList.replaceChildren();
    }
  }

  /**
   * Wire the embedded `<fl-screenshot-viewer>` to the current annotation
   * (Req 35.2 / Task 26.2). When the annotation has a screenshot, the
   * viewer fetches the sibling Markup_Document from
   * `/api/v1/annotations/:id/markup` (best-effort — a missing markup
   * still shows the bare PNG) and overlays the SVG client-side.
   */
  #renderScreenshot(): void {
    const a = this.#annotation;
    if (!a || !a.screenshotObjectKey) {
      this.#screenshotViewer.imageUrl = null;
      this.#screenshotViewer.annotationId = null;
      this.#screenshotViewer.hidden = true;
      return;
    }
    void this.#resolveScreenshotUrl(a.id);
    this.#screenshotViewer.annotationId = a.id;
    this.#screenshotViewer.hidden = false;
  }

  #renderResolveReopen(): void {
    const a = this.#annotation;
    if (!a) return;
    const isResolved = a.status === 'resolved';
    this.#resolveBtn.hidden = isResolved;
    this.#reopenBtn.hidden = !isResolved;

    // Offline + unsynced gate (Req 44.5 / task 36.6). Both actions PUT
    // to `/annotations/:id/status` which the server cannot process for
    // a row that has not yet been created (its `id` is still a local
    // UUID and `pinNumber === 0`). When the connection monitor reports
    // offline AND the annotation is still pending replay, disable both
    // buttons and surface the reason via `title` / `aria-disabled` so
    // screen-reader users get the same explanation as sighted users
    // hovering the button. We always reset the disabled / tooltip
    // state on the online or synced path so a previous offline render
    // does not linger after reconnect.
    const blocked = this.#isOffline && this.isUnsynced;
    const reason = 'Cannot resolve while offline — pending sync';
    for (const btn of [this.#resolveBtn, this.#reopenBtn]) {
      if (blocked) {
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
        btn.title = reason;
      } else {
        btn.disabled = false;
        btn.removeAttribute('aria-disabled');
        btn.removeAttribute('title');
      }
    }
  }

  /**
   * Look up the public screenshot URL for an annotation. The server's
   * `GET /api/v1/annotations/:id/screenshot` endpoint returns
   * `{ screenshotObjectKey, screenshotUrl }`; the URL is what `<img>` can
   * load directly. Failures are logged-but-tolerated so the popover
   * still shows the rest of the annotation.
   */
  async #resolveScreenshotUrl(annotationId: string): Promise<void> {
    try {
      const result = await apiFetch<{ screenshotUrl: string }>(
        `/annotations/${encodeURIComponent(annotationId)}/screenshot`,
      );
      // Guard against a stale response after the user navigated away.
      if (this.#annotation?.id !== annotationId) return;
      this.#screenshotViewer.imageUrl = result?.screenshotUrl ?? null;
    } catch {
      if (this.#annotation?.id !== annotationId) return;
      this.#screenshotViewer.imageUrl = null;
    }
  }

  /**
   * Render the captured Console / Network sections (Req 36.3, task 27.4).
   * Each section is a native `<details>` block:
   *   - Hidden when the annotation does not carry the buffer or it is
   *     empty (null / zero-length array).
   *   - Visible (collapsed) when the buffer has at least one entry.
   * Console entries render as `[level] timestamp — message` with an
   * optional `<details>`-wrapped stack. Network entries render as
   * `method? name (status, duration ms)` — `method` is omitted when not
   * captured (PerformanceObserver does not surface it on every entry).
   * Both lists preserve insertion order so the timeline reads top-down.
   */
  #renderCaptureBuffers(): void {
    const a = this.#annotation;
    const consoleEntries = a?.capturedConsole ?? null;
    if (!consoleEntries || consoleEntries.length === 0) {
      this.#consolePanel.hidden = true;
      this.#consoleList.replaceChildren();
      this.#consoleCount.textContent = '0';
    } else {
      this.#consolePanel.hidden = false;
      this.#consoleCount.textContent = String(consoleEntries.length);
      this.#consoleList.replaceChildren(
        ...consoleEntries.map((entry) => renderConsoleEntry(entry)),
      );
    }

    const networkEntries = a?.capturedNetwork ?? null;
    if (!networkEntries || networkEntries.length === 0) {
      this.#networkPanel.hidden = true;
      this.#networkList.replaceChildren();
      this.#networkCount.textContent = '0';
    } else {
      this.#networkPanel.hidden = false;
      this.#networkCount.textContent = String(networkEntries.length);
      this.#networkList.replaceChildren(
        ...networkEntries.map((entry) => renderNetworkEntry(entry)),
      );
    }
  }

  #renderCommentThread(): void {
    const a = this.#annotation;
    if (!a) {
      this.#commentThread.comments = [];
      return;
    }
    this.#commentThread.comments = this.#comments.filter(
      (c) => c.annotationId === a.id,
    );
  }

  /**
   * Render the co-viewer presence row in view-mode. One initial-bubble per
   * id (initials are taken from the first up-to-2 characters of the id —
   * the host can swap in the proper member display name via the same
   * setter once it has the lookup wired). Hidden when no viewers are
   * present or in create mode.
   */
  #renderViewers(): void {
    const inViewMode = this.#annotation !== null;
    const list = this.#viewers;
    if (!inViewMode || list.length === 0) {
      this.#viewersRow.hidden = true;
      this.#viewersList.replaceChildren();
      this.#viewersLabel.textContent = '';
      return;
    }
    this.#viewersRow.hidden = false;
    const bubbles = list.map((id) => {
      const span = document.createElement('span');
      span.className = 'fl-popover-viewer-bubble';
      span.title = id;
      span.textContent = initialsFromId(id);
      return span;
    });
    this.#viewersList.replaceChildren(...bubbles);
    this.#viewersLabel.textContent = `${list.length} viewing`;
  }

  /**
   * Compute the desired presence state and dispatch one `annotation:open`
   * or `annotation:close` event to bring the world in line.
   *
   * The popover is "presence-open" iff (a) it has a target (the dialog is
   * open) AND (b) it has an annotation (view mode, not create mode). When
   * the desired id changes — including the annotation id swapping under a
   * sticky open dialog — we close the previous and open the new in that
   * order so the host can rely on receiving exactly one open event per
   * pair.
   *
   * Events are dispatched composed + bubbling so the ancestor
   * `<fl-overlay-host>` can listen at its own root and forward onto the
   * Socket.IO connection.
   */
  #syncPresence(): void {
    const dialogOpen = this.#dialog.open;
    const wantId =
      this.#target && this.#annotation && dialogOpen
        ? this.#annotation.id
        : null;
    const have = this.#presenceOpenForId;
    if (have === wantId) return;
    if (have !== null) {
      this.dispatchEvent(
        new CustomEvent<{ id: string }>('annotation:close', {
          detail: { id: have },
          bubbles: true,
          composed: true,
        }),
      );
    }
    if (wantId !== null) {
      this.dispatchEvent(
        new CustomEvent<{ id: string }>('annotation:open', {
          detail: { id: wantId },
          bubbles: true,
          composed: true,
        }),
      );
    }
    this.#presenceOpenForId = wantId;
  }

  #syncSubmitEnabled(): void {
    this.#submitBtn.disabled = this.#textarea.value.trim().length === 0;
  }

  /**
   * Hydrate the create-mode form from `chrome.storage.session.fl_drafts`
   * the first time the popover opens on a given URL (Req 41.2 / task 32.2).
   * The lookup uses `window.location.href` — the same key the debounced
   * `saveDraft` writes to (`#scheduleDraftSave` above), so the round-trip
   * is symmetric.
   *
   * Bails out cleanly if:
   *   - the URL is unavailable (e.g. `about:blank` test runtimes),
   *   - we have already prefilled for this URL (so a second open of the
   *     popover does not clobber the user's new keystrokes with a stale
   *     value we just wrote out via `saveDraft`),
   *   - state has shifted between the call and the resolved promise
   *     (target cleared, annotation set, tab unmounted),
   *   - the user has already started typing before the storage round-trip
   *     resolved — we never overwrite live input.
   *
   * Failures inside `loadDraft` are swallowed (see `lib/draftStore.ts`)
   * so a storage outage cannot break the open transition. Severity and
   * type are validated against the closed enums before being applied so
   * a corrupt slot from an earlier extension version cannot poison form
   * state.
   */
  async #hydrateDraft(): Promise<void> {
    const url =
      typeof window !== 'undefined' && typeof window.location?.href === 'string'
        ? window.location.href
        : '';
    if (url.length === 0) return;
    if (this.#draftHydratedForUrl === url) return;
    // Mark synchronously so a re-entrant target setter (host that
    // toggles target → null → target on a single user click) does not
    // stack duplicate hydrate calls. The flag is reset to `null` after
    // a successful submit so the next open after a new draft is written
    // can hydrate again.
    this.#draftHydratedForUrl = url;
    let draft;
    try {
      draft = await loadDraft(url);
    } catch {
      return;
    }
    if (!draft) return;
    // State may have shifted while we awaited storage — bail if the
    // popover was dismissed, switched to view mode, or the user beat us
    // to typing into the textarea.
    if (this.#target === null) return;
    if (this.#annotation !== null) return;
    if (this.#textarea.value.length > 0) return;
    this.#textarea.value = typeof draft.body === 'string' ? draft.body : '';
    if (
      draft.severity === 'critical' ||
      draft.severity === 'major' ||
      draft.severity === 'minor' ||
      draft.severity === 'informational'
    ) {
      this.#severity = draft.severity;
      this.#renderSeverity();
    }
    if (
      draft.type === 'note' ||
      draft.type === 'suggestion' ||
      draft.type === 'guideline'
    ) {
      this.#activeTab = draft.type;
      this.#renderTabs();
    }
    this.#syncSubmitEnabled();
  }

  /**
   * Schedule a debounced `saveDraft` call (Req 41.1, task 32.1). Captures
   * the current form state synchronously so the value persisted is the
   * one the user just typed/clicked, not whatever they keep doing during
   * the 300 ms wait. Cancels any in-flight timer first so rapid
   * successive events coalesce into a single storage write.
   *
   * Skipped while in view mode (annotation set) — there is no
   * create-mode form to persist when we're displaying an existing
   * annotation. `saveDraft` is fire-and-forget; failures inside it are
   * already swallowed (see `lib/draftStore.ts`) so a storage outage
   * cannot break the typing flow.
   */
  #scheduleDraftSave(): void {
    if (this.#annotation !== null) return;
    if (this.#draftSaveTimer !== null) {
      clearTimeout(this.#draftSaveTimer);
    }
    const url =
      typeof window !== 'undefined' && typeof window.location?.href === 'string'
        ? window.location.href
        : '';
    if (url.length === 0) return;
    const draft = {
      body: this.#textarea.value,
      severity: this.#severity,
      type: this.#activeTab,
    };
    this.#draftSaveTimer = setTimeout(() => {
      this.#draftSaveTimer = null;
      void saveDraft(url, draft);
    }, DRAFT_DEBOUNCE_MS);
  }

  /**
   * Mirror `this.#captureScreenshot` onto the footer "Attach screenshot"
   * checkbox (Req 34.2 / Task 25.4). Called from `connectedCallback` so
   * the initial paint matches the default, and again at the end of
   * `#hydrateCaptureScreenshotPref` so the persisted choice wins once
   * the async `chrome.storage.local.get` resolves.
   */
  #syncCaptureCheckbox(): void {
    if (!this.#captureCheckbox) return;
    this.#captureCheckbox.checked = this.#captureScreenshot;
  }

  /**
   * Render the create-mode "Will attach" environment summary (task 19.2,
   * Req 17.1, 17.5). Reads from `this.#envSummary` and writes a compact,
   * human-readable line into the badge — for example:
   *
   *   Will attach: Chrome 124.0.6367.91 · macOS 14.4.1 · desktop
   *
   * When the summary is empty (initial mount, or all fields collapsed to
   * `unknown`/null) the row is hidden so we don't show "unknown · unknown".
   */
  #renderEnvironmentSummary(): void {
    const meta = this.#envSummary;
    if (!meta) {
      this.#envSummaryRow.hidden = true;
      this.#envSummaryText.textContent = '';
      return;
    }
    const browser = formatFamilyAndVersion(meta.browserFamily, meta.browserVersion);
    const os = formatFamilyAndVersion(meta.osFamily, meta.osVersion);
    const device = meta.deviceType;
    const parts = [browser, os, device].filter((p): p is string => p.length > 0);
    if (parts.length === 0) {
      this.#envSummaryRow.hidden = true;
      this.#envSummaryText.textContent = '';
      return;
    }
    this.#envSummaryRow.hidden = false;
    this.#envSummaryText.textContent = parts.join(' · ');
  }

  /**
   * Run the same UA pipeline the submit handler uses (task 19.1):
   *   1. `parseUserAgent(navigator.userAgent)` synchronously.
   *   2. `await detectBraveAndArcOverrides(meta)` to surface Brave/Arc.
   * Updates `#envSummary` and re-renders the badge after each step. Errors
   * inside `detectBraveAndArcOverrides` are swallowed and we keep the raw
   * `parseUserAgent` result — same fallback policy as `#dispatchSubmit`.
   */
  async #refreshEnvironmentSummary(): Promise<void> {
    const ua =
      typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? navigator.userAgent
        : '';
    const sync = parseUserAgent(ua);
    this.#envSummary = sync;
    this.#renderEnvironmentSummary();
    let resolved: EnvironmentMetadata = sync;
    try {
      resolved = await detectBraveAndArcOverrides(sync);
    } catch {
      /* fall through with the raw parseUserAgent result */
    }
    this.#envSummary = resolved;
    this.#renderEnvironmentSummary();
  }

  // --- Event handlers --------------------------------------------------------

  #onTabClick = (e: Event): void => {
    if (this.#annotation) return; // tabs disabled in view mode
    const btn = e.currentTarget as HTMLButtonElement;
    const tab = btn.dataset.tab as AnnotationType | undefined;
    if (!tab) return;
    this.#activeTab = tab;
    this.#renderTabs();
    this.#scheduleDraftSave();
  };

  #onSeverityClick = (e: Event): void => {
    const btn = e.currentTarget as HTMLButtonElement;
    const value = btn.dataset.severity as Severity | undefined;
    if (!value) return;
    this.#severity = value;
    this.#renderSeverity();
    this.#scheduleDraftSave();
  };

  #onTextInput = (): void => {
    const ta = this.#textarea;
    const cursor = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, cursor);
    const lastAt = before.lastIndexOf('@');
    let showAutocomplete = false;
    if (lastAt >= 0) {
      const query = before.slice(lastAt + 1);
      // Mirror the legacy heuristic: hide as soon as a space appears
      // between `@` and the cursor — single-line mention queries only.
      if (!query.includes(' ') && !query.includes('\n')) {
        this.#mentionStart = lastAt;
        this.#mentionAutocomplete.members = this.#members;
        this.#mentionAutocomplete.query = query;
        // `<fl-mention-autocomplete>` self-hides when there are no
        // candidates; we only need to mark it not-hidden here so it gets
        // a chance to render rows.
        this.#mentionAutocomplete.hidden = false;
        showAutocomplete = true;
      }
    }
    if (!showAutocomplete) {
      this.#mentionAutocomplete.hidden = true;
      this.#mentionStart = -1;
    }
    this.#syncMentionAria();
    this.#syncSubmitEnabled();
    this.#scheduleDraftSave();
  };

  /**
   * Forward keystrokes captured on the textarea into the autocomplete
   * (task 33.2 / Req 42.1):
   *   - ArrowUp / ArrowDown move the highlight without losing focus.
   *   - Enter selects the highlighted candidate (no newline inserted).
   *   - Escape closes the dropdown but keeps the textarea focused so
   *     the user can keep typing.
   * `aria-activedescendant` is updated after each handled key so screen
   * readers announce the new active row.
   */
  #onTextareaKeydown = (event: KeyboardEvent): void => {
    if (this.#mentionAutocomplete.hidden) return;
    const handled = this.#mentionAutocomplete.handleKeydown(event);
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
      this.#syncMentionAria();
    }
  };

  /**
   * Mirror the autocomplete's open / highlighted state onto the
   * textarea's combobox ARIA attributes. Called after every input event
   * and after every handled keystroke so `aria-expanded` and
   * `aria-activedescendant` always describe the current dropdown state.
   */
  #syncMentionAria(): void {
    const open = !this.#mentionAutocomplete.hidden;
    this.#textarea.setAttribute('aria-expanded', open ? 'true' : 'false');
    const activeId = open ? this.#mentionAutocomplete.activeOptionId : null;
    if (activeId) {
      this.#textarea.setAttribute('aria-activedescendant', activeId);
    } else {
      this.#textarea.removeAttribute('aria-activedescendant');
    }
  }

  #onMentionSelect = (event: Event): void => {
    const detail = (event as CustomEvent<MentionSelectEventDetail>).detail;
    if (!detail || this.#mentionStart < 0) return;
    const ta = this.#textarea;
    const queryEnd =
      this.#mentionStart + 1 + (this.#mentionAutocomplete.query?.length ?? 0);
    const before = ta.value.slice(0, this.#mentionStart);
    const after = ta.value.slice(queryEnd);
    ta.value = `${before}@${detail.member.name} ${after}`;
    this.#mentionAutocomplete.hidden = true;
    this.#mentionStart = -1;
    ta.focus();
    this.#syncMentionAria();
    this.#syncSubmitEnabled();
  };

  /**
   * The mention autocomplete dispatches a bubbling, composed `cancel`
   * `CustomEvent` when the user presses Escape (task 33.2 / Req 42.1).
   * The popover itself emits its own `cancel` event with the same name
   * — and `<fl-overlay-host>` listens for it to close the dialog. Stop
   * the autocomplete's `cancel` here so the host treats it as "user
   * dismissed the @-dropdown" rather than "user cancelled the dialog".
   * Mirror the dropdown's own state into the textarea's combobox ARIA
   * so screen readers see `aria-expanded=false`.
   */
  #onMentionCancel = (event: Event): void => {
    event.stopPropagation();
    this.#mentionStart = -1;
    this.#textarea.focus();
    this.#syncMentionAria();
  };

  /**
   * Sync the user's `<input type="checkbox">` choice into the popover's
   * `captureScreenshot` property. The setter persists to
   * `chrome.storage.local` so the next popover (and the next page load)
   * defaults to the user's last choice (Req 34.2 / Task 25.4).
   */
  #onCaptureToggleChange = (): void => {
    this.captureScreenshot = this.#captureCheckbox.checked;
  };

  #onCancelClick = (): void => {
    // Dispatch `cancel` first so consumers can act on the original target
    // before we tear the dialog down; `cancel` does not bubble through the
    // native `close` path because we close silently.
    this.dispatchEvent(
      new CustomEvent<void>('cancel', { bubbles: true, composed: true }),
    );
    this.#resetCreateForm();
    this.#closeDialogSilently();
  };

  #onSubmitClick = (): void => {
    const body = this.#textarea.value.trim();
    if (!body) return;
    if (!this.#target?.domTarget) {
      // Without a DOMTarget we cannot build a complete annotation; refuse
      // silently rather than dispatching a malformed `submit`.
      return;
    }
    // Capture form state synchronously so it can't drift while we await
    // Brave/Arc detection. The reset/close happen synchronously below so
    // the textarea clears the moment the user clicks; the resulting
    // `submit` event is dispatched once detection settles.
    const target = this.#target;
    const activeTab = this.#activeTab;
    const severity = this.#severity;
    const pinNumber = this.#nextPinNumber;
    // Cancel any in-flight draft-save debounce. The user has just
    // committed the draft via Submit; we are about to delete it from
    // session storage in `#dispatchSubmit`, so a stray `saveDraft`
    // firing 300 ms after the click would resurrect the entry we just
    // deleted (Req 41.3 / task 32.3).
    if (this.#draftSaveTimer !== null) {
      clearTimeout(this.#draftSaveTimer);
      this.#draftSaveTimer = null;
    }
    void this.#dispatchSubmit({ body, target, activeTab, severity, pinNumber });
    this.#resetCreateForm();
    this.#closeDialogSilently();
  };

  async #dispatchSubmit(args: {
    body: string;
    target: PopoverTarget;
    activeTab: AnnotationType;
    severity: Severity;
    pinNumber: number;
  }): Promise<void> {
    const { body, target, activeTab, severity, pinNumber } = args;
    if (!target.domTarget) return;
    const now = new Date().toISOString();
    const ua =
      typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? navigator.userAgent
        : '';
    // Per task 19.1: parse the live UA, then layer on the browser-only
    // Brave/Arc overrides (both browsers masquerade as Chrome in the UA
    // string). Failures inside `detectBraveAndArcOverrides` are swallowed
    // by the helper itself; if the helper rejects for any other reason
    // we still want to send the un-overridden metadata rather than drop
    // the annotation.
    let environment = parseUserAgent(ua);
    try {
      environment = await detectBraveAndArcOverrides(environment);
    } catch {
      /* fall through with the raw parseUserAgent result */
    }
    // Optional bug-report viewport fields kept for back-compat with the
    // legacy `BrowserMeta` payload (now folded into `EnvironmentMetadata`).
    if (
      activeTab === 'note' &&
      (severity === 'critical' || severity === 'major') &&
      typeof window !== 'undefined'
    ) {
      environment.viewportWidth = window.innerWidth;
      environment.viewportHeight = window.innerHeight;
      environment.devicePixelRatio = window.devicePixelRatio;
    }

    // Capture_Buffer attachment (Req 36.2, task 27.3). Only bug-report
    // submissions (type=note + severity ∈ {critical, major}) carry the
    // rolling console + network buffers. Suggestions / Guidelines, and
    // Notes at minor / informational severity, never include them so the
    // payload stays small for the common case.
    let capturedConsole: CapturedConsoleEntry[] | undefined;
    let capturedNetwork: CapturedNetworkEntry[] | undefined;
    if (
      activeTab === 'note' &&
      (severity === 'critical' || severity === 'major') &&
      this.#captureBuffer
    ) {
      try {
        capturedConsole = this.#captureBuffer.getConsoleEntries();
      } catch {
        capturedConsole = undefined;
      }
      try {
        capturedNetwork = this.#captureBuffer.getNetworkEntries();
      } catch {
        capturedNetwork = undefined;
      }
    }

    const annotation: Annotation = {
      id: crypto.randomUUID(),
      projectId: '',
      pageId: '',
      pageUrl: typeof window !== 'undefined' ? window.location.href : '',
      type: activeTab,
      severity,
      status: 'active',
      body,
      authorId: '',
      createdAt: now,
      updatedAt: now,
      target: target.domTarget,
      environment,
      pinNumber,
    };

    if (capturedConsole !== undefined) {
      annotation.capturedConsole = capturedConsole;
    }
    if (capturedNetwork !== undefined) {
      annotation.capturedNetwork = capturedNetwork;
    }

    this.dispatchEvent(
      new CustomEvent<PopoverSubmitDetail>('submit', {
        detail: { annotation },
        bubbles: true,
        composed: true,
      }),
    );

    // Delete the persisted draft for the URL we just committed against
    // (Req 41.3 / task 32.3). Best-effort: failures inside `deleteDraft`
    // are swallowed (see `lib/draftStore.ts`) so a storage outage cannot
    // break the create flow. Reset the hydration latch so a fresh draft
    // typed on the same URL after this submit is hydrated cleanly the
    // next time the popover opens.
    const submittedUrl =
      typeof window !== 'undefined' && typeof window.location?.href === 'string'
        ? window.location.href
        : '';
    if (submittedUrl.length > 0) {
      void deleteDraft(submittedUrl);
    }
    if (this.#draftHydratedForUrl === submittedUrl) {
      this.#draftHydratedForUrl = null;
    }

    // After the annotation has been handed off to the host (Req 34.1 /
    // Task 25.3): if the user has the "Attach screenshot" toggle enabled,
    // ask the service worker for a base64 PNG of the visible viewport
    // and POST it as multipart/form-data to
    // `POST /api/v1/annotations/:id/screenshot`. We fire-and-forget this
    // because the popover has already closed synchronously — we don't
    // want to block the user's next click on a network round-trip.
    // Failures dispatch a `screenshot-error` CustomEvent rather than
    // throwing so the host can surface a toast without rolling back
    // the annotation create.
    if (this.#captureScreenshot) {
      void this.#captureAndUploadScreenshot(annotation.id);
    }
  }

  /**
   * Read the persisted `fl_capture_screenshot_pref` from
   * `chrome.storage.local` (Req 34.2 / Task 25.4) and apply it to the
   * popover's local state. Best-effort: if `chrome.storage` is
   * unavailable (jsdom tests, dashboard) or the read throws, we keep the
   * default `true` so capture stays on by default. The setter is bypassed
   * to avoid persisting a value we just read.
   */
  async #hydrateCaptureScreenshotPref(): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY_CAPTURE_PREF);
      const stored = result?.[STORAGE_KEY_CAPTURE_PREF];
      if (typeof stored === 'boolean') {
        this.#captureScreenshot = stored;
      }
    } catch {
      /* swallow — capture defaults to enabled when we can't read prefs */
    }
    // Mirror the (possibly-updated) state onto the footer checkbox so the
    // user sees the persisted choice as soon as the dialog renders.
    this.#syncCaptureCheckbox();
  }

  /**
   * Persist the user's "Attach screenshot" choice to
   * `chrome.storage.local` (Req 34.2 / Task 25.4). Silently no-ops
   * outside an extension context.
   */
  async #persistCaptureScreenshotPref(value: boolean): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    try {
      await chrome.storage.local.set({ [STORAGE_KEY_CAPTURE_PREF]: value });
    } catch {
      /* swallow — persistence failures must not break annotation creation */
    }
  }

  /**
   * Capture-and-upload pipeline (Req 34.1, 34.3 / Task 25.3). Steps:
   *   1. `chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' })` —
   *      the service worker (background.ts) runs
   *      `chrome.tabs.captureVisibleTab` on our behalf and resolves with
   *      `{ dataUrl: string }` (or `{ dataUrl: null, error }` on failure).
   *   2. Convert the base64 PNG dataURL into a `Blob`.
   *   3. POST the bytes to `/annotations/:id/screenshot` as
   *      multipart/form-data via `apiFetchRaw` (so the wrapper attaches
   *      the bearer token but does NOT add a JSON `Content-Type` —
   *      `FormData` sets the multipart boundary itself). The
   *      `redactionRects` field is computed via `computeRedactionRects()`
   *      (task 37.1, Req 45.1) so the server can Gaussian-blur over
   *      `<input type="password">`, `cc-*` autofill fields, opted-in
   *      `data-fl-redact` elements, and aria-label matches before
   *      persisting the PNG to object storage. We also concatenate any
   *      user-painted "Blur" rectangles from a mounted
   *      `<fl-markup-editor>` (Req 45.3, task 37.4) before serialising,
   *      so the manual privacy paint flow lands in the same wire field
   *      as the automatic predicate.
   *
   * Errors at any step are converted to a bubbling, composed
   * `screenshot-error` `CustomEvent` so a host can surface a toast.
   * Annotation creation is independent of this flow — by the time we
   * dispatch `screenshot-error`, the create has already succeeded.
   */
  async #captureAndUploadScreenshot(annotationId: string): Promise<void> {
    // Step 1: ask the service worker for a dataURL.
    if (
      typeof chrome === 'undefined' ||
      !chrome.runtime ||
      typeof chrome.runtime.sendMessage !== 'function'
    ) {
      this.#emitScreenshotError(annotationId, {
        code: 'unsupported',
        message: 'Screenshot capture is unavailable in this context.',
      });
      return;
    }

    type CaptureResponse = { dataUrl: string | null; error?: string };
    let response: CaptureResponse | undefined;
    try {
      response = (await chrome.runtime.sendMessage({
        type: 'CAPTURE_VISIBLE_TAB',
      })) as CaptureResponse | undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#emitScreenshotError(annotationId, {
        code: 'capture-failed',
        message: `Could not capture screenshot: ${message}`,
      });
      return;
    }

    if (!response || !response.dataUrl) {
      this.#emitScreenshotError(annotationId, {
        code: 'capture-failed',
        message: response?.error
          ? `Could not capture screenshot: ${response.error}`
          : 'Could not capture screenshot.',
      });
      return;
    }

    // Step 2: dataURL → Blob.
    const blob = dataUrlToBlob(response.dataUrl);
    if (!blob) {
      this.#emitScreenshotError(annotationId, {
        code: 'capture-failed',
        message: 'Captured screenshot was not a valid base64 PNG.',
      });
      return;
    }

    // Step 3: multipart upload via the wrapped API client so the auth
    // header is attached. We compute the client-side redaction rects
    // (task 37.1, Req 45.1) right before the upload — capturing them
    // here, after the visible-tab grab, ensures the rects line up with
    // the same DOM the user just screenshotted. The server's
    // `applyRedactionBlur` step (task 37.2) Gaussian-blurs the supplied
    // rects over the PNG before persisting it to object storage.
    //
    // We also append any user-painted "Blur" rects from a mounted
    // `<fl-markup-editor>` (Req 45.3, task 37.4). The editor surfaces
    // them via its `redactionRects` getter using the same `BoundingBox`
    // shape, so we just concatenate the two lists before serialising.
    // No editor → empty extra list → behaviour identical to 37.1.
    const form = new FormData();
    form.append('image', blob, `${annotationId}.png`);
    const autoRects = computeRedactionRects();
    const userRects = this.#collectUserPaintedRedactionRects();
    const combinedRects: BoundingBox[] = [...autoRects, ...userRects];
    form.append('redactionRects', serializeRedactionRects(combinedRects));

    let uploadRes: Response;
    try {
      uploadRes = await apiFetchRaw(
        `/annotations/${encodeURIComponent(annotationId)}/screenshot`,
        {
          method: 'POST',
          body: form,
          // `raw: true` skips the JSON `Content-Type` default so the
          // browser inserts the multipart boundary header itself.
          raw: true,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#emitScreenshotError(annotationId, {
        code: 'upload-failed',
        message: `Could not upload screenshot: ${message}`,
      });
      return;
    }

    if (!uploadRes.ok) {
      let serverMessage = `HTTP ${uploadRes.status}`;
      try {
        const body = (await uploadRes.json()) as
          | { error?: { message?: unknown } }
          | undefined;
        const fromEnvelope =
          body &&
          typeof body === 'object' &&
          body.error &&
          typeof body.error.message === 'string'
            ? body.error.message
            : null;
        if (fromEnvelope) serverMessage = fromEnvelope;
      } catch {
        /* non-JSON body — keep the status fallback */
      }
      this.#emitScreenshotError(annotationId, {
        code: 'upload-failed',
        message: `Could not upload screenshot: ${serverMessage}`,
      });
    }
  }

  /**
   * Helper: dispatch a bubbling, composed `screenshot-error` event so a
   * host (overlay container, toast surface) can react. The popover
   * itself does not render an inline error because it has already closed
   * by the time this fires — surfacing through the event bus keeps the
   * popover free of long-lived state.
   */
  #emitScreenshotError(
    annotationId: string,
    payload: Omit<PopoverScreenshotErrorDetail, 'annotationId'>,
  ): void {
    this.dispatchEvent(
      new CustomEvent<PopoverScreenshotErrorDetail>('screenshot-error', {
        detail: { annotationId, ...payload },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Collect the user-painted privacy "Blur" rectangles from any mounted
   * `<fl-markup-editor>` (Req 45.3, task 37.4). Searches the popover's
   * own Shadow Root first; if no editor is present (the common case
   * today — the markup editor is mounted on demand), falls back to the
   * containing document so a sibling overlay host can also drive the
   * pipeline. Returns an empty list when no editor is mounted, which
   * keeps the upload behaviour identical to task 37.1 in that case.
   *
   * The editor exposes its rects via the `redactionRects` getter in the
   * canonical `BoundingBox` shape (`extension/src/lib/redaction.ts`),
   * the same shape `computeRedactionRects()` emits, so the upload
   * pipeline can concatenate the two arrays without translation.
   */
  #collectUserPaintedRedactionRects(): BoundingBox[] {
    const out: BoundingBox[] = [];
    const editors = new Set<FlMarkupEditor>();
    // Look inside the popover's Shadow Root first — that is where any
    // future "edit screenshot" flow would mount its editor.
    const root = this.shadowRoot;
    if (root) {
      for (const el of Array.from(
        root.querySelectorAll<FlMarkupEditor>('fl-markup-editor'),
      )) {
        editors.add(el);
      }
    }
    // Also check the containing document so a host that mounts the
    // editor in a sibling overlay (e.g. a separate dialog) still
    // contributes rects. Cross-shadow-tree access is fine because both
    // the popover and the editor are first-party Custom Elements
    // defined by this extension.
    if (typeof document !== 'undefined') {
      for (const el of Array.from(
        document.querySelectorAll<FlMarkupEditor>('fl-markup-editor'),
      )) {
        editors.add(el);
      }
    }
    for (const editor of editors) {
      const rects = editor.redactionRects;
      if (Array.isArray(rects)) {
        for (const r of rects) {
          // Defensive copy + shape check — a future regression that
          // changes the getter's shape must not silently corrupt the
          // wire payload.
          if (
            r &&
            typeof r.x === 'number' &&
            typeof r.y === 'number' &&
            typeof r.w === 'number' &&
            typeof r.h === 'number'
          ) {
            out.push({ x: r.x, y: r.y, w: r.w, h: r.h });
          }
        }
      }
    }
    return out;
  }

  #onResolveClick = (): void => {
    const a = this.#annotation;
    if (!a) return;
    // Belt-and-braces: the button is `disabled` while offline + unsynced
    // (`#renderResolveReopen`) but a programmatic `.click()` on a
    // disabled <button> is a no-op only on UA that honours the
    // `disabled` attribute, which jsdom does. We mirror the gate here
    // so a future regression that forgets to update the button state
    // still cannot dispatch a `status-change` event the server cannot
    // honour. (Req 44.5 / task 36.6.)
    if (this.#isOffline && this.isUnsynced) return;
    this.dispatchEvent(
      new CustomEvent<PopoverStatusChangeDetail>('status-change', {
        detail: { annotationId: a.id, status: 'resolved' },
        bubbles: true,
        composed: true,
      }),
    );
  };

  #onReopenClick = (): void => {
    const a = this.#annotation;
    if (!a) return;
    // Same offline + unsynced guard as `#onResolveClick`. See note
    // there for context (Req 44.5 / task 36.6).
    if (this.#isOffline && this.isUnsynced) return;
    this.dispatchEvent(
      new CustomEvent<PopoverStatusChangeDetail>('status-change', {
        detail: { annotationId: a.id, status: 'active' },
        bubbles: true,
        composed: true,
      }),
    );
  };

  #onViewCloseClick = (): void => {
    // The view-mode close button uses the silent close path so we emit a
    // single `close` event below, not two from a re-entered listener.
    this.#closeDialogSilently();
    this.dispatchEvent(
      new CustomEvent<void>('close', { bubbles: true, composed: true }),
    );
  };

  #onCommentSubmit = (event: Event): void => {
    // Consume the inner `<fl-comment-thread>` `submit` event and re-emit
    // as a `comment-submit` event tagged with the parent annotation id.
    // We stop propagation so consumers listening for the `<fl-popover>`'s
    // own `submit` (annotation creation) do not receive a comment event.
    event.stopPropagation();
    const a = this.#annotation;
    if (!a) return;
    const detail = (event as CustomEvent<CommentThreadSubmitDetail>).detail;
    if (!detail) return;
    this.dispatchEvent(
      new CustomEvent<PopoverCommentSubmitDetail>('comment-submit', {
        detail: { ...detail, annotationId: a.id },
        bubbles: true,
        composed: true,
      }),
    );
  };

  #onDialogClose = (): void => {
    // Native `close` event — dispatched on Escape, on `dialog.close()` from
    // outside, or on a programmatic close we did not intercept. Re-emit as
    // a composed event so listeners outside the Shadow Root can react.
    this.dispatchEvent(
      new CustomEvent<void>('close', { bubbles: true, composed: true }),
    );
    // Restore focus to whoever held it before the dialog opened
    // (Req 42.3 / task 33.3). Runs after the close event so listeners
    // see the dialog as closed and the page as ready to receive focus.
    this.#restoreFocus();
    // Dialog has just closed — flush any in-flight presence claim so the
    // host issues the matching `annotation:close` to the server. We
    // clear directly here rather than going through `#syncPresence`
    // because some hosts (and jsdom) leave `dialog.open` truthy when the
    // close event is dispatched manually.
    if (this.#presenceOpenForId !== null) {
      this.dispatchEvent(
        new CustomEvent<{ id: string }>('annotation:close', {
          detail: { id: this.#presenceOpenForId },
          bubbles: true,
          composed: true,
        }),
      );
      this.#presenceOpenForId = null;
    }
  };

  #resetCreateForm(): void {
    this.#textarea.value = '';
    this.#severity = 'informational';
    this.#activeTab = 'note';
    this.#mentionStart = -1;
    this.#mentionAutocomplete.hidden = true;
    this.#mentionAutocomplete.query = '';
    this.#renderTabs();
    this.#renderSeverity();
    this.#syncSubmitEnabled();
  }
}

if (
  typeof customElements !== 'undefined' &&
  !customElements.get(FlPopover.tagName)
) {
  withBoundary(FlPopover.prototype, 'connectedCallback');
  withBoundary(FlPopover.prototype, 'disconnectedCallback');
  customElements.define(FlPopover.tagName, FlPopover);
}

declare global {
  interface HTMLElementTagNameMap {
    'fl-popover': FlPopover;
  }
}
