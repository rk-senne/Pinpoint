/**
 * Syncer — drains the Outbox (task 36.1) by replaying queued mutations
 * against the Pinpoint API in original FIFO order, attaching
 * `clientRequestId = entry.localUuid` so the server's idempotent-replay
 * path (task 35.2) recognises retries and short-circuits to 200 with
 * `X-FL-Idempotent-Replay: true` instead of inserting a duplicate row.
 *
 * Implements: Requirement 44.3 (the `online` + 30 s interval contract from
 * design §30) and Requirement 44.4 (Sync_Conflict_Tray routing on
 * 403/404/409). The module's behaviour:
 *
 *   - 2xx response → parse the server envelope, swap the locally
 *     generated UUID and (for annotations) the placeholder
 *     `pinNumber=0` for the server-assigned values via the `SyncRemap
 *     Adapter`, cascade the same id swap into any *other* outbox
 *     entries whose payloads reference the local id (e.g., a comment
 *     queued under an unsynced annotation), then `Outbox.remove(local
 *     Uuid)` and advance to the next entry. — task 36.4.
 *   - 403/404/409 response → move the entry to the
 *     Sync_Conflict_Tray (`./SyncConflictTray`) with the classified
 *     reason and the server's `error.message`, drop it from the live
 *     outbox, and advance to the next entry. The tray UI surfaces
 *     Retry / Edit / Discard. — task 36.5.
 *   - Other non-2xx (5xx, 401, 422, …) or thrown network error →
 *     leave the entry in place and halt the run so the queue stays
 *     in original order; the next `online` event or 30 s tick picks
 *     it up.
 *
 * Every replayed call goes through `apiFetchRaw` from `./api`, which is
 * the *underlying* network path (it does **not** write back to the
 * Outbox). Task 36.2 wraps the higher-level mutation helpers — not this
 * module — so the Syncer is recursion-free.
 */

import {
  list as listOutbox,
  remove as removeFromOutbox,
  replace as replaceInOutbox,
  type OutboxEntry,
  type OutboxKind,
} from './Outbox';
import {
  classifyConflictReason,
  moveToConflictTray,
  type SyncConflict,
} from './SyncConflictTray';
import { apiFetchRaw } from './api';
import { DOMTargetResolver } from './DOMTargetResolver';
import type { DOMTarget } from '@pinpoint/shared';

/** How often the Syncer ticks while the page is open. Design §30 / Req 44.3. */
export const SYNC_INTERVAL_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* Remap adapter — task 36.4                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Hook the Syncer calls after the server accepts a queued mutation. The
 * Syncer has no awareness of the overlay store; the content script
 * registers an adapter via `setSyncRemapAdapter` that fans the server-
 * assigned `{ id, pinNumber }` (annotations) or `{ id }` (comments)
 * back into the overlay's in-memory `Annotation[]` and `Comment[]`
 * signals so the optimistic row's `id === localUuid` becomes
 * `id === serverId` and `pinNumber` gets its real value.
 *
 * Cascade rewrites of *other* outbox entries (e.g., a comment queued
 * under the optimistic annotation, or a status flip targeting it)
 * happen inside the Syncer itself — the adapter is purely the in-
 * memory store update. Keeping the two concerns separate means the
 * adapter is trivially mockable in unit tests and the durable cascade
 * still happens even when no adapter is registered (e.g., headless
 * service-worker contexts).
 */
export interface SyncRemapAdapter {
  /**
   * Server accepted a queued create-annotation. Replace the row whose
   * `id === localUuid` with `{ id: serverId, pinNumber, ...serverAnnotation }`.
   * Implementations should be defensive: if the row has already been
   * reconciled by a `annotation:created` socket broadcast, this is a
   * no-op rather than a duplicate insert.
   */
  remapAnnotation?: (
    localUuid: string,
    serverAnnotation: ServerAnnotation,
  ) => void;
  /**
   * Server accepted a queued create-comment. Replace the comment row
   * whose `id === localUuid` with the server-canonical row. Same
   * defensive contract as `remapAnnotation`.
   */
  remapComment?: (
    localUuid: string,
    serverComment: ServerComment,
  ) => void;
  /**
   * Task 36.7 — flag the optimistic pin whose `id === localUuid` as
   * "target may have moved". Called by the Syncer just before replaying
   * a queued create-annotation when re-resolving the stored
   * `DOMTarget` against the live DOM either returns `null` (selector
   * does not resolve) or returns an element whose tag/bounding box
   * differs from the one captured at capture time — both indicate the
   * page mutated between capture and replay so the pin's anchor is
   * suspect (Req 44.6).
   *
   * Implementations should mirror the same fallback contract used by
   * `PinPositioner` when the live target is missing: set
   * `data-fallback="true"` on the underlying `<fl-annotation-pin>` so
   * the warning ring renders, and surface a "Target may have moved"
   * notice in the popover when this annotation is opened. The flag is
   * advisory — it does not block the replay; the server still gets
   * the original payload because the user's textual feedback is the
   * source of truth, not the anchor.
   */
  flagPinAsStale?: (localUuid: string) => void;
}

