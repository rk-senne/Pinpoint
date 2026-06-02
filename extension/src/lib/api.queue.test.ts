// @vitest-environment jsdom
/**
 * Unit tests for the outbox-first mutating wrappers (`queueCreateAnnotation`,
 * `queueChangeAnnotationStatus`, `queueCreateComment`) added in task 36.2.
 *
 * Coverage:
 *   - Each wrapper:
 *       1. Generates a `localUuid` via the injected uuid factory.
 *       2. Persists exactly one `OutboxEntry` whose payload mirrors the
 *          eventual server-bound request body and carries
 *          `clientRequestId = localUuid`.
 *       3. Invokes the optimistic-row writer (when supplied) with the
 *          locally-built row whose `id` / `annotationId` matches
 *          `localUuid`.
 *       4. Triggers the Syncer.
 *       5. Returns `{ localUuid }` so the caller can correlate the
 *          optimistic row with the eventual server-assigned id.
 *   - Read-only `apiFetch`/`apiFetchRaw` calls are not affected: they
 *     don't touch the Outbox, don't trigger the Syncer.
 *   - The wrappers swallow Syncer errors / rejections (the durable
 *     enqueue is the source of truth; drain failures surface elsewhere).
 *
 * The `Outbox` and `Syncer` modules are injected as `deps` rather than
 * mocked through `vi.mock`, so the production defaults (which read /
 * write `chrome.storage.local`) never run during these specs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  apiFetchRaw,
  queueChangeAnnotationStatus,
  queueCreateAnnotation,
  queueCreateComment,
  type QueueMutationDeps,
} from './api';
import type { OutboxEntry } from './Outbox';
import type {
  Annotation,
  Comment as FLComment,
  DOMTarget,
  EnvironmentMetadata,
} from '@pinpoint/shared';

/* -------------------------------------------------------------------------- */
/* Test fixtures                                                              */
/* -------------------------------------------------------------------------- */

const FIXED_UUID = '00000000-0000-4000-8000-000000000001';
const FIXED_NOW = '2024-06-15T12:00:00.000Z';

function fixedDeps(overrides: Partial<QueueMutationDeps> = {}): {
  enqueueSpy: ReturnType<typeof vi.fn>;
  triggerSpy: ReturnType<typeof vi.fn>;
  deps: QueueMutationDeps;
} {
  const enqueueSpy = vi.fn(async (_entry: OutboxEntry) => {});
  const triggerSpy = vi.fn(() => {});
  return {
    enqueueSpy,
    triggerSpy,
    deps: {
      enqueueOutbox: enqueueSpy,
      triggerSync: triggerSpy,
      uuid: () => FIXED_UUID,
      now: () => FIXED_NOW,
      ...overrides,
    },
  };
}

function makeTarget(): DOMTarget {
  return {
    cssSelector: '#root > .row',
    xpath: '/html/body/div[1]/div[1]',
    pageX: 100,
    pageY: 200,
    tagName: 'div',
    textSnippet: 'Sample row',
  };
}

