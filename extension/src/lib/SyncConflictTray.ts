/**
 * SyncConflictTray — durable list of outbox entries the server rejected
 * on replay with a non-recoverable status (403/404/409).
 *
 * Backed by `chrome.storage.local` under a dedicated
 * `pinpoint_sync_conflicts` key, separate from the live outbox so:
 *
 *   - The Syncer's drain loop (`Outbox.list()`) does not have to filter
 *     conflicted rows out on every iteration — it only ever sees
 *     entries the server is still expected to accept.
 *   - The `<fl-sync-conflict-tray>` component can subscribe to storage
 *     changes for its own key without observing every outbox enqueue.
 *   - "Retry" can move a conflict back into the live outbox without
 *     touching its FIFO position relative to other conflicts the user
 *     has not yet acted on.
 *
 * The conflict reason is classified per design §2434 ("Sync Conflict
 * Tray Reasons") so the UI can render actionable wording without
 * re-deriving it from the HTTP status:
 *
 *   - 403 → `forbidden`           — "You no longer have permission…"
 *   - 404 → `not_found`           — "…no longer exists on the server."
 *   - 409 → `conflict`            — "Someone else updated this…"
 *   - any other 4xx (e.g. 422)    → `validation`
 *   - everything else             → `unknown`
 *
 * Implements: Requirement 44.4 (task 36.5).
 */

import {
  enqueue as enqueueOutbox,
  type OutboxEntry,
} from './Outbox';

/**
 * `chrome.storage.local` key under which the conflict tray is
 * persisted. Exposed so the Custom Element and tests can stub or
 * subscribe to the same key.
 */
export const CONFLICT_STORAGE_KEY = 'pinpoint_sync_conflicts';

/**
 * Classified reason for a sync conflict. Mirrors the table in design
 * §"Sync Conflict Tray Reasons" so the UI can pick a user-facing
 * sentence without re-deriving from the HTTP status. `unknown` is the
 * fallback for any 4xx the matrix does not call out so a future server
 * change does not silently drop conflicts on the floor.
 */
export type SyncConflictReason =
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'unknown';

/**
 * One row in the conflict tray. Carries the original outbox entry so
 * "Retry" and "Edit" can reconstruct the request, plus the
 * classification that drives the UX wording.
 */
export interface SyncConflict {
  /** Mirror of `entry.localUuid` for fast lookups by the UI. */
  localUuid: string;
  /** Original queued entry, untouched. */
  entry: OutboxEntry;
  /** HTTP status returned by the server on replay. */
  httpStatus: number;
  /** Classification — see `SyncConflictReason` for the table. */
  reason: SyncConflictReason;
  /**
   * Free-form server message extracted from the response body's
   * `error.message`. May be undefined when the body was missing,
   * non-JSON, or did not match the standard envelope.
   */
  serverMessage?: string;
  /** Replay attempt count. Increments on every retry that re-conflicts. */
  attempts: number;
  /** ISO 8601 timestamp set when the entry first landed in the tray. */
  detectedAt: string;
}

/**
 * Translate an HTTP status into the conflict reason the tray will
 * display. The 403/404/409 task brief explicitly calls out — anything
 * else falls back to `validation` (for other 4xx) or `unknown`.
 */
export function classifyConflictReason(status: number): SyncConflictReason {
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 400 && status < 500) return 'validation';
  return 'unknown';
}

async function readConflicts(): Promise<SyncConflict[]> {
  const result = await chrome.storage.local.get(CONFLICT_STORAGE_KEY);
  const raw = result?.[CONFLICT_STORAGE_KEY];
  return Array.isArray(raw) ? (raw as SyncConflict[]) : [];
}

async function writeConflicts(entries: SyncConflict[]): Promise<void> {
  await chrome.storage.local.set({ [CONFLICT_STORAGE_KEY]: entries });
}

/**
 * Append `conflict` to the tray, preserving insertion order. If a
 * conflict for the same `localUuid` already exists (e.g., the user hit
 * Retry and the replay still bounced), the existing row is updated in
 * place: `httpStatus`, `reason`, `serverMessage`, and `detectedAt` are
 * refreshed and `attempts` is incremented. This way the tray never
 * grows duplicates for a single failed entry.
 */
export async function moveToConflictTray(
  conflict: SyncConflict,
): Promise<void> {
  const conflicts = await readConflicts();
  const idx = conflicts.findIndex((c) => c.localUuid === conflict.localUuid);
  if (idx === -1) {
    conflicts.push(conflict);
  } else {
    const previous = conflicts[idx]!;
    conflicts[idx] = {
      ...conflict,
      attempts: previous.attempts + 1,
    };
  }
  await writeConflicts(conflicts);
}

/** Return every conflicted entry in insertion order. */
export async function listConflicts(): Promise<SyncConflict[]> {
  return await readConflicts();
}

/**
 * Remove the conflict whose `localUuid` matches. Silently no-ops when
 * no conflict matches so the UI can fire the action repeatedly without
 * worrying about races against another tab that already discarded it.
 */
export async function discardConflict(localUuid: string): Promise<void> {
  const conflicts = await readConflicts();
  const next = conflicts.filter((c) => c.localUuid !== localUuid);
  if (next.length === conflicts.length) return;
  await writeConflicts(next);
}

/**
 * Move the conflicted entry back into the live outbox so the next
 * Syncer drain re-attempts it. The conflict row is removed from the
 * tray; the original `OutboxEntry` is appended to the end of the
 * outbox (FIFO position relative to anything queued *after* the
 * conflict was detected — design call: a manual retry is the user's
 * "I want to send this now" gesture, so it joins the back of the
 * line rather than jumping ahead).
 *
 * Silently no-ops when no conflict matches.
 */
export async function retryConflict(localUuid: string): Promise<void> {
  const conflicts = await readConflicts();
  const target = conflicts.find((c) => c.localUuid === localUuid);
  if (!target) return;
  const next = conflicts.filter((c) => c.localUuid !== localUuid);
  await writeConflicts(next);
  await enqueueOutbox(target.entry);
}

/**
 * Replace the queued payload of a conflicted entry (used by "Edit" in
 * the tray once the user has reconfirmed the body / target / etc.) and
 * then move the entry back into the outbox for replay. Returns `true`
 * when the swap happened, `false` when no conflict matched the id so
 * callers can surface "this conflict already went away" errors.
 *
 * The entry the caller hands in is the *replacement* entry — the
 * `localUuid` must equal the conflict's `localUuid` so the server's
 * idempotency layer (task 35.2) recognises the retry. Callers
 * (`<fl-sync-conflict-tray>` Edit handler) are expected to derive it
 * from the conflict's `entry` and overlay the new payload.
 */
export async function editAndRetryConflict(
  localUuid: string,
  replacement: OutboxEntry,
): Promise<boolean> {
  if (replacement.localUuid !== localUuid) return false;
  const conflicts = await readConflicts();
  const target = conflicts.find((c) => c.localUuid === localUuid);
  if (!target) return false;
  const next = conflicts.filter((c) => c.localUuid !== localUuid);
  await writeConflicts(next);
  await enqueueOutbox(replacement);
  return true;
}