/**
 * Minimal subset of the server's annotation envelope the Syncer
 * forwards to the adapter. The Syncer itself only reads `id` and
 * `pinNumber` to drive the cascade; the rest is passed through so the
 * adapter can splice the canonical row into the store without re-
 * fetching.
 */
export interface ServerAnnotation {
  id: string;
  pinNumber: number;
  [key: string]: unknown;
}

/** Minimal subset of the server's comment envelope. */
export interface ServerComment {
  id: string;
  [key: string]: unknown;
}

/**
 * Module-level adapter set by `setSyncRemapAdapter`. The content
 * script registers it once on bootstrap; tests override it as needed.
 * `null` means "no adapter": the Syncer still cascades id rewrites in
 * the outbox so subsequent replays target the canonical id, but the
 * in-memory overlay store is left to a separate reconciliation
 * pathway (e.g., the next time the content script reseeds the
 * `annotations` signal from `GET /projects/:id/annotations`).
 */
let remapAdapter: SyncRemapAdapter | null = null;

/**
 * Register (or clear, by passing `null`) the adapter the Syncer calls
 * after every successful replay. Idempotent — repeated calls overwrite
 * the previous adapter, so production code can call it once on
 * bootstrap and tests can swap it freely.
 */
export function setSyncRemapAdapter(adapter: SyncRemapAdapter | null): void {
  remapAdapter = adapter;
}

/* -------------------------------------------------------------------------- */
/* Module state — guarded by `installed` and `inflight` for idempotency       */
/* -------------------------------------------------------------------------- */

let installed = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
let onlineHandler: (() => void) | null = null;
let registeredTarget: Window | null = null;

/**
 * Singleton in-flight promise. Concurrent callers share a single drain so
 * the head of the queue cannot be processed twice in parallel — without
 * this the `online` event firing while an interval-driven flush is still
 * uploading would race for the same `Outbox.remove(localUuid)` call and
 * the second loser would observe an already-removed entry.
 */
let inflight: Promise<void> | null = null;

/* -------------------------------------------------------------------------- */
/* Request building                                                           */
/* -------------------------------------------------------------------------- */

interface BuiltRequest {
  readonly path: string;
  readonly method: 'POST' | 'PUT';
  readonly body: Record<string, unknown>;
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Translate an `OutboxEntry` into the HTTP request the Syncer should
 * issue. Mirrors the routes the live API client uses today
 * (`content.ts#onHostAction`):
 *
 *   - `create-annotation` → `POST /projects/:projectId/annotations`
 *   - `create-comment`    → `POST /annotations/:annotationId/comments`
 *   - `change-status`     → `PUT  /annotations/:annotationId/status`
 *
 * The payload contract task 36.2 is expected to write into the Outbox:
 * a flat object with the route's URL parameter (`projectId` /
 * `annotationId`) **plus** every field that belongs in the request
 * body. The Syncer pops the URL parameter off, prepends the route, and
 * puts everything else (with `clientRequestId = localUuid` appended) in
 * the body. Returns `null` when the payload lacks the required URL
 * parameter so callers can halt the run without dispatching a
 * malformed request.
 */