function makeEnvironment(): EnvironmentMetadata {
  return {
    browserFamily: 'Chrome',
    browserVersion: '124',
    osFamily: 'macOS',
    osVersion: '14.5',
    deviceType: 'desktop',
    userAgentRaw: 'Mozilla/5.0 (Macintosh; …)',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* queueCreateAnnotation                                                      */
/* -------------------------------------------------------------------------- */

describe('queueCreateAnnotation (task 36.2 / Reqs 44.1, 44.2)', () => {
  it('enqueues a single create-annotation entry whose payload mirrors the server request body', async () => {
    const { enqueueSpy, triggerSpy, deps } = fixedDeps();

    const result = await queueCreateAnnotation(
      {
        projectId: 'proj-1',
        pageId: 'page-1',
        pageUrl: 'https://example.test/inbox',
        type: 'note',
        severity: 'critical',
        body: 'broken layout',
        target: makeTarget(),
        environment: makeEnvironment(),
        capturedConsole: null,
        capturedNetwork: null,
      },
      null,
      deps,
    );

    // 1. Returns the freshly-minted localUuid.
    expect(result).toEqual({ localUuid: FIXED_UUID });

    // 2. Exactly one outbox row was written.
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const entry = enqueueSpy.mock.calls[0]![0] as OutboxEntry;
    expect(entry).toMatchObject({
      localUuid: FIXED_UUID,
      kind: 'create-annotation',
      pendingSync: true,
      createdAt: FIXED_NOW,
    });

    // 3. Payload carries every server-bound field plus `clientRequestId`.
    const payload = entry.payload as Record<string, unknown>;
    expect(payload.projectId).toBe('proj-1');
    expect(payload.pageUrl).toBe('https://example.test/inbox');
    expect(payload.pageId).toBe('page-1');
    expect(payload.type).toBe('note');
    expect(payload.severity).toBe('critical');
    expect(payload.body).toBe('broken layout');
    expect(payload.target).toEqual(makeTarget());
    expect(payload.environment).toEqual(makeEnvironment());
    expect(payload.capturedConsole).toBeNull();
    expect(payload.capturedNetwork).toBeNull();
    expect(payload.clientRequestId).toBe(FIXED_UUID);

    // 4. Syncer woke up.
    expect(triggerSpy).toHaveBeenCalledTimes(1);
  });

  it('invokes the optimistic writer with a row whose id equals the localUuid and pinNumber=0', async () => {
    const { deps } = fixedDeps();
    const writer = vi.fn();

    await queueCreateAnnotation(
      {
        projectId: 'proj-1',
        type: 'suggestion',
        severity: 'minor',
        body: 'tweak the spacing',
        target: makeTarget(),
        environment: makeEnvironment(),
      },
      writer,
      deps,
    );

    expect(writer).toHaveBeenCalledTimes(1);
    const optimistic = writer.mock.calls[0]![0] as Annotation;
    // The `id` is the localUuid so subsequent server reconciliation can
    // swap it for the canonical id once the Syncer (task 36.4) returns
    // the row from the server.
    expect(optimistic.id).toBe(FIXED_UUID);
    expect(optimistic.clientRequestId).toBe(FIXED_UUID);
    // pinNumber is 0 because the server is the only authority for that
    // counter (task 10.1); the Syncer rewrites on success.
    expect(optimistic.pinNumber).toBe(0);
    expect(optimistic.status).toBe('active');
    expect(optimistic.projectId).toBe('proj-1');
    expect(optimistic.type).toBe('suggestion');
    expect(optimistic.severity).toBe('minor');
    expect(optimistic.body).toBe('tweak the spacing');
    expect(optimistic.target).toEqual(makeTarget());
    expect(optimistic.environment).toEqual(makeEnvironment());
    expect(optimistic.createdAt).toBe(FIXED_NOW);
    expect(optimistic.updatedAt).toBe(FIXED_NOW);
  });

  it('respects an injected uuid override so callers can match a host-generated optimistic id', async () => {
    const externalId = 'ann-from-popover-uuid';
    const { enqueueSpy, deps } = fixedDeps({ uuid: () => externalId });

    const result = await queueCreateAnnotation(
      {
        projectId: 'proj-1',
        type: 'note',
        severity: 'minor',
        body: 'hi',
        target: makeTarget(),
        environment: makeEnvironment(),
      },
      null,
      deps,
    );

    expect(result.localUuid).toBe(externalId);
    const entry = enqueueSpy.mock.calls[0]![0] as OutboxEntry;
    expect(entry.localUuid).toBe(externalId);
    expect((entry.payload as { clientRequestId: string }).clientRequestId).toBe(
      externalId,
    );
  });

  it('returns the localUuid even when no optimistic writer is supplied', async () => {
    const { deps, enqueueSpy, triggerSpy } = fixedDeps();
    const result = await queueCreateAnnotation(
      {
        projectId: 'proj-1',
        type: 'note',
        severity: 'minor',
        body: 'no optimistic',
        target: makeTarget(),
        environment: makeEnvironment(),
      },
      null,
      deps,
    );
    expect(result).toEqual({ localUuid: FIXED_UUID });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(triggerSpy).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* queueChangeAnnotationStatus                                                */
/* -------------------------------------------------------------------------- */

describe('queueChangeAnnotationStatus (task 36.2 / Reqs 44.1, 44.2)', () => {
  it('enqueues a change-status entry with annotationId, status, and clientRequestId', async () => {
    const { enqueueSpy, triggerSpy, deps } = fixedDeps();

    const result = await queueChangeAnnotationStatus(
      { annotationId: 'ann-42', status: 'resolved' },
      null,
      deps,
    );

    expect(result).toEqual({ localUuid: FIXED_UUID });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const entry = enqueueSpy.mock.calls[0]![0] as OutboxEntry;
    expect(entry).toMatchObject({
      localUuid: FIXED_UUID,
      kind: 'change-status',
      pendingSync: true,
      createdAt: FIXED_NOW,
    });
    const payload = entry.payload as Record<string, unknown>;
    expect(payload.annotationId).toBe('ann-42');
    expect(payload.status).toBe('resolved');
    expect(payload.clientRequestId).toBe(FIXED_UUID);

    expect(triggerSpy).toHaveBeenCalledTimes(1);
  });

  it('hands the change payload to the optimistic writer (host already updated the row)', async () => {
    const { deps } = fixedDeps();
    const writer = vi.fn();

    await queueChangeAnnotationStatus(
      { annotationId: 'ann-42', status: 'in_progress' },
      writer,
      deps,
    );

    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith({
      annotationId: 'ann-42',
      status: 'in_progress',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* queueCreateComment                                                         */
/* -------------------------------------------------------------------------- */

describe('queueCreateComment (task 36.2 / Reqs 44.1, 44.2)', () => {
  it('enqueues a create-comment entry whose payload mirrors POST /comments', async () => {
    const { enqueueSpy, triggerSpy, deps } = fixedDeps();

    const result = await queueCreateComment(
      {
        annotationId: 'ann-7',
        body: 'thoughts? @bob',
        mentions: ['bob'],
      },
      null,
      deps,
    );

    expect(result).toEqual({ localUuid: FIXED_UUID });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const entry = enqueueSpy.mock.calls[0]![0] as OutboxEntry;
    expect(entry).toMatchObject({
      localUuid: FIXED_UUID,
      kind: 'create-comment',
      pendingSync: true,
      createdAt: FIXED_NOW,
    });
    const payload = entry.payload as Record<string, unknown>;
    expect(payload.annotationId).toBe('ann-7');
    expect(payload.body).toBe('thoughts? @bob');
    expect(payload.mentions).toEqual(['bob']);
    expect(payload.clientRequestId).toBe(FIXED_UUID);

    expect(triggerSpy).toHaveBeenCalledTimes(1);
  });

  it('builds an optimistic Comment whose id equals the localUuid', async () => {
    const { deps } = fixedDeps();
    const writer = vi.fn();

    await queueCreateComment(
      {
        annotationId: 'ann-7',
        body: 'optimistic',
        mentions: [],
      },
      writer,
      deps,
    );

    expect(writer).toHaveBeenCalledTimes(1);
    const optimistic = writer.mock.calls[0]![0] as FLComment;
    expect(optimistic.id).toBe(FIXED_UUID);
    expect(optimistic.clientRequestId).toBe(FIXED_UUID);
    expect(optimistic.annotationId).toBe('ann-7');
    expect(optimistic.body).toBe('optimistic');
    expect(optimistic.mentions).toEqual([]);
    expect(optimistic.createdAt).toBe(FIXED_NOW);
  });
});

/* -------------------------------------------------------------------------- */
/* Behavioural guarantees shared by all wrappers                              */
/* -------------------------------------------------------------------------- */

describe('queue wrappers — shared behaviour', () => {
  it('do not invoke the optimistic writer when none is supplied', async () => {
    const { deps } = fixedDeps();
    // None of these throw or attempt to call a missing writer.
    await expect(
      queueCreateAnnotation(
        {
          projectId: 'p',
          type: 'note',
          severity: 'minor',
          body: 'b',
          target: makeTarget(),
          environment: makeEnvironment(),
        },
        null,
        deps,
      ),
    ).resolves.toEqual({ localUuid: FIXED_UUID });

    await expect(
      queueChangeAnnotationStatus(
        { annotationId: 'a', status: 'resolved' },
        null,
        deps,
      ),
    ).resolves.toEqual({ localUuid: FIXED_UUID });

    await expect(
      queueCreateComment(
        { annotationId: 'a', body: 'b', mentions: [] },
        null,
        deps,
      ),
    ).resolves.toEqual({ localUuid: FIXED_UUID });
  });

  it('persist the outbox entry BEFORE invoking the optimistic writer or the Syncer', async () => {
    // The durable enqueue is the source of truth for "we promised the
    // user this mutation will reach the server", so it must complete
    // before any best-effort UI sugar runs. This test pins the order
    // by recording each side-effect into a single trace array.
    const trace: string[] = [];
    const enqueueSpy = vi.fn(async (_entry: OutboxEntry) => {
      trace.push('enqueue');
    });
    const triggerSpy = vi.fn(() => {
      trace.push('trigger');
    });
    const writer = vi.fn(() => {
      trace.push('optimistic');
    });

    await queueCreateAnnotation(
      {
        projectId: 'p',
        type: 'note',
        severity: 'minor',
        body: 'b',
        target: makeTarget(),
        environment: makeEnvironment(),
      },
      writer,
      {
        enqueueOutbox: enqueueSpy,
        triggerSync: triggerSpy,
        uuid: () => FIXED_UUID,
        now: () => FIXED_NOW,
      },
    );

    expect(trace).toEqual(['enqueue', 'optimistic', 'trigger']);
  });

  it('swallow Syncer errors so the durable enqueue still appears successful to the caller', async () => {
    const triggerSpy = vi.fn(() => {
      throw new Error('drain crashed');
    });
    const result = await queueCreateAnnotation(
      {
        projectId: 'p',
        type: 'note',
        severity: 'minor',
        body: 'b',
        target: makeTarget(),
        environment: makeEnvironment(),
      },
      null,
      {
        enqueueOutbox: vi.fn(async () => {}),
        triggerSync: triggerSpy,
        uuid: () => FIXED_UUID,
        now: () => FIXED_NOW,
      },
    );

    expect(result).toEqual({ localUuid: FIXED_UUID });
    expect(triggerSpy).toHaveBeenCalledTimes(1);
  });

  it('swallow Syncer rejections (Promise<void>) without surfacing an unhandled rejection', async () => {
    const triggerSpy = vi.fn(() => Promise.reject(new Error('flush failed')));
    const result = await queueCreateAnnotation(
      {
        projectId: 'p',
        type: 'note',
        severity: 'minor',
        body: 'b',
        target: makeTarget(),
        environment: makeEnvironment(),
      },
      null,
      {
        enqueueOutbox: vi.fn(async () => {}),
        triggerSync: triggerSpy,
        uuid: () => FIXED_UUID,
        now: () => FIXED_NOW,
      },
    );
    // Yield several microtasks so the rejected promise (chained in
    // `.catch(() => {})`) actually settles inside `fireAndForgetSync`.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(result).toEqual({ localUuid: FIXED_UUID });
    expect(triggerSpy).toHaveBeenCalledTimes(1);
  });

  it('propagate enqueue failures to the caller so the UI can surface them', async () => {
    // The durable enqueue is the source of truth — if `chrome.storage`
    // rejects (e.g., quota exceeded), the wrappers MUST throw so the
    // caller can decide whether to roll back the optimistic UI.
    const enqueueErr = new Error('chrome.storage.local quota exceeded');
    await expect(
      queueCreateAnnotation(
        {
          projectId: 'p',
          type: 'note',
          severity: 'minor',
          body: 'b',
          target: makeTarget(),
          environment: makeEnvironment(),
        },
        null,
        {
          enqueueOutbox: vi.fn(async () => {
            throw enqueueErr;
          }),
          triggerSync: vi.fn(),
          uuid: () => FIXED_UUID,
          now: () => FIXED_NOW,
        },
      ),
    ).rejects.toBe(enqueueErr);
  });
});

/* -------------------------------------------------------------------------- */
/* Read-only path is unchanged                                                */
/* -------------------------------------------------------------------------- */

describe('apiFetchRaw (GET) is unchanged by task 36.2', () => {
  it('does not touch the Outbox or Syncer for read-only requests', async () => {
    // Stub `chrome.storage.local.get` so the wrapper can resolve the
    // (absent) bearer without hitting the real Manifest V3 surface.
    const chromeStub = {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
      },
    };
    vi.stubGlobal('chrome', chromeStub);
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const res = await apiFetchRaw('/projects/by-url?url=https://x.test');
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // No outbox writes, no Syncer triggers — the queue helpers are
    // strictly opt-in and apiFetchRaw remains the underlying transport.
    expect(chromeStub.storage.local.set).not.toHaveBeenCalled();
  });
});
