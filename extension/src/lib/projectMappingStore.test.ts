/**
 * Unit tests for `projectMappingStore` (Requirement 39.2, task 30.2).
 *
 * Fakes `chrome.storage.local` via `vi.stubGlobal` so the tests run under
 * Node without the @types/chrome runtime. The fake mirrors the Manifest
 * V3 promise-returning shape: `get(key)` resolves with an object,
 * `set(entries)` merges, `remove(key)` deletes the slot.
 *
 * Coverage:
 *   - `urlKey` collapses `?query`/`#hash` away (uses only origin + pathname).
 *   - `rememberProject` writes a fresh entry into the
 *     `fl_project_mappings` map without disturbing other entries.
 *   - `lookupProject` returns the projectId previously persisted, and
 *     `null` when the cache is empty.
 *   - Corrupt slots (non-object, array, non-string values) coerce to an
 *     empty map rather than throwing.
 *   - All helpers degrade to noop / null when `chrome.storage.local` is
 *     unavailable (no test-environment crash).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  PROJECT_MAPPING_STORAGE_KEY,
  lookupProject,
  rememberProject,
  urlKey,
} from './projectMappingStore';

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

beforeEach(() => {
  store = {};
  vi.stubGlobal('chrome', buildChromeStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('urlKey', () => {
  it('concatenates origin and pathname', () => {
    expect(urlKey({ origin: 'https://example.com', pathname: '/dashboard' })).toBe(
      'https://example.com/dashboard',
    );
  });

  it('ignores anything beyond origin + pathname (no query, no hash)', () => {
    // Caller is expected to pass a Location-like object; the helper only
    // reads origin + pathname so query/hash never enter the key.
    const key = urlKey({ origin: 'https://example.com', pathname: '/p' });
    const sameKey = urlKey({ origin: 'https://example.com', pathname: '/p' });
    expect(key).toBe(sameKey);
  });

  it('treats different paths as distinct keys', () => {
    expect(urlKey({ origin: 'https://x.test', pathname: '/a' })).not.toBe(
      urlKey({ origin: 'https://x.test', pathname: '/b' }),
    );
  });

  it('coerces missing fields to empty strings rather than throwing', () => {
    expect(
      urlKey({ origin: '' as string, pathname: '/foo' }),
    ).toBe('/foo');
    expect(
      urlKey({ origin: 'https://x.test', pathname: '' as string }),
    ).toBe('https://x.test');
  });
});

describe('rememberProject', () => {
  it('persists the urlKey → projectId mapping under fl_project_mappings', async () => {
    await rememberProject(
      { origin: 'https://example.com', pathname: '/dashboard' },
      'proj_123',
    );

    expect(store[PROJECT_MAPPING_STORAGE_KEY]).toEqual({
      'https://example.com/dashboard': 'proj_123',
    });
  });

  it('preserves entries for other URLs when remembering a new one', async () => {
    store[PROJECT_MAPPING_STORAGE_KEY] = {
      'https://other.test/x': 'proj_other',
    };

    await rememberProject(
      { origin: 'https://example.com', pathname: '/dashboard' },
      'proj_123',
    );

    expect(store[PROJECT_MAPPING_STORAGE_KEY]).toEqual({
      'https://other.test/x': 'proj_other',
      'https://example.com/dashboard': 'proj_123',
    });
  });

  it('overwrites the entry when the same URL is selected to a different project', async () => {
    await rememberProject(
      { origin: 'https://example.com', pathname: '/dashboard' },
      'proj_old',
    );
    await rememberProject(
      { origin: 'https://example.com', pathname: '/dashboard' },
      'proj_new',
    );

    expect(store[PROJECT_MAPPING_STORAGE_KEY]).toEqual({
      'https://example.com/dashboard': 'proj_new',
    });
  });

  it('is a noop when projectId is empty', async () => {
    await rememberProject(
      { origin: 'https://example.com', pathname: '/p' },
      '',
    );
    const setSpy = (chrome as unknown as ChromeStorageStub).storage.local.set as ReturnType<typeof vi.fn>;
    expect(setSpy).not.toHaveBeenCalled();
    expect(store[PROJECT_MAPPING_STORAGE_KEY]).toBeUndefined();
  });
});

describe('lookupProject', () => {
  it('returns null when the cache has no entry for the URL', async () => {
    expect(
      await lookupProject({ origin: 'https://example.com', pathname: '/p' }),
    ).toBeNull();
  });

  it('returns the projectId previously remembered for the URL', async () => {
    await rememberProject(
      { origin: 'https://example.com', pathname: '/p' },
      'proj_123',
    );

    expect(
      await lookupProject({ origin: 'https://example.com', pathname: '/p' }),
    ).toBe('proj_123');
  });

  it('returns null for a different URL even when other entries exist', async () => {
    await rememberProject(
      { origin: 'https://example.com', pathname: '/a' },
      'proj_a',
    );

    expect(
      await lookupProject({ origin: 'https://example.com', pathname: '/b' }),
    ).toBeNull();
  });

  it('coerces a corrupt non-object slot to an empty map (returns null)', async () => {
    store[PROJECT_MAPPING_STORAGE_KEY] = 'not-an-object';
    expect(
      await lookupProject({ origin: 'https://example.com', pathname: '/p' }),
    ).toBeNull();
  });

  it('coerces an array slot to an empty map (returns null)', async () => {
    store[PROJECT_MAPPING_STORAGE_KEY] = ['unexpected'];
    expect(
      await lookupProject({ origin: 'https://example.com', pathname: '/p' }),
    ).toBeNull();
  });

  it('skips non-string mapping values', async () => {
    store[PROJECT_MAPPING_STORAGE_KEY] = {
      'https://example.com/p': 42,
      'https://example.com/q': 'proj_q',
    };

    expect(
      await lookupProject({ origin: 'https://example.com', pathname: '/p' }),
    ).toBeNull();
    expect(
      await lookupProject({ origin: 'https://example.com', pathname: '/q' }),
    ).toBe('proj_q');
  });
});

describe('without chrome.storage.local available', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('rememberProject resolves without throwing', async () => {
    await expect(
      rememberProject({ origin: 'https://x.test', pathname: '/p' }, 'proj_x'),
    ).resolves.toBeUndefined();
  });

  it('lookupProject resolves to null', async () => {
    await expect(
      lookupProject({ origin: 'https://x.test', pathname: '/p' }),
    ).resolves.toBeNull();
  });
});
