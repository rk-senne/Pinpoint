/**
 * Unit tests for the Outbox module (task 36.1, Req 44.2).
 *
 * Fakes `chrome.storage.local` via `vi.stubGlobal` so the tests run under
 * Node without the @types/chrome runtime. The fake mirrors the Manifest
 * V3 promise-returning shape: `get(key)` resolves with an object,
 * `set(entries)` merges, `remove(key)` deletes the slot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  enqueue,
  list,
  remove,
  replace,
  OUTBOX_STORAGE_KEY,
  type OutboxEntry,
} from './Outbox';

interface ChromeStorageStub {
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (entries: Record<string, unknown>) => Promise<void>;
      remove: (key: string) => Promise<void>;
    };
  };
}

let store: Record<string, unknown>;

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
    localUuid: overrides.localUuid ?? crypto.randomUUID(),
    kind: overrides.kind ?? 'create-annotation',
    payload: overrides.payload ?? { body: 'hello' },
    pendingSync: true,
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00.000Z').toISOString(),
  };
}

beforeEach(() => {
  store = {};
  vi.stubGlobal('chrome', buildChromeStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Outbox.enqueue', () => {
  it('persists a single entry under the pinpoint_outbox key', async () => {
    const entry = makeEntry();
    await enqueue(entry);

    expect(store[OUTBOX_STORAGE_KEY]).toEqual([entry]);
  });

  it('appends entries in insertion order across multiple calls', async () => {
    const a = makeEntry({ kind: 'create-annotation' });
    const b = makeEntry({ kind: 'create-comment' });
    const c = makeEntry({ kind: 'change-status' });

    await enqueue(a);
    await enqueue(b);
    await enqueue(c);

    expect(store[OUTBOX_STORAGE_KEY]).toEqual([a, b, c]);
  });

  it('survives a missing storage slot (no prior get returned undefined)', async () => {
    // store starts empty; enqueue should treat the slot as []
    const entry = makeEntry();
    await enqueue(entry);
    expect(await list()).toEqual([entry]);
  });
});

describe('Outbox.list', () => {
  it('returns an empty array when nothing is queued', async () => {
    expect(await list()).toEqual([]);
  });

  it('returns entries in insertion order', async () => {
    const a = makeEntry();
    const b = makeEntry();
    await enqueue(a);
    await enqueue(b);

    expect(await list()).toEqual([a, b]);
  });

  it('coerces a corrupt non-array slot to an empty list', async () => {
    store[OUTBOX_STORAGE_KEY] = 'not-an-array';
    expect(await list()).toEqual([]);
  });
});

describe('Outbox.remove', () => {
  it('removes the entry whose localUuid matches and leaves others intact', async () => {
    const a = makeEntry();
    const b = makeEntry();
    const c = makeEntry();
    await enqueue(a);
    await enqueue(b);
    await enqueue(c);

    await remove(b.localUuid);

    expect(await list()).toEqual([a, c]);
  });

  it('is a no-op when the localUuid is not in the queue', async () => {
    const a = makeEntry();
    await enqueue(a);

    await remove('non-existent-uuid');

    expect(await list()).toEqual([a]);
  });

  it('does not write storage when no entry matches', async () => {
    const a = makeEntry();
    await enqueue(a);
    const setSpy = (chrome as unknown as ChromeStorageStub).storage.local.set as ReturnType<typeof vi.fn>;
    setSpy.mockClear();

    await remove('non-existent-uuid');

    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('Outbox.replace', () => {
  it('replaces the entry whose localUuid matches, preserving position', async () => {
    const a = makeEntry();
    const b = makeEntry();
    const c = makeEntry();
    await enqueue(a);
    await enqueue(b);
    await enqueue(c);

    const serverEntry = makeEntry({ localUuid: 'server-id', payload: { id: 42 } });
    await replace(b.localUuid, serverEntry);

    expect(await list()).toEqual([a, serverEntry, c]);
  });

  it('is a no-op when the localUuid is not in the queue', async () => {
    const a = makeEntry();
    await enqueue(a);

    const serverEntry = makeEntry({ localUuid: 'server-id' });
    await replace('non-existent-uuid', serverEntry);

    expect(await list()).toEqual([a]);
  });

  it('replaces a single matching entry without affecting siblings', async () => {
    const first = makeEntry({ kind: 'create-annotation' });
    const second = makeEntry({ kind: 'create-comment' });
    await enqueue(first);
    await enqueue(second);

    const replacement = makeEntry({
      localUuid: first.localUuid,
      kind: 'create-annotation',
      payload: { rewritten: true },
    });
    await replace(first.localUuid, replacement);

    const result = await list();
    expect(result[0]).toEqual(replacement);
    expect(result[1]).toEqual(second);
  });
});

describe('Outbox — durability semantics', () => {
  it('reads back the queue from chrome.storage.local across method calls', async () => {
    const a = makeEntry();
    const b = makeEntry();
    await enqueue(a);
    await enqueue(b);

    // Simulate a fresh module call: drop and re-stub chrome with the
    // same backing store. The queue must be readable from storage alone.
    vi.unstubAllGlobals();
    vi.stubGlobal('chrome', buildChromeStub());

    expect(await list()).toEqual([a, b]);
  });
});