function buildRequest(entry: OutboxEntry): BuiltRequest | null {
  const payload = asPlainObject(entry.payload);
  switch (entry.kind) {
    case 'create-annotation': {
      const projectId = payload['projectId'];
      if (typeof projectId !== 'string' || projectId.length === 0) return null;
      const { projectId: _drop, ...rest } = payload;
      return {
        method: 'POST',
        path: `/projects/${encodeURIComponent(projectId)}/annotations`,
        body: { ...rest, clientRequestId: entry.localUuid },
      };
    }
    case 'create-comment': {
      const annotationId = payload['annotationId'];
      if (typeof annotationId !== 'string' || annotationId.length === 0) {
        return null;
      }
      const { annotationId: _drop, ...rest } = payload;
      return {
        method: 'POST',
        path: `/annotations/${encodeURIComponent(annotationId)}/comments`,
        body: { ...rest, clientRequestId: entry.localUuid },
      };
    }
    case 'change-status': {
      const annotationId = payload['annotationId'];
      if (typeof annotationId !== 'string' || annotationId.length === 0) {
        return null;
      }
      const { annotationId: _drop, ...rest } = payload;
      return {
        method: 'PUT',
        path: `/annotations/${encodeURIComponent(annotationId)}/status`,
        // `change-status` is naturally idempotent on
        // `(annotationId, status)`, but we still attach `clientRequestId`
        // so server-side replay logging stays consistent across kinds.
        body: { ...rest, clientRequestId: entry.localUuid },
      };
    }
    default: {
      // Exhaustiveness check — TypeScript will complain if a new
      // `OutboxKind` is added without a case above.
      const _exhaustive: never = entry.kind;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Pull `error.message` out of the standard Pinpoint API error
 * envelope (`{ error: { code, message, ... } }`). Returns `undefined`
 * when the body is missing, non-JSON, or does not match the envelope
 * shape so the conflict tray UI can fall back to the reason-based
 * wording.
 */
async function readServerErrorMessage(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } } | null;
    const message = body?.error?.message;
    return typeof message === 'string' && message.length > 0 ? message : undefined;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Stale-target detection (task 36.7, Req 44.6)                                */
/* -------------------------------------------------------------------------- */

/**
 * Pull the stored `DOMTarget` out of a queued create-annotation
 * payload. Returns `null` for malformed payloads so the caller can
 * skip the re-resolve step — the request building / outbox layers
 * already short-circuit on those, this helper just needs to fail
 * gracefully without throwing.
 */
function readQueuedDomTarget(payload: unknown): DOMTarget | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const target = (payload as { target?: unknown }).target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return null;
  }
  return target as DOMTarget;
}

/**
 * Decide whether the live DOM element re-resolved from a stored
 * selector differs enough from the one captured at click time that
 * the local pin should be marked stale. Compares the tag name and the
 * bounding rect (rounded to integers so sub-pixel jitter does not
 * trip a false positive). Either a missing element or a mismatch on
 * either axis returns `true`.
 *
 * The stored snapshot lives on the `DOMTarget` itself: `tagName` is
 * captured verbatim and `pageX/pageY` carry the rect's top-left
 * corner relative to the page (post-`window.scrollX/Y`). If those
 * fields are missing — older queued entries pre-date the fields —
 * we conservatively skip the bounding-rect comparison and fall back
 * to "tag must match".
 */
function isResolvedTargetStale(
  resolved: Element | null,
  stored: DOMTarget,
): boolean {
  if (!resolved) return true;
  if (
    typeof stored.tagName === 'string' &&
    stored.tagName.length > 0 &&
    resolved.tagName !== stored.tagName
  ) {
    return true;
  }
  if (
    typeof stored.pageX === 'number' &&
    typeof stored.pageY === 'number' &&
    Number.isFinite(stored.pageX) &&
    Number.isFinite(stored.pageY)
  ) {
    let rect: DOMRect;
    try {
      rect = resolved.getBoundingClientRect();
    } catch {
      // Detached / shadow / cross-origin frame — treat as stale so
      // the user gets the warning. The replay still proceeds.
      return true;
    }
    const scrollX =
      typeof window !== 'undefined' && typeof window.scrollX === 'number'
        ? window.scrollX
        : 0;
    const scrollY =
      typeof window !== 'undefined' && typeof window.scrollY === 'number'
        ? window.scrollY
        : 0;
    const livePageX = Math.round(rect.left + scrollX);
    const livePageY = Math.round(rect.top + scrollY);
    const storedX = Math.round(stored.pageX);
    const storedY = Math.round(stored.pageY);
    if (livePageX !== storedX || livePageY !== storedY) {
      return true;
    }
  }
  return false;
}

