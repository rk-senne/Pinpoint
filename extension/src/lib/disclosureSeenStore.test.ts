/**
 * Unit tests for `disclosureSeenStore` (Requirement 47.1, task 39.2).
 *
 * Fakes `chrome.storage.sync` via `vi.stubGlobal` so the tests run
 * under Node without the @types/chrome runtime. The fake mirrors the
 * Manifest V3 promise-returning shape: `get(null)` resolves with the
 * full snapshot, `get(key)` returns just that slot, `set(entries)`
 * merges, `remove(key | keys)` deletes the slot(s).
 *
 * Coverage:
 *   - `writeDisclosureSeen` writes under `disclosure-seen-${host}`.
 *   - `readDisclosureSeen` round-trips a previously-written value and
 *     returns `false` for missing / unrelated / unavailable hosts.
 *   - `resetAllDisclosureSeen` removes every `disclosure-seen-*` key
 *     while leaving unrelated `chrome.storage.sync` entries (allow
 *     list, block list, opt-out list) untouched.
 *   - All helpers degrade to noop / `false` when `chrome.storage.sync`
 *     is unavailable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  STORAGE_KEY_PREFIX,
  readDisclosureSeen,
  resetAllDisclosureSeen,
  writeDisclosureSeen,
} from './disclosureSeenStore';

interface ChromeStub {
  storage: {
    sync: {
      _data: Record<string, unknown>;
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
  };
}

let chromeStub: ChromeStub;

function buildChromeStub(initial: Record<string, unknown> = {}): ChromeStub {
  const data: Record<string, unknown> = { ...initial };
  return {
    storage: {
      sync: {
        _data: data,
        get: vi.fn(async (key?: string | string[] | null) => {
          if (key === null || key === undefined) return { ...data };
          if (typeof key === 'string') {
            return key in data ? { [key]: data[key] } : {};
          }
          if (Array.isArray(key)) {
            const out: Record<string, unknown> = {};
            for (const k of key) if (k in data) out[k] = data[k];
            return out;
          }
          return { ...data };
        }),
        set: vi.fn(async (entries: Record<string, unknown>) => {
          Object.assign(data, entries);
        }),
        remove: vi.fn(async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) delete data[k];
        }),
      },
    },
  };
}

beforeEach(() => {
  chromeStub = buildChromeStub();
  vi.stubGlobal('chrome', chromeStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('STORAGE_KEY_PREFIX', () => {
  it('matches the literal prefix used by Popover.ts (`disclosure-seen-`)', () => {
    expect(STORAGE_KEY_PREFIX).toBe('disclosure-seen-');
  });
});

describe('writeDisclosureSeen', () => {
  it('writes under disclosure-seen-${host} in chrome.storage.sync', async () => {
    await writeDisclosureSeen('app.example.com', true);

    expect(chromeStub.storage.sync.set).toHaveBeenCalledTimes(1);
    expect(
      chromeStub.storage.sync._data['disclosure-seen-app.example.com'],
    ).toBe(true);
  });

  it('coerces the seen value to boolean', async () => {
    await writeDisclosureSeen('app.example.com', false);
    expect(
      chromeStub.storage.sync._data['disclosure-seen-app.example.com'],
    ).toBe(false);
  });

  it('does not touch unrelated hosts', async () => {
    chromeStub.storage.sync._data['disclosure-seen-other.test'] = true;
    await writeDisclosureSeen('app.example.com', true);
    expect(
      chromeStub.storage.sync._data['disclosure-seen-other.test'],
    ).toBe(true);
  });

  it('no-ops on empty host', async () => {
    await writeDisclosureSeen('', true);
    expect(chromeStub.storage.sync.set).not.toHaveBeenCalled();
  });

  it('swallows storage outages', async () => {
    chromeStub.storage.sync.set.mockRejectedValueOnce(new Error('boom'));
    await expect(
      writeDisclosureSeen('app.example.com', true),
    ).resolves.toBeUndefined();
  });
});

describe('readDisclosureSeen', () => {
  it('returns true when the host has a persisted seen flag', async () => {
    chromeStub.storage.sync._data['disclosure-seen-app.example.com'] = true;
    await expect(readDisclosureSeen('app.example.com')).resolves.toBe(true);
  });

  it('returns false when the host slot is missing', async () => {
    await expect(readDisclosureSeen('app.example.com')).resolves.toBe(false);
  });

  it('returns false when the slot exists but is falsy', async () => {
    chromeStub.storage.sync._data['disclosure-seen-app.example.com'] = false;
    await expect(readDisclosureSeen('app.example.com')).resolves.toBe(false);
  });

  it('returns false on empty host', async () => {
    await expect(readDisclosureSeen('')).resolves.toBe(false);
    expect(chromeStub.storage.sync.get).not.toHaveBeenCalled();
  });

  it('returns false on storage error', async () => {
    chromeStub.storage.sync.get.mockRejectedValueOnce(new Error('boom'));
    await expect(readDisclosureSeen('app.example.com')).resolves.toBe(false);
  });
});

describe('round-trip', () => {
  it('writeDisclosureSeen + readDisclosureSeen returns the persisted value', async () => {
    await writeDisclosureSeen('a.example.com', true);
    await writeDisclosureSeen('b.example.com:8080', true);
    await expect(readDisclosureSeen('a.example.com')).resolves.toBe(true);
    await expect(readDisclosureSeen('b.example.com:8080')).resolves.toBe(true);
    await expect(readDisclosureSeen('c.example.com')).resolves.toBe(false);
  });
});

describe('resetAllDisclosureSeen', () => {
  it('removes every disclosure-seen-* key from chrome.storage.sync', async () => {
    chromeStub.storage.sync._data['disclosure-seen-a.example.com'] = true;
    chromeStub.storage.sync._data['disclosure-seen-b.example.com'] = true;
    chromeStub.storage.sync._data['disclosure-seen-c.example.com:8080'] = true;

    await resetAllDisclosureSeen();

    expect(
      chromeStub.storage.sync._data['disclosure-seen-a.example.com'],
    ).toBeUndefined();
    expect(
      chromeStub.storage.sync._data['disclosure-seen-b.example.com'],
    ).toBeUndefined();
    expect(
      chromeStub.storage.sync._data['disclosure-seen-c.example.com:8080'],
    ).toBeUndefined();
  });

  it('preserves unrelated keys (allow-list, block-list, opt-out)', async () => {
    chromeStub.storage.sync._data['fl_allow_list'] = ['example.com'];
    chromeStub.storage.sync._data['fl_block_list'] = ['*.bank.example.com'];
    chromeStub.storage.sync._data['pinPositionerOptOutHosts'] = ['busy.app'];
    chromeStub.storage.sync._data['disclosure-seen-a.example.com'] = true;

    await resetAllDisclosureSeen();

    expect(chromeStub.storage.sync._data['fl_allow_list']).toEqual([
      'example.com',
    ]);
    expect(chromeStub.storage.sync._data['fl_block_list']).toEqual([
      '*.bank.example.com',
    ]);
    expect(chromeStub.storage.sync._data['pinPositionerOptOutHosts']).toEqual([
      'busy.app',
    ]);
    expect(
      chromeStub.storage.sync._data['disclosure-seen-a.example.com'],
    ).toBeUndefined();
  });

  it('no-ops when there are no disclosure-seen-* keys', async () => {
    chromeStub.storage.sync._data['fl_allow_list'] = ['example.com'];
    await resetAllDisclosureSeen();
    expect(chromeStub.storage.sync.remove).not.toHaveBeenCalled();
    expect(chromeStub.storage.sync._data['fl_allow_list']).toEqual([
      'example.com',
    ]);
  });

  it('round-trips: reset then read returns false', async () => {
    await writeDisclosureSeen('a.example.com', true);
    await expect(readDisclosureSeen('a.example.com')).resolves.toBe(true);

    await resetAllDisclosureSeen();
    await expect(readDisclosureSeen('a.example.com')).resolves.toBe(false);
  });

  it('falls back to per-key removal when bulk remove rejects', async () => {
    chromeStub.storage.sync._data['disclosure-seen-a.example.com'] = true;
    chromeStub.storage.sync._data['disclosure-seen-b.example.com'] = true;
    chromeStub.storage.sync.remove.mockImplementationOnce(async () => {
      throw new Error('bulk-failed');
    });

    await resetAllDisclosureSeen();

    expect(
      chromeStub.storage.sync._data['disclosure-seen-a.example.com'],
    ).toBeUndefined();
    expect(
      chromeStub.storage.sync._data['disclosure-seen-b.example.com'],
    ).toBeUndefined();
  });
});

describe('storage unavailable', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('chrome', undefined);
  });

  it('readDisclosureSeen returns false', async () => {
    await expect(readDisclosureSeen('app.example.com')).resolves.toBe(false);
  });

  it('writeDisclosureSeen no-ops', async () => {
    await expect(
      writeDisclosureSeen('app.example.com', true),
    ).resolves.toBeUndefined();
  });

  it('resetAllDisclosureSeen no-ops', async () => {
    await expect(resetAllDisclosureSeen()).resolves.toBeUndefined();
  });
});
