/**
 * Outbox — durable FIFO queue of mutating operations awaiting sync to the
 * Pinpoint server.
 *
 * Backed by `chrome.storage.local` under the key `pinpoint_outbox`.
 * The Extension's API client (task 36.2) writes to the outbox first
 * whenever the user creates, updates, or comments on an annotation,
 * returns the local UUID immediately, and lets the Syncer (task 36.3)
 * replay entries when connectivity returns.
 *
 * `chrome.storage.local` survives service-worker terminations and tab
 * closes, satisfying the "queued operations persist across reload"
 * requirement (design §30, Req 44.2). Each entry carries a
 * client-generated UUID v4 so retries are idempotent against the server's
 * `clientRequestId` columns (task 35.1).
 *
 * Implements: Requirement 44.2.
 */

/**
 * `chrome.storage.local` key under which the queue is persisted. Exposed
 * so tests and the Syncer can target the same key when stubbing or
 * subscribing to `chrome.storage.onChanged`.
 */
export const OUTBOX_STORAGE_KEY = 'pinpoint_outbox';

/**
 * Operation kinds the Extension queues while offline. Matches task 36.1's
 * spec; the broader design (`OutboxOpKind` in design.md §"Outbox + Sync")
 * may grow to include `update-annotation` once 36.2 lands.
 */
export type OutboxKind =
  | 'create-annotation'
  | 'create-comment'
  | 'change-status';

/**
 * A single queued operation. `localUuid` is the stable client-generated
 * UUID v4 used as `clientRequestId` on retries; `pendingSync` is fixed at
 * `true` while the entry sits in the queue and is dropped when the
 * Syncer removes the entry on a successful POST.
 */
export interface OutboxEntry {
  /** Client-generated UUID v4; stable across retries. */
  localUuid: string;
  /** Operation kind. */
  kind: OutboxKind;
  /** Operation-specific request body (untyped at this layer). */
  payload: unknown;
  /** Always `true` while queued; the entry is removed once accepted. */
  pendingSync: true;
  /** ISO 8601 timestamp set when the entry is first enqueued. */
  createdAt: string;
}

async function readEntries(): Promise<OutboxEntry[]> {
  const result = await chrome.storage.local.get(OUTBOX_STORAGE_KEY);
  const raw = result?.[OUTBOX_STORAGE_KEY];
  return Array.isArray(raw) ? (raw as OutboxEntry[]) : [];
}

async function writeEntries(entries: OutboxEntry[]): Promise<void> {
  await chrome.storage.local.set({ [OUTBOX_STORAGE_KEY]: entries });
}

/**
 * Append `entry` to the end of the outbox, preserving FIFO order.
 *
 * The Syncer replays entries in this order so a `create-comment` queued
 * after its parent `create-annotation` always sees the canonical id from
 * the earlier replay (design §30, Req 44.3).
 */
export async function enqueue(entry: OutboxEntry): Promise<void> {
  const entries = await readEntries();
  entries.push(entry);
  await writeEntries(entries);
}

/** Return every queued entry in insertion order. */
export async function list(): Promise<OutboxEntry[]> {
  return await readEntries();
}

/**
 * Remove the entry whose `localUuid` matches. Silently no-ops when no
 * entry matches so callers do not have to special-case races where the
 * Syncer already removed it.
 */
export async function remove(localUuid: string): Promise<void> {
  const entries = await readEntries();
  const next = entries.filter((e) => e.localUuid !== localUuid);
  if (next.length === entries.length) return;
  await writeEntries(next);
}

/**
 * Replace the entry whose `localUuid` matches with `serverEntry`,
 * preserving its position in the queue. Silently no-ops when no entry
 * matches. Used by the Syncer (task 36.4) to rewrite local UUIDs to
 * canonical server-assigned ids without disturbing replay order.
 */
export async function replace(
  localUuid: string,
  serverEntry: OutboxEntry,
): Promise<void> {
  const entries = await readEntries();
  const idx = entries.findIndex((e) => e.localUuid === localUuid);
  if (idx === -1) return;
  const next = entries.slice();
  next[idx] = serverEntry;
  await writeEntries(next);
}