/**
 * Re-resolve the stored `DOMTarget` of a queued create-annotation
 * against the live DOM and, when the resolved element is missing or
 * differs from the captured snapshot, ask the registered adapter to
 * flag the local pin as stale (Req 44.6, task 36.7).
 *
 * The function is best-effort: every failure path (no `document`, no
 * adapter, throwing resolver, throwing adapter) is swallowed so the
 * drain stays on its happy path. The replay still hits the network —
 * the server payload is unchanged.
 */
function maybeFlagStalePin(entry: OutboxEntry): void {
  if (entry.kind !== 'create-annotation') return;
  if (typeof document === 'undefined') return;
  const target = readQueuedDomTarget(entry.payload);
  if (!target) return;

  let resolved: Element | null = null;
  try {
    resolved = DOMTargetResolver.resolveSelector(target);
  } catch {
    resolved = null;
  }

  if (!isResolvedTargetStale(resolved, target)) return;

  try {
    remapAdapter?.flagPinAsStale?.(entry.localUuid);
  } catch {
    /* swallow — adapter must not break the drain */
  }
}

/* -------------------------------------------------------------------------- */
/* Drain loop                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Replay the head of the queue. Returns `true` when the entry was
 * accepted by the server (and therefore removed from the Outbox), and
 * `false` when the run should halt (network failure, non-2xx status,
 * malformed payload). Halting on non-2xx keeps the head intact so task
 * 36.5 can route it to the Sync_Conflict_Tray when it lands.
 */
async function replayHead(entry: OutboxEntry): Promise<boolean> {
  const built = buildRequest(entry);
  if (!built) {
    // Malformed payload — leave in place and halt so we don't burn a
    // network call every 30 s on a bad row. Task 36.5 will route this.
    return false;
  }

  // Task 36.7 / Req 44.6 — re-resolve the queued create-annotation's
  // stored DOM target against the live page BEFORE issuing the POST.
  // When the selector no longer resolves (or resolves to a different
  // element than the one we captured), flag the optimistic pin so the
  // user sees the warning ring + "Target may have moved" notice. The
  // replay itself proceeds untouched — the user's body is the source
  // of truth, not the anchor.
  maybeFlagStalePin(entry);

  let res: Response;
  try {
    res = await apiFetchRaw(built.path, {
      method: built.method,
      body: JSON.stringify(built.body),
    });
  } catch {
    // Network failure — leave the entry in place. The next `online`
    // event or interval tick retries automatically.
    return false;
  }

  if (!res.ok) {
    // Task 36.5 — Sync_Conflict_Tray routing.
    //
    // 403/404/409 are non-recoverable from the syncer's perspective:
    // retrying the same payload at the same target will keep
    // bouncing. Move the entry off the live outbox into the conflict
    // tray so the user can review the reason and pick Retry / Edit /
    // Discard. The drain then continues with the next head — other
    // queued ops do not need to wait for the conflicted one.
    //
    // Other non-2xx statuses (e.g., 5xx) keep the existing halt-and-
    // retry behaviour so a transient outage does not flood the tray
    // and the next `online` event or interval tick can pick up where
    // we left off.
    if (res.status === 403 || res.status === 404 || res.status === 409) {
      const serverMessage = await readServerErrorMessage(res);
      const conflict: SyncConflict = {
        localUuid: entry.localUuid,
        entry,
        httpStatus: res.status,
        reason: classifyConflictReason(res.status),
        serverMessage,
        attempts: 1,
        detectedAt: new Date().toISOString(),
      };
      await moveToConflictTray(conflict);
      await removeFromOutbox(entry.localUuid);
      // Returning `true` lets the drain advance to the next head — the
      // conflicted entry is no longer in the outbox so the loop will
      // pick up whatever is now at index 0.
      return true;
    }
    // 5xx, 401, 422, etc. — leave in place and halt so the next tick
    // retries. Halting on transient failures keeps `clientRequestId`
    // intact and avoids partially-applied drains.
    return false;
  }

  // Task 36.4 — UUID rewrite on success.
  //
  // Parse the server envelope, fan the canonical id (and `pinNumber`
  // for annotations) into the overlay store via `remapAdapter`, and
  // cascade the same id swap into any *other* outbox entries that
  // referenced the local id (e.g., a comment queued under the
  // optimistic annotation, or a status flip targeting it). The cascade
  // happens BEFORE we remove the head so a crash mid-rewrite leaves
  // the queue in a recoverable state — on the next drain the head
  // re-replays under the same `clientRequestId` and the server's
  // idempotency layer (task 35.2) returns the same canonical row, and
  // we redo the cascade with identical results.
  const envelope = (await res
    .json()
    .catch(() => null)) as Record<string, unknown> | null;

  await applyRemap(entry, envelope);

  // Success — drop the entry from the Outbox.
  await removeFromOutbox(entry.localUuid);
  return true;
}

