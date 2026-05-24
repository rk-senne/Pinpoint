// @vitest-environment jsdom
/**
 * Unit tests for the Syncer (task 36.3, Req 44.3).
 *
 * Coverage matrix:
 *
 *   - `online` event triggers a flush.
 *   - The 30 s interval triggers a flush.
 *   - Concurrent `triggerSync` calls share one in-flight drain (no double-
 *     processing of the head — singleton guard).
 *   - A successful flush removes entries from the Outbox in original
 *     FIFO order and attaches `clientRequestId = entry.localUuid`.
 *   - A network failure leaves the entry in place; the next tick retries.
 *   - A non-2xx response halts the run and leaves entries in place.
 *
 * `apiFetchRaw` and the `Outbox` module are mocked at module-resolution
 * time so the Syncer runs in pure isolation under jsdom (no real
 * `chrome.storage.local`, no real network).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { OutboxEntry } from './Outbox';

const { apiFetchRawMock, listMock, removeMock, replaceMock, moveToConflictTrayMock } = vi.hoisted(() => ({
  apiFetchRawMock: vi.fn(),
  listMock: vi.fn(),
  removeMock: vi.fn(),
  replaceMock: vi.fn(),
  moveToConflictTrayMock: vi.fn(),
}));

vi.mock('./api', () => ({
  apiFetchRaw: apiFetchRawMock,
}));

vi.mock('./Outbox', () => ({
  list: listMock,
  remove: removeMock,
  replace: replaceMock,
  // Re-export the type-only symbols as constants so any `import type`
  // statements still resolve at runtime under vitest's module graph.
  OUTBOX_STORAGE_KEY: 'pinpoint_outbox',
}));

vi.mock('./SyncConflictTray', () => ({
  moveToConflictTray: moveToConflictTrayMock,
  classifyConflictReason: (status: number) => {
    if (status === 403) return 'forbidden';
    if (status === 404) return 'not_found';
    if (status === 409) return 'conflict';
    if (status >= 400 && status < 500) return 'validation';
    return 'unknown';
  },
}));

// Task 36.7 / Req 44.6 — re-resolve the queued create-annotation's
// stored selector against the live DOM before the POST. Mocked so
// individual tests can program the resolution result.
const { resolveSelectorMock } = vi.hoisted(() => ({
  resolveSelectorMock: vi.fn(),
}));

vi.mock('./DOMTargetResolver', () => ({
  DOMTargetResolver: {
    resolveSelector: resolveSelectorMock,
  },
}));

// Imported AFTER the mocks are registered.
import {
  triggerSync,
  startSyncer,
  setSyncRemapAdapter,
  __stopSyncerForTests,
  SYNC_INTERVAL_MS,
} from './Syncer';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function makeEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    localUuid: overrides.localUuid ?? `uuid-${Math.random().toString(36).slice(2, 8)}`,
    kind: overrides.kind ?? 'create-annotation',
    payload:
      overrides.payload ??
      ({
        projectId: 'project-1',
        type: 'note',
        severity: 'critical',
        body: 'hello',
        target: { cssSelector: 'body' },
      } as unknown),
    pendingSync: true,
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00.000Z',
  };
}

function jsonOk(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonStatus(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Backing store for the mocked Outbox. Tests push entries here and the
 * `list`/`remove` mocks read/write through it so the Syncer's drain
 * loop sees a realistic FIFO queue.
 */
let queue: OutboxEntry[] = [];

beforeEach(() => {
  queue = [];
  apiFetchRawMock.mockReset();
  listMock.mockReset();
  removeMock.mockReset();
  replaceMock.mockReset();
  moveToConflictTrayMock.mockReset();
  resolveSelectorMock.mockReset();
  // Default: re-resolve returns null so existing tests (which never
  // configure this mock) don't accidentally flag pins as stale. Tests
  // that exercise the stale-target path (task 36.7) override this
  // explicitly.
  resolveSelectorMock.mockReturnValue(null);

  listMock.mockImplementation(async () => queue.slice());
  removeMock.mockImplementation(async (localUuid: string) => {
    queue = queue.filter((e) => e.localUuid !== localUuid);
  });
  replaceMock.mockImplementation(async (localUuid: string, next: OutboxEntry) => {
    const idx = queue.findIndex((e) => e.localUuid === localUuid);
    if (idx === -1) return;
    queue[idx] = next;
  });
});

