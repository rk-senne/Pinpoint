/**
 * Unit tests for the SyncConflictTray library (task 36.5, Req 44.4).
 *
 * Mirrors the Outbox test harness: stubs `chrome.storage.local` via
 * `vi.stubGlobal` so the tray module runs under Node, then exercises
 * the move / list / discard / retry / edit-and-retry helpers and the
 * `classifyConflictReason` HTTP-status mapping.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  CONFLICT_STORAGE_KEY,
  classifyConflictReason,
  discardConflict,
  editAndRetryConflict,
  listConflicts,
  moveToConflictTray,
  retryConflict,
  type SyncConflict,
} from './SyncConflictTray';
import { OUTBOX_STORAGE_KEY, type OutboxEntry } from './Outbox';

let store: Record<string, unknown>;

interface ChromeStorageStub {
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (entries: Record<string, unknown>) => Promise<void>;
      remove: (key: string) => Promise<void>;
    };
  };
}

function buildChromeStub(): ChromeStorageStub {
  return {
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          if (key in store) return { [key]: store[key] };
          return {};
        }),
        set: vi.fn(async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) store[k] = v;
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key];
        }),
      },
    },
  };
}

function makeEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    localUuid: overrides.localUuid ?? 'uuid-default',
    kind: overrides.kind ?? 'create-annotation',
    payload: overrides.payload ?? { projectId: 'p1', body: 'hello' },
    pendingSync: true,
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00.000Z',
  };
}

function makeConflict(overrides: Partial<SyncConflict> = {}): SyncConflict {
  const entry = overrides.entry ?? makeEntry({ localUuid: overrides.localUuid });
  return {
    localUuid: overrides.localUuid ?? entry.localUuid,
    entry,
    httpStatus: overrides.httpStatus ?? 403,
    reason: overrides.reason ?? 'forbidden',
    serverMessage: overrides.serverMessage,
    attempts: overrides.attempts ?? 1,
    detectedAt: overrides.detectedAt ?? '2024-01-02T00:00:00.000Z',
  };
}

beforeEach(() => {
  store = {};
  vi.stubGlobal('chrome', buildChromeStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifyConflictReason', () => {
  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [422, 'validation'],
    [400, 'validation'],
    [499, 'validation'],
    [500, 'unknown'],
    [200, 'unknown'],
  ] as const)('classifies HTTP %i as %s', (status, reason) => {
    expect(classifyConflictReason(status)).toBe(reason);
  });
});

describe('moveToConflictTray', () => {
  it('persists the conflict under the pinpoint_sync_conflicts key', async () => {
    const conflict = makeConflict({ localUuid: 'uuid-A' });
    await moveToConflictTray(conflict);

    expect(store[CONFLICT_STORAGE_KEY]).toEqual([conflict]);
  });

  it('appends multiple conflicts in insertion order', async () => {
    const a = makeConflict({ localUuid: 'uuid-A' });
    const b = makeConflict({ localUuid: 'uuid-B', reason: 'not_found' });
    await moveToConflictTray(a);
    await moveToConflictTray(b);

    expect(await listConflicts()).toEqual([a, b]);
  });

  it('updates an existing conflict in place and increments attempts', async () => {
    const a = makeConflict({
      localUuid: 'uuid-A',
      reason: 'forbidden',
      attempts: 1,
      serverMessage: 'first',
    });
    await moveToConflictTray(a);

    // Same localUuid — second attempt with a different message.
    const aRetry = makeConflict({
      localUuid: 'uuid-A',
      reason: 'forbidden',
      attempts: 1,
      serverMessage: 'second',
    });
    await moveToConflictTray(aRetry);

    const conflicts = await listConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.attempts).toBe(2);
    expect(conflicts[0]!.serverMessage).toBe('second');
  });
});

describe('listConflicts', () => {
  it('returns an empty array when nothing is queued', async () => {
    expect(await listConflicts()).toEqual([]);
  });

  it('coerces a corrupt non-array slot to an empty list', async () => {
    store[CONFLICT_STORAGE_KEY] = 'not-an-array';
    expect(await listConflicts()).toEqual([]);
  });
});

describe('discardConflict', () => {
  it('removes the conflict whose localUuid matches', async () => {
    const a = makeConflict({ localUuid: 'uuid-A' });
    const b = makeConflict({ localUuid: 'uuid-B' });
    const c = makeConflict({ localUuid: 'uuid-C' });
    await moveToConflictTray(a);
    await moveToConflictTray(b);
    await moveToConflictTray(c);

    await discardConflict('uuid-B');

    expect((await listConflicts()).map((x) => x.localUuid)).toEqual([
      'uuid-A',
      'uuid-C',
    ]);
  });

  it('is a no-op when the localUuid is not in the tray', async () => {
    const a = makeConflict({ localUuid: 'uuid-A' });
    await moveToConflictTray(a);

    await discardConflict('non-existent');

    expect(await listConflicts()).toEqual([a]);
  });
});

describe('retryConflict', () => {
  it('moves the conflict back into the live outbox and removes it from the tray', async () => {
    const entry = makeEntry({ localUuid: 'uuid-A' });
    const conflict = makeConflict({ localUuid: 'uuid-A', entry });
    await moveToConflictTray(conflict);

    await retryConflict('uuid-A');

    // Tray is empty.
    expect(await listConflicts()).toEqual([]);
    // Outbox now has the original entry appended.
    expect(store[OUTBOX_STORAGE_KEY]).toEqual([entry]);
  });

  it('appends the entry to the END of the existing outbox', async () => {
    const queuedFirst = makeEntry({ localUuid: 'uuid-Q' });
    store[OUTBOX_STORAGE_KEY] = [queuedFirst];

    const entry = makeEntry({ localUuid: 'uuid-A' });
    const conflict = makeConflict({ localUuid: 'uuid-A', entry });
    await moveToConflictTray(conflict);

    await retryConflict('uuid-A');

    expect(store[OUTBOX_STORAGE_KEY]).toEqual([queuedFirst, entry]);
  });

  it('is a no-op when the localUuid is not in the tray', async () => {
    await retryConflict('non-existent');
    expect(await listConflicts()).toEqual([]);
    expect(store[OUTBOX_STORAGE_KEY]).toBeUndefined();
  });

  it('only removes the matching conflict; siblings stay in the tray', async () => {
    const a = makeConflict({ localUuid: 'uuid-A' });
    const b = makeConflict({ localUuid: 'uuid-B' });
    await moveToConflictTray(a);
    await moveToConflictTray(b);

    await retryConflict('uuid-A');

    const remaining = await listConflicts();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.localUuid).toBe('uuid-B');
  });
});

describe('editAndRetryConflict', () => {
  it('replaces the payload, requeues the entry, and removes the conflict', async () => {
    const original = makeEntry({
      localUuid: 'uuid-A',
      payload: { projectId: 'p1', body: 'old' },
    });
    const conflict = makeConflict({ localUuid: 'uuid-A', entry: original });
    await moveToConflictTray(conflict);

    const replacement: OutboxEntry = {
      ...original,
      payload: { projectId: 'p1', body: 'new' },
    };
    const ok = await editAndRetryConflict('uuid-A', replacement);

    expect(ok).toBe(true);
    expect(await listConflicts()).toEqual([]);
    expect(store[OUTBOX_STORAGE_KEY]).toEqual([replacement]);
  });

  it('returns false (and changes nothing) when the replacement localUuid does not match', async () => {
    const original = makeEntry({ localUuid: 'uuid-A' });
    const conflict = makeConflict({ localUuid: 'uuid-A', entry: original });
    await moveToConflictTray(conflict);

    const wrong = { ...original, localUuid: 'uuid-Different' };
    const ok = await editAndRetryConflict('uuid-A', wrong);

    expect(ok).toBe(false);
    expect(await listConflicts()).toEqual([conflict]);
    expect(store[OUTBOX_STORAGE_KEY]).toBeUndefined();
  });

  it('returns false when the conflict has already been resolved', async () => {
    const replacement = makeEntry({ localUuid: 'uuid-Gone' });
    const ok = await editAndRetryConflict('uuid-Gone', replacement);
    expect(ok).toBe(false);
    expect(store[OUTBOX_STORAGE_KEY]).toBeUndefined();
  });
});