/**
 * Translate the success envelope into a `{ localUuid, serverId,
 * pinNumber? }` triple, fan the canonical row into the overlay store
 * via the registered adapter, and rewrite any other outbox entries
 * that referenced `localUuid` so their next replay targets the server
 * id instead.
 *
 * Defensive against:
 *   - Missing/non-JSON response body (`envelope === null`): the
 *     cascade still runs with `serverId === localUuid` so the queue
 *     stays internally consistent. The server's idempotent-replay
 *     short-circuit (`X-FL-Idempotent-Replay: true`) takes this path.
 *   - Adapter throwing: the cascade still runs, the head is still
 *     removed, and the caller is unaware. The adapter is best-effort
 *     UI sugar; the durable Outbox state is the source of truth.
 *   - Server returning the same id we already have (idempotent
 *     replay): no cascade needed, but we still call the adapter so the
 *     UI can settle `pinNumber` if it was 0 on the optimistic row.
 */
async function applyRemap(
  entry: OutboxEntry,
  envelope: Record<string, unknown> | null,
): Promise<void> {
  switch (entry.kind) {
    case 'create-annotation': {
      const serverAnnotation = readServerAnnotation(envelope);
      if (serverAnnotation) {
        try {
          remapAdapter?.remapAnnotation?.(entry.localUuid, serverAnnotation);
        } catch {
          /* swallow — adapter must not break the drain */
        }
        if (serverAnnotation.id !== entry.localUuid) {
          await cascadeAnnotationId(entry.localUuid, serverAnnotation.id);
        }
      }
      break;
    }
    case 'create-comment': {
      const serverComment = readServerComment(envelope);
      if (serverComment) {
        try {
          remapAdapter?.remapComment?.(entry.localUuid, serverComment);
        } catch {
          /* swallow — adapter must not break the drain */
        }
        // No cascade target for comments today: the only field that
        // could carry a comment id forward (e.g., reply-to a queued
        // comment) doesn't exist in the current OutboxKind list. Add
        // when nested-comment threading lands.
      }
      break;
    }
    case 'change-status': {
      // Status changes don't return a new id — the row already exists
      // server-side. Nothing to remap.
      break;
    }
    default: {
      const _exhaustive: never = entry.kind;
      void _exhaustive;
    }
  }
}

/**
 * Pull `{ id, pinNumber, ... }` out of the server's
 * `POST /projects/:id/annotations` 201/200 envelope. Returns `null`
 * when the envelope is missing or malformed. The server wraps the row
 * in `{ annotation: {...} }` (see `formatAnnotation` in
 * `server/src/routes/annotations.ts`).
 */
function readServerAnnotation(
  envelope: Record<string, unknown> | null,
): ServerAnnotation | null {
  if (!envelope) return null;
  const raw = (envelope as { annotation?: unknown }).annotation;
  if (!raw || typeof raw !== 'object') return null;
  const id = (raw as { id?: unknown }).id;
  const pinNumber = (raw as { pinNumber?: unknown }).pinNumber;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof pinNumber !== 'number' || !Number.isFinite(pinNumber)) {
    return null;
  }
  return { ...(raw as Record<string, unknown>), id, pinNumber };
}

/**
 * Pull `{ id, ... }` out of the server's `POST /annotations/:id/comments`
 * envelope. Same wrapping pattern: `{ comment: {...} }`.
 */
function readServerComment(
  envelope: Record<string, unknown> | null,
): ServerComment | null {
  if (!envelope) return null;
  const raw = (envelope as { comment?: unknown }).comment;
  if (!raw || typeof raw !== 'object') return null;
  const id = (raw as { id?: unknown }).id;
  if (typeof id !== 'string' || id.length === 0) return null;
  return { ...(raw as Record<string, unknown>), id };
}