afterEach(() => {
  __stopSyncerForTests();
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('Syncer.triggerSync — successful drain', () => {
  it('removes entries in FIFO order and attaches clientRequestId = localUuid', async () => {
    const a = makeEntry({
      localUuid: 'uuid-A',
      kind: 'create-annotation',
      payload: { projectId: 'p1', body: 'first' },
    });
    const b = makeEntry({
      localUuid: 'uuid-B',
      kind: 'create-comment',
      payload: { annotationId: 'ann-7', body: 'second' },
    });
    const c = makeEntry({
      localUuid: 'uuid-C',
      kind: 'change-status',
      payload: { annotationId: 'ann-7', status: 'resolved' },
    });
    queue = [a, b, c];

    apiFetchRawMock.mockResolvedValue(jsonOk());

    await triggerSync();

    // All three entries drained in order.
    expect(apiFetchRawMock).toHaveBeenCalledTimes(3);

    const callA = apiFetchRawMock.mock.calls[0];
    expect(callA[0]).toBe('/projects/p1/annotations');
    expect(callA[1].method).toBe('POST');
    const bodyA = JSON.parse(callA[1].body as string);
    expect(bodyA.clientRequestId).toBe('uuid-A');
    expect(bodyA.body).toBe('first');
    expect('projectId' in bodyA).toBe(false);

    const callB = apiFetchRawMock.mock.calls[1];
    expect(callB[0]).toBe('/annotations/ann-7/comments');
    expect(callB[1].method).toBe('POST');
    const bodyB = JSON.parse(callB[1].body as string);
    expect(bodyB.clientRequestId).toBe('uuid-B');
    expect(bodyB.body).toBe('second');
    expect('annotationId' in bodyB).toBe(false);

    const callC = apiFetchRawMock.mock.calls[2];
    expect(callC[0]).toBe('/annotations/ann-7/status');
    expect(callC[1].method).toBe('PUT');
    const bodyC = JSON.parse(callC[1].body as string);
    expect(bodyC.clientRequestId).toBe('uuid-C');
    expect(bodyC.status).toBe('resolved');

    // Outbox is empty.
    expect(queue).toEqual([]);
    expect(removeMock).toHaveBeenCalledWith('uuid-A');
    expect(removeMock).toHaveBeenCalledWith('uuid-B');
    expect(removeMock).toHaveBeenCalledWith('uuid-C');
  });

  it('is a no-op when the outbox is empty', async () => {
    queue = [];
    await triggerSync();
    expect(apiFetchRawMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });
});

describe('Syncer.triggerSync — failure semantics', () => {
  it('leaves the entry in place when the network call throws', async () => {
    const a = makeEntry({ localUuid: 'uuid-A' });
    queue = [a];

    apiFetchRawMock.mockRejectedValueOnce(new Error('TypeError: failed to fetch'));

    await triggerSync();

    expect(apiFetchRawMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();
    expect(queue).toEqual([a]);
  });

  it('halts on a transient non-conflict response (e.g., 5xx) and leaves the head + tail in place', async () => {
    const a = makeEntry({ localUuid: 'uuid-A' });
    const b = makeEntry({ localUuid: 'uuid-B' });
    queue = [a, b];

    apiFetchRawMock.mockResolvedValueOnce(jsonStatus(500, { error: 'kaboom' }));

    await triggerSync();

    // Head was attempted; tail was NOT attempted (FIFO halt). 5xx is
    // a transient failure so the conflict tray is NOT involved —
    // the next tick replays under the same `clientRequestId`.
    expect(apiFetchRawMock).toHaveBeenCalledTimes(1);
    expect(removeMock).not.toHaveBeenCalled();
    expect(moveToConflictTrayMock).not.toHaveBeenCalled();
    expect(queue).toEqual([a, b]);
  });

  it('retries the same head on a subsequent flush', async () => {
    const a = makeEntry({ localUuid: 'uuid-A' });
    queue = [a];

    apiFetchRawMock.mockRejectedValueOnce(new Error('offline'));
    await triggerSync();
    expect(queue).toEqual([a]);

    apiFetchRawMock.mockResolvedValueOnce(jsonOk());
    await triggerSync();
    expect(queue).toEqual([]);
    expect(apiFetchRawMock).toHaveBeenCalledTimes(2);
  });
});

describe('Syncer.triggerSync — Sync_Conflict_Tray routing (task 36.5, Req 44.4)', () => {
  /**
   * 403/404/409 are non-recoverable from the syncer's perspective —
   * retrying the same payload at the same target keeps bouncing — so
   * the entry moves to the conflict tray and the drain continues with
   * whatever is now at the head. Anything else (5xx, 422, etc.) keeps
   * the existing halt-and-retry semantics.
   */
  it.each([
    { status: 403, reason: 'forbidden', message: 'You no longer have access' },
    { status: 404, reason: 'not_found', message: 'Annotation not found' },
    { status: 409, reason: 'conflict', message: 'Conflicting status update' },
  ])(
    'on $status moves the entry to the conflict tray with the server message',
    async ({ status, reason, message }) => {
      const a = makeEntry({ localUuid: 'uuid-A' });
      queue = [a];

      apiFetchRawMock.mockResolvedValueOnce(
        jsonStatus(status, { error: { code: 'X', message } }),
      );

      await triggerSync();

      expect(moveToConflictTrayMock).toHaveBeenCalledTimes(1);
      const [conflict] = moveToConflictTrayMock.mock.calls[0]!;
      expect(conflict.localUuid).toBe('uuid-A');
      expect(conflict.entry).toEqual(a);
      expect(conflict.httpStatus).toBe(status);
      expect(conflict.reason).toBe(reason);
      expect(conflict.serverMessage).toBe(message);
      expect(conflict.attempts).toBe(1);
      expect(typeof conflict.detectedAt).toBe('string');

      // Entry was removed from the live outbox so the drain can advance.
      expect(removeMock).toHaveBeenCalledWith('uuid-A');
      expect(queue).toEqual([]);
    },
  );

  it('on 403 the drain advances to the next entry instead of halting', async () => {
    const a = makeEntry({ localUuid: 'uuid-A' });
    const b = makeEntry({ localUuid: 'uuid-B' });
    queue = [a, b];

    apiFetchRawMock
      .mockResolvedValueOnce(jsonStatus(403, { error: { code: 'X', message: 'no perm' } }))
      .mockResolvedValueOnce(jsonOk());

    await triggerSync();

    // Both heads were processed: the first conflicted (and was moved
    // to the tray), the second succeeded.
    expect(apiFetchRawMock).toHaveBeenCalledTimes(2);
    expect(moveToConflictTrayMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith('uuid-A');
    expect(removeMock).toHaveBeenCalledWith('uuid-B');
    expect(queue).toEqual([]);
  });

  it('on 500 (transient) does NOT route to the conflict tray and halts the drain', async () => {
    const a = makeEntry({ localUuid: 'uuid-A' });
    const b = makeEntry({ localUuid: 'uuid-B' });
    queue = [a, b];

    apiFetchRawMock.mockResolvedValueOnce(jsonStatus(500, { error: { message: 'down' } }));

    await triggerSync();

    expect(moveToConflictTrayMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(apiFetchRawMock).toHaveBeenCalledTimes(1);
    expect(queue).toEqual([a, b]);
  });

  it('on 422 (validation) does NOT route to the conflict tray and halts the drain', async () => {
    // The task brief explicitly limits the conflict tray to 403/404/409.
    // 422 keeps existing halt-and-retry semantics so the user can fix
    // the payload locally without seeing the tray.
    const a = makeEntry({ localUuid: 'uuid-A' });
    queue = [a];

    apiFetchRawMock.mockResolvedValueOnce(
      jsonStatus(422, { error: { message: 'body too long' } }),
    );

    await triggerSync();

    expect(moveToConflictTrayMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(queue).toEqual([a]);
  });

  it('captures undefined serverMessage when the body is missing or non-JSON', async () => {
    const a = makeEntry({ localUuid: 'uuid-A' });
    queue = [a];

    apiFetchRawMock.mockResolvedValueOnce(
      new Response('not-json', { status: 404, headers: { 'Content-Type': 'text/plain' } }),
    );

    await triggerSync();

    expect(moveToConflictTrayMock).toHaveBeenCalledTimes(1);
    const [conflict] = moveToConflictTrayMock.mock.calls[0]!;
    expect(conflict.serverMessage).toBeUndefined();
    expect(conflict.httpStatus).toBe(404);
  });
});

describe('Syncer.triggerSync — singleton guard', () => {
  it('concurrent calls share a single in-flight drain', async () => {
    const a = makeEntry({ localUuid: 'uuid-A' });
    queue = [a];

    // Resolve apiFetchRaw on a deferred promise so we can observe two
    // concurrent triggerSync() callers racing for the same head.
    let resolveFetch!: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    apiFetchRawMock.mockReturnValueOnce(pending);

    const p1 = triggerSync();
    const p2 = triggerSync();

    // Both promises must be the same in-flight drain — concurrent
    // callers share, they don't stack.
    expect(p1).toBe(p2);

    resolveFetch(jsonOk());
    await Promise.all([p1, p2]);

    // Even though two callers awaited, the entry was processed once.
    expect(apiFetchRawMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(queue).toEqual([]);
  });

  it('a fresh flush after the in-flight one settles processes new entries', async () => {
    const a = makeEntry({ localUuid: 'uuid-A' });
    queue = [a];

    apiFetchRawMock.mockResolvedValueOnce(jsonOk());
    await triggerSync();
    expect(queue).toEqual([]);

    // Simulate task 36.2 enqueuing a fresh entry, then the API client
    // calling triggerSync — the previous in-flight is gone, so a new
    // drain kicks off.
    const b = makeEntry({ localUuid: 'uuid-B' });
    queue = [b];

    apiFetchRawMock.mockResolvedValueOnce(jsonOk());
    await triggerSync();

    expect(apiFetchRawMock).toHaveBeenCalledTimes(2);
    expect(queue).toEqual([]);
  });
});

describe('Syncer.startSyncer — online + interval triggers', () => {
  it('flushes when the window dispatches an `online` event', async () => {
    const a = makeEntry({ localUuid: 'uuid-A' });
    queue = [a];

    apiFetchRawMock.mockResolvedValue(jsonOk());

    startSyncer(window);

    // No drain has happened yet — `startSyncer` is wire-up only.
    expect(apiFetchRawMock).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('online'));
    // The handler is fire-and-forget — let microtasks drain so the
    // mocked promises settle before we assert.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(apiFetchRawMock).toHaveBeenCalledTimes(1);
    expect(queue).toEqual([]);
  });

  it('flushes when the 30 s interval fires', async () => {
    vi.useFakeTimers();

    const a = makeEntry({ localUuid: 'uuid-A' });
    queue = [a];

    apiFetchRawMock.mockResolvedValue(jsonOk());

    startSyncer(window);

    expect(apiFetchRawMock).not.toHaveBeenCalled();

    // Advance to the first tick. The handler is fire-and-forget so we
    // need to flush the resulting microtasks too.
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);

    expect(apiFetchRawMock).toHaveBeenCalledTimes(1);
    expect(queue).toEqual([]);
  });

  it('startSyncer is idempotent — repeat calls do not stack listeners or intervals', async () => {
    const a = makeEntry({ localUuid: 'uuid-A' });
    queue = [a];

    apiFetchRawMock.mockResolvedValue(jsonOk());

    startSyncer(window);
    startSyncer(window);
    startSyncer(window);

    window.dispatchEvent(new Event('online'));
    // Fire-and-forget handler — let microtasks settle so the mocked
    // promises resolve before we assert.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Exactly one drain ran, even though `online` was dispatched once
    // against three would-be listeners. If the listener had been
    // registered three times the singleton guard would still coalesce
    // the drains, but the entry would be removed exactly once and
    // `apiFetchRaw` would be called exactly once.
    expect(apiFetchRawMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledTimes(1);
  });
});

describe('Syncer.triggerSync — request-shape edge cases', () => {
  it('drops the URL parameter from the request body', async () => {
    const a = makeEntry({
      localUuid: 'uuid-A',
      kind: 'create-annotation',
      payload: { projectId: 'P', type: 'note', body: 'x' },
    });
    queue = [a];

    apiFetchRawMock.mockResolvedValueOnce(jsonOk());
    await triggerSync();

    const body = JSON.parse(apiFetchRawMock.mock.calls[0][1].body as string);
    expect('projectId' in body).toBe(false);
    expect(body.type).toBe('note');
    expect(body.body).toBe('x');
    expect(body.clientRequestId).toBe('uuid-A');
  });

  it('halts (no remove) when payload is missing the URL parameter', async () => {
    const a = makeEntry({
      localUuid: 'uuid-A',
      kind: 'create-comment',
      // Missing `annotationId` — the Syncer cannot build a route.
      payload: { body: 'orphan' },
    });
    queue = [a];

    await triggerSync();

    expect(apiFetchRawMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(queue).toEqual([a]);
  });
});

/* -------------------------------------------------------------------------- */
/* Task 36.4 — UUID rewrite on success + cascade                              */
/* -------------------------------------------------------------------------- */

describe('Syncer.triggerSync — UUID rewrite on success (task 36.4, Req 44.3)', () => {
  afterEach(() => {
    setSyncRemapAdapter(null);
  });

  /**
   * Success envelope helper. Mirrors the server's
   * `POST /projects/:id/annotations` response: 201 with
   * `{ annotation: { id, pinNumber, ... } }`.
   */
  function annotationOk(serverId: string, pinNumber: number): Response {
    return new Response(
      JSON.stringify({
        annotation: {
          id: serverId,
          pinNumber,
          projectId: 'proj-1',
          status: 'active',
          body: 'ok',
        },
      }),
      {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  /**
   * Comment success envelope. Server returns 201 with
   * `{ comment: { id, ... } }`.
   */
  function commentOk(serverId: string): Response {
    return new Response(
      JSON.stringify({
        comment: {
          id: serverId,
          annotationId: 'ann-server',
          body: 'ok',
        },
      }),
      {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  it('hands the local UUID + canonical { id, pinNumber } to the remap adapter', async () => {
    const remapAnnotation = vi.fn();
    setSyncRemapAdapter({ remapAnnotation });

    const a = makeEntry({
      localUuid: 'uuid-A',
      kind: 'create-annotation',
      payload: { projectId: 'proj-1', body: 'hello' },
    });
    queue = [a];

    apiFetchRawMock.mockResolvedValueOnce(annotationOk('ann-server-7', 42));

    await triggerSync();

    expect(remapAnnotation).toHaveBeenCalledTimes(1);
    const [localUuid, serverAnnotation] = remapAnnotation.mock.calls[0]!;
    expect(localUuid).toBe('uuid-A');
    expect(serverAnnotation.id).toBe('ann-server-7');
    expect(serverAnnotation.pinNumber).toBe(42);

    // Head was removed only AFTER the adapter ran, so the queue is now empty.
    expect(queue).toEqual([]);
    expect(removeMock).toHaveBeenCalledWith('uuid-A');
  });

  it('cascades the id rewrite into a comment queued under the optimistic annotation', async () => {
    const remapAnnotation = vi.fn();
    setSyncRemapAdapter({ remapAnnotation });

    // The user creates an annotation while offline ("uuid-A"), then
    // immediately drops a comment on it. Both entries are queued
    // back-to-back; the comment's payload references the optimistic id.
    const annotation = makeEntry({
      localUuid: 'uuid-A',
      kind: 'create-annotation',
      payload: { projectId: 'proj-1', body: 'parent annotation' },
    });
    const comment = makeEntry({
      localUuid: 'uuid-COMMENT',
      kind: 'create-comment',
      payload: {
        annotationId: 'uuid-A', // optimistic — must be rewritten on parent's success
        body: 'first thought',
        mentions: [],
      },
    });
    queue = [annotation, comment];

    apiFetchRawMock.mockResolvedValueOnce(annotationOk('ann-canonical', 3));
    // Halt after the parent succeeds so we can observe the rewritten
    // comment still sitting in the queue without it racing on to the
    // next replay (covered separately by the integration of 36.3 + 36.4).
    apiFetchRawMock.mockRejectedValueOnce(new Error('halt drain after parent'));

    await triggerSync();

    // After the parent succeeded:
    //   1. The cascade rewrote the comment's `annotationId` to the
    //      server-assigned id BEFORE the parent was removed.
    //   2. The parent was then removed, leaving only the (rewritten)
    //      comment in the queue ready for the next replay.
    expect(queue).toHaveLength(1);
    expect(queue[0]!.localUuid).toBe('uuid-COMMENT');
    expect((queue[0]!.payload as { annotationId: string }).annotationId).toBe(
      'ann-canonical',
    );

    // The cascade went through `Outbox.replace` so the entry's queue
    // position is preserved and any other fields stay intact.
    expect(replaceMock).toHaveBeenCalledTimes(1);

    expect(remapAnnotation).toHaveBeenCalledWith(
      'uuid-A',
      expect.objectContaining({ id: 'ann-canonical', pinNumber: 3 }),
    );
  });

  it('cascades into change-status entries that target the optimistic annotation', async () => {
    setSyncRemapAdapter(null);

    const annotation = makeEntry({
      localUuid: 'uuid-A',
      kind: 'create-annotation',
      payload: { projectId: 'proj-1', body: 'parent annotation' },
    });
    const status = makeEntry({
      localUuid: 'uuid-STATUS',
      kind: 'change-status',
      payload: { annotationId: 'uuid-A', status: 'resolved' },
    });
    queue = [annotation, status];

    apiFetchRawMock.mockResolvedValueOnce(annotationOk('ann-canonical', 1));
    apiFetchRawMock.mockRejectedValueOnce(new Error('halt drain after parent'));

    await triggerSync();

    expect(queue).toHaveLength(1);
    expect(queue[0]!.localUuid).toBe('uuid-STATUS');
    expect((queue[0]!.payload as { annotationId: string }).annotationId).toBe(
      'ann-canonical',
    );
  });

  it('does not touch unrelated outbox entries during a cascade', async () => {
    const annotation = makeEntry({
      localUuid: 'uuid-A',
      kind: 'create-annotation',
      payload: { projectId: 'proj-1', body: 'parent A' },
    });
    const otherComment = makeEntry({
      localUuid: 'uuid-OTHER',
      kind: 'create-comment',
      payload: {
        annotationId: 'ann-other-real-id',
        body: 'unrelated',
        mentions: [],
      },
    });
    queue = [annotation, otherComment];

    apiFetchRawMock.mockResolvedValueOnce(annotationOk('ann-canonical', 5));
    apiFetchRawMock.mockRejectedValueOnce(new Error('halt drain after parent'));

    await triggerSync();

    expect(queue).toHaveLength(1);
    expect(queue[0]!.localUuid).toBe('uuid-OTHER');
    // Untouched: the unrelated comment did not point at the rewritten
    // local uuid, so its annotationId is unchanged.
    expect((queue[0]!.payload as { annotationId: string }).annotationId).toBe(
      'ann-other-real-id',
    );
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('hands the canonical { id } to the comment remap adapter', async () => {
    const remapComment = vi.fn();
    setSyncRemapAdapter({ remapComment });

    const c = makeEntry({
      localUuid: 'uuid-COMMENT',
      kind: 'create-comment',
      payload: {
        annotationId: 'ann-server',
        body: 'first thought',
        mentions: [],
      },
    });
    queue = [c];

    apiFetchRawMock.mockResolvedValueOnce(commentOk('cmt-server-99'));

    await triggerSync();

    expect(remapComment).toHaveBeenCalledTimes(1);
    const [localUuid, serverComment] = remapComment.mock.calls[0]!;
    expect(localUuid).toBe('uuid-COMMENT');
    expect(serverComment.id).toBe('cmt-server-99');
    expect(queue).toEqual([]);
  });

  it('removes the head only after the cascade and remap have completed', async () => {
    const trace: string[] = [];

    setSyncRemapAdapter({
      remapAnnotation: () => {
        trace.push('remap');
      },
    });

    replaceMock.mockImplementation(async (localUuid: string, next: OutboxEntry) => {
      trace.push('cascade');
      const idx = queue.findIndex((e) => e.localUuid === localUuid);
      if (idx === -1) return;
      queue[idx] = next;
    });
    removeMock.mockImplementation(async (localUuid: string) => {
      trace.push('remove');
      queue = queue.filter((e) => e.localUuid !== localUuid);
    });

    const annotation = makeEntry({
      localUuid: 'uuid-A',
      kind: 'create-annotation',
      payload: { projectId: 'proj-1', body: 'parent' },
    });
    const comment = makeEntry({
      localUuid: 'uuid-COMMENT',
      kind: 'create-comment',
      payload: { annotationId: 'uuid-A', body: 'child', mentions: [] },
    });
    queue = [annotation, comment];

    apiFetchRawMock.mockResolvedValueOnce(annotationOk('ann-canonical', 1));
    // Halt the drain so we don't burn another mocked fetch on the
    // (now-rewritten) child entry; this test is only asserting the
    // ordering of the parent's success path.
    apiFetchRawMock.mockRejectedValueOnce(new Error('halt'));

    await triggerSync();

    // Adapter and cascade run before the head is removed so a crash
    // mid-cascade is recoverable on the next drain (the head replays
    // under the same clientRequestId and the server's idempotency
    // layer returns the same canonical row).
    expect(trace[0]).toBe('remap');
    expect(trace[1]).toBe('cascade');
    expect(trace[2]).toBe('remove');
  });

  it('still removes the head when the response body is missing or non-JSON', async () => {
    setSyncRemapAdapter({ remapAnnotation: vi.fn() });

    const a = makeEntry({
      localUuid: 'uuid-A',
      kind: 'create-annotation',
      payload: { projectId: 'proj-1', body: 'no body' },
    });
    queue = [a];

    apiFetchRawMock.mockResolvedValueOnce(
      new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );

    await triggerSync();

    // No remap (envelope is missing) but the head is still removed —
    // halting on a missing body would jam the queue forever.
    expect(queue).toEqual([]);
    expect(removeMock).toHaveBeenCalledWith('uuid-A');
  });

  it('survives a remap adapter that throws', async () => {
    setSyncRemapAdapter({
      remapAnnotation: () => {
        throw new Error('store update failed');
      },
    });

    const annotation = makeEntry({
      localUuid: 'uuid-A',
      kind: 'create-annotation',
      payload: { projectId: 'proj-1', body: 'parent' },
    });
    const comment = makeEntry({
      localUuid: 'uuid-COMMENT',
      kind: 'create-comment',
      payload: { annotationId: 'uuid-A', body: 'child', mentions: [] },
    });
    queue = [annotation, comment];

    apiFetchRawMock.mockResolvedValueOnce(annotationOk('ann-canonical', 9));
    apiFetchRawMock.mockRejectedValueOnce(new Error('halt'));

    await triggerSync();

    // Adapter blew up but the durable Outbox still got cascaded and
    // the head still got removed — the cascade is the source of truth
    // for "the next replay targets the canonical id".
    expect(queue).toHaveLength(1);
    expect((queue[0]!.payload as { annotationId: string }).annotationId).toBe(
      'ann-canonical',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Task 36.7 — stale-target flag on create-annotation replay (Req 44.6)        */
/* -------------------------------------------------------------------------- */

describe('Syncer.triggerSync — stale-target flag on create-annotation (task 36.7, Req 44.6)', () => {
  afterEach(() => {
    setSyncRemapAdapter(null);
  });

  /**
   * Helper that builds a create-annotation entry whose payload carries
   * the full DOMTarget snapshot the resolver re-checks on replay (the
   * default `makeEntry` only puts a partial target in place).
   */
  function makeAnnotationEntry(
    overrides: Partial<{
      localUuid: string;
      cssSelector: string;
      tagName: string;
      pageX: number;
      pageY: number;
    }> = {},
  ): OutboxEntry {
    return makeEntry({
      localUuid: overrides.localUuid ?? 'uuid-stale',
      kind: 'create-annotation',
      payload: {
        projectId: 'proj-1',
        type: 'note',
        severity: 'critical',
        body: 'hello',
        target: {
          cssSelector: overrides.cssSelector ?? '#hero',
          xpath: '/html/body/div[1]',
          tagName: overrides.tagName ?? 'DIV',
          pageX: overrides.pageX ?? 100,
          pageY: overrides.pageY ?? 200,
          textSnippet: 'hero',
        },
      },
    });
  }

  /**
   * Build an Element whose `getBoundingClientRect()` reports the
   * given page coordinates (with `window.scrollX/Y === 0` under
   * jsdom). `tagName` lets us simulate a swap to a different element
   * type at the same selector path.
   */
  function fakeElement(opts: {
    tagName?: string;
    pageX?: number;
    pageY?: number;
  } = {}): Element {
    const tag = opts.tagName ?? 'DIV';
    const x = opts.pageX ?? 100;
    const y = opts.pageY ?? 200;
    return {
      tagName: tag,
      getBoundingClientRect: () => ({
        left: x,
        top: y,
        right: x + 10,
        bottom: y + 10,
        width: 10,
        height: 10,
        x,
        y,
        toJSON() { return undefined; },
      }) as DOMRect,
    } as unknown as Element;
  }

  it('does NOT flag the pin when the stored selector still resolves to a matching element', async () => {
    const flagPinAsStale = vi.fn();
    setSyncRemapAdapter({ flagPinAsStale });

    const entry = makeAnnotationEntry({
      localUuid: 'uuid-INTACT',
      cssSelector: '#hero',
      tagName: 'DIV',
      pageX: 100,
      pageY: 200,
    });
    queue = [entry];

    // Live DOM still has the element at the same place with the same tag.
    resolveSelectorMock.mockReturnValueOnce(
      fakeElement({ tagName: 'DIV', pageX: 100, pageY: 200 }),
    );
    apiFetchRawMock.mockResolvedValueOnce(jsonOk());

    await triggerSync();

    expect(resolveSelectorMock).toHaveBeenCalledTimes(1);
    expect(resolveSelectorMock).toHaveBeenCalledWith(
      expect.objectContaining({ cssSelector: '#hero', tagName: 'DIV' }),
    );
    expect(flagPinAsStale).not.toHaveBeenCalled();
    // Normal flow — entry was replayed and removed.
    expect(apiFetchRawMock).toHaveBeenCalledTimes(1);
    expect(queue).toEqual([]);
  });

  it('calls flagPinAsStale with the localUuid when the selector no longer resolves', async () => {
    const flagPinAsStale = vi.fn();
    setSyncRemapAdapter({ flagPinAsStale });

    const entry = makeAnnotationEntry({ localUuid: 'uuid-MISSING' });
    queue = [entry];

    // Selector returns nothing — element is gone.
    resolveSelectorMock.mockReturnValueOnce(null);
    apiFetchRawMock.mockResolvedValueOnce(jsonOk());

    await triggerSync();

    expect(flagPinAsStale).toHaveBeenCalledTimes(1);
    expect(flagPinAsStale).toHaveBeenCalledWith('uuid-MISSING');
    // Replay still proceeded — the user's textual feedback is the
    // source of truth, not the anchor.
    expect(apiFetchRawMock).toHaveBeenCalledTimes(1);
    expect(queue).toEqual([]);
  });

  it('flags the pin when the resolver returns an element with a different tag', async () => {
    const flagPinAsStale = vi.fn();
    setSyncRemapAdapter({ flagPinAsStale });

    const entry = makeAnnotationEntry({
      localUuid: 'uuid-TAG-MISMATCH',
      tagName: 'DIV',
    });
    queue = [entry];

    // Same selector path now points at a SPAN — the page mutated.
    resolveSelectorMock.mockReturnValueOnce(
      fakeElement({ tagName: 'SPAN', pageX: 100, pageY: 200 }),
    );
    apiFetchRawMock.mockResolvedValueOnce(jsonOk());

    await triggerSync();

    expect(flagPinAsStale).toHaveBeenCalledWith('uuid-TAG-MISMATCH');
  });

  it('flags the pin when the resolved element sits at different page coordinates', async () => {
    const flagPinAsStale = vi.fn();
    setSyncRemapAdapter({ flagPinAsStale });

    const entry = makeAnnotationEntry({
      localUuid: 'uuid-MOVED',
      pageX: 100,
      pageY: 200,
    });
    queue = [entry];

    // Same tag, but the layout shifted — bounding rect no longer
    // matches the captured snapshot.
    resolveSelectorMock.mockReturnValueOnce(
      fakeElement({ tagName: 'DIV', pageX: 350, pageY: 600 }),
    );
    apiFetchRawMock.mockResolvedValueOnce(jsonOk());

    await triggerSync();

    expect(flagPinAsStale).toHaveBeenCalledWith('uuid-MOVED');
  });

  it('does not invoke the resolver for non-create-annotation entries', async () => {
    const flagPinAsStale = vi.fn();
    setSyncRemapAdapter({ flagPinAsStale });

    const comment = makeEntry({
      localUuid: 'uuid-CMT',
      kind: 'create-comment',
      payload: { annotationId: 'ann-1', body: 'hi', mentions: [] },
    });
    const status = makeEntry({
      localUuid: 'uuid-STATUS',
      kind: 'change-status',
      payload: { annotationId: 'ann-1', status: 'resolved' },
    });
    queue = [comment, status];

    apiFetchRawMock.mockResolvedValue(jsonOk());

    await triggerSync();

    expect(resolveSelectorMock).not.toHaveBeenCalled();
    expect(flagPinAsStale).not.toHaveBeenCalled();
  });

  it('survives a flagPinAsStale adapter that throws', async () => {
    setSyncRemapAdapter({
      flagPinAsStale: () => {
        throw new Error('overlay update failed');
      },
    });

    const entry = makeAnnotationEntry({ localUuid: 'uuid-A' });
    queue = [entry];

    resolveSelectorMock.mockReturnValueOnce(null);
    apiFetchRawMock.mockResolvedValueOnce(jsonOk());

    // The drain must complete cleanly even though the adapter blew up.
    await expect(triggerSync()).resolves.toBeUndefined();
    expect(apiFetchRawMock).toHaveBeenCalledTimes(1);
    expect(queue).toEqual([]);
  });
});
