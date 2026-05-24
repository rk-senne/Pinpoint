/**
 * Per-URL draft persistence (Requirement 41.1, task 32.1).
 *
 * As a user composes an annotation in `<fl-popover>`, the popover writes
 * the in-progress body / severity / type to `chrome.storage.session`,
 * keyed by the current page URL, on every input event (debounced to
 * 300 ms — see `Popover.ts`). The persisted draft survives an
 * accidental dismissal of the popover and a tab reload, but evaporates
 * when the browser closes — exactly the lifetime that matches the
 * "draft" semantics laid out in design.md §"Draft persistence":
 *
 *   > We picked `chrome.storage.session` over `chrome.storage.local`
 *   > so drafts evaporate when the browser closes — they exist to
 *   > survive an accidental dismissal or one tab reload, not to
 *   > persist indefinitely. URL is the natural key because the same
 *   > DOM target on a different page is a different annotation.
 *
 * Storage shape (`chrome.storage.session`):
 *
 *   {
 *     "fl_drafts": {
 *       "https://example.com/dashboard": { body, severity, type },
 *       "https://app.acme.test/inbox":   { body, severity, type }
 *     }
 *   }
 *
 * The module is deliberately decoupled from the popover: the popover
 * calls `saveDraft` on input (debounced), `loadDraft` on open
 * (task 32.2), and `deleteDraft` on submit success (task 32.3). All
 * helpers gracefully no-op / resolve `null` when
 * `chrome.storage.session` is unavailable so jsdom unit tests, the
 * dashboard, and any other non-extension callers do not need to
 * special-case the test environment.
 */

/** `chrome.storage.session` key under which the per-URL drafts object lives. */
export const STORAGE_KEY_DRAFTS = 'fl_drafts';

/**
 * Shape of a single persisted draft. Mirrors the create-mode form fields
 * the popover currently maintains: `body` (textarea), `severity`
 * (severity selector), and `type` (Note / Suggestion / Guideline tab).
 *
 * The fields are kept as `string` rather than the narrower
 * `Severity`/`AnnotationType` literal unions so this module is self-
 * contained — callers can pass raw values straight from the DOM
 * (`textarea.value`, `dataset.severity`) without import gymnastics.
 * The popover validates on the way out before applying a loaded draft.
 */
export interface PopoverDraft {
  body: string;
  severity: string;
  type: string;
}

/**
 * `chrome.storage.session` is unavailable when this module is exercised
 * outside a Manifest V3 context (jsdom unit tests, the dashboard, the
 * options page when running standalone). All public helpers degrade to
 * a noop / `null` response in that case so callers do not have to
 * special-case the test environment.
 */
function getSessionArea(): chrome.storage.StorageArea | null {
  if (typeof chrome === 'undefined') return null;
  const session = chrome.storage?.session;
  return session ?? null;
}

/**
 * Read the current `url → draft` map from `chrome.storage.session`.
 * Always returns a fresh object the caller may mutate; missing or
 * corrupt slots coerce to an empty map so a malformed session value
 * does not break the calling popover.
 */
async function readDrafts(): Promise<Record<string, PopoverDraft>> {
  const storage = getSessionArea();
  if (!storage) return {};
  let result: Record<string, unknown> | undefined;
  try {
    result = await storage.get(STORAGE_KEY_DRAFTS);
  } catch {
    return {};
  }
  const raw = result?.[STORAGE_KEY_DRAFTS];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, PopoverDraft> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof (v as Record<string, unknown>).body === 'string' &&
      typeof (v as Record<string, unknown>).severity === 'string' &&
      typeof (v as Record<string, unknown>).type === 'string'
    ) {
      const obj = v as Record<string, string>;
      out[k] = { body: obj.body, severity: obj.severity, type: obj.type };
    }
  }
  return out;
}

/**
 * Persist (or overwrite) the draft for `url` in
 * `chrome.storage.session.fl_drafts`. Existing entries for other URLs
 * are preserved. Empty/invalid `url` is a no-op so a popover hosted on
 * `about:blank` (no `location.href`) does not accidentally pollute the
 * storage with an empty key.
 *
 * Failures inside `chrome.storage.session.set` are swallowed —
 * persistence is best-effort and must never break the typing flow.
 */
export async function saveDraft(
  url: string,
  draft: PopoverDraft,
): Promise<void> {
  if (typeof url !== 'string' || url.length === 0) return;
  const storage = getSessionArea();
  if (!storage) return;
  const drafts = await readDrafts();
  drafts[url] = {
    body: typeof draft?.body === 'string' ? draft.body : '',
    severity: typeof draft?.severity === 'string' ? draft.severity : '',
    type: typeof draft?.type === 'string' ? draft.type : '',
  };
  try {
    await storage.set({ [STORAGE_KEY_DRAFTS]: drafts });
  } catch {
    /* swallow — persistence failures must not break popover input */
  }
}

/**
 * Return the draft previously persisted for `url`, or `null` when no
 * draft exists (or storage is unavailable). Used by task 32.2 to
 * prefill the popover when it reopens on the same URL.
 */
export async function loadDraft(url: string): Promise<PopoverDraft | null> {
  if (typeof url !== 'string' || url.length === 0) return null;
  const drafts = await readDrafts();
  const found = drafts[url];
  return found ?? null;
}

/**
 * Remove the persisted draft for `url`, leaving entries for other URLs
 * intact. Called by task 32.3 once the user successfully submits the
 * annotation so the next open on the same URL starts fresh.
 *
 * Best-effort: silently no-ops when `chrome.storage.session` is
 * unavailable, when `url` is empty, or when no draft existed for that
 * URL.
 */
export async function deleteDraft(url: string): Promise<void> {
  if (typeof url !== 'string' || url.length === 0) return;
  const storage = getSessionArea();
  if (!storage) return;
  const drafts = await readDrafts();
  if (!(url in drafts)) return;
  delete drafts[url];
  try {
    await storage.set({ [STORAGE_KEY_DRAFTS]: drafts });
  } catch {
    /* swallow — best-effort deletion */
  }
}