/**
 * Walk the rest of the outbox and rewrite any entry that referenced
 * the locally-generated annotation UUID so its next replay targets the
 * server-assigned id. Matters for `create-comment` entries whose
 * `payload.annotationId === localUuid` and `change-status` entries
 * whose `payload.annotationId === localUuid`. The head entry itself
 * (the one we just successfully replayed) is excluded because it's
 * about to be removed by the caller.
 */
async function cascadeAnnotationId(
  localUuid: string,
  serverId: string,
): Promise<void> {
  if (localUuid === serverId) return;
  const entries = await listOutbox();
  for (const e of entries) {
    if (e.localUuid === localUuid) continue; // head — `removeFromOutbox` finalises it
    if (e.kind !== 'create-comment' && e.kind !== 'change-status') continue;
    const payload = e.payload;
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      continue;
    }
    const current = (payload as { annotationId?: unknown }).annotationId;
    if (current !== localUuid) continue;
    const nextPayload = {
      ...(payload as Record<string, unknown>),
      annotationId: serverId,
    };
    await replaceInOutbox(e.localUuid, { ...e, payload: nextPayload });
  }
}

/**
 * Drain the queue until either it's empty or `replayHead` signals a
 * halt. Re-reads the queue every iteration so an entry enqueued during
 * the run (e.g., a fresh mutation while the previous one's POST is in
 * flight) is picked up without waiting for the next interval tick.
 */
async function drain(): Promise<void> {
  // Bounded loop guard — the queue can only grow by external enqueues,
  // each of which is paired with a `triggerSync` call that joins the
  // existing in-flight promise. The bound is high enough to drain any
  // realistic offline session and low enough to terminate even if a
  // regression starts re-enqueuing the same head.
  for (let i = 0; i < 1024; i++) {
    const entries = await listOutbox();
    if (entries.length === 0) return;
    const advanced = await replayHead(entries[0]);
    if (!advanced) return;
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Drain the Outbox now, returning a promise that resolves when the run
 * finishes. Concurrent calls share a single in-flight drain so the
 * queue is never processed twice in parallel.
 *
 * Safe to call from anywhere — the API client wrapper (task 36.2) calls
 * it after enqueueing a fresh mutation, the `online` event listener
 * calls it on connectivity-restore, and the 30 s interval calls it
 * periodically.
 */
export function triggerSync(): Promise<void> {
  if (inflight) return inflight;
  const promise = drain().finally(() => {
    if (inflight === promise) inflight = null;
  });
  inflight = promise;
  return promise;
}

/**
 * Install the `online` event listener and the 30 s `setInterval` tick.
 * Idempotent — repeated calls (HMR, double script injection) leave a
 * single listener and a single interval registered.
 *
 * The content script invokes this once on module load.
 */
export function startSyncer(
  target: Window | undefined = typeof window !== 'undefined' ? window : undefined,
): void {
  if (installed) return;
  installed = true;

  if (target && typeof target.addEventListener === 'function') {
    onlineHandler = () => {
      // Errors are absorbed by `drain` — log nothing here so the host
      // page doesn't see noise from offline-mode plumbing.
      void triggerSync();
    };
    target.addEventListener('online', onlineHandler);
    registeredTarget = target;
  }

  intervalId = setInterval(() => {
    void triggerSync();
  }, SYNC_INTERVAL_MS);
}

/**
 * Test-only teardown. Production code never needs to stop the Syncer —
 * the content script's lifetime matches the page's. Tests use this to
 * isolate runs so the interval and `online` listener from one spec
 * don't leak into the next.
 */
export function __stopSyncerForTests(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (registeredTarget && onlineHandler) {
    registeredTarget.removeEventListener('online', onlineHandler);
  }
  onlineHandler = null;
  registeredTarget = null;
  installed = false;
  inflight = null;
  remapAdapter = null;
}

/**
 * Test-only inspector that mirrors the `OutboxKind` enum back to spec
 * code so tests can reason about which kinds the Syncer recognises
 * without re-importing from `Outbox.ts`. Underscore prefix matches the
 * convention used by `__resetForTests` / `__stopSyncerForTests`.
 */
export const __knownOutboxKindsForTests: readonly OutboxKind[] = [
  'create-annotation',
  'create-comment',
  'change-status',
];
