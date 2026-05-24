// @vitest-environment jsdom
/**
 * Unit tests for `hostFilter` — the per-site allow/block guard that the
 * content script consults before mounting the overlay (tasks 38.2, 38.3 —
 * Requirements 46.2, 46.3).
 *
 * Coverage:
 *   - `decideInjection` (pure): block-list match, allow-list miss, both
 *     empty, allow-list hit, block-list precedence over allow-list,
 *     wildcard patterns (delegated to `hostMatchesPattern`).
 *   - `readHostFilterLists` & `shouldSkipInjection`: storage failure
 *     defaults to "allow", missing keys default to empty lists.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  STORAGE_KEY_ALLOW_LIST,
  STORAGE_KEY_BLOCK_LIST,
  decideInjection,
  readHostFilterLists,
  shouldSkipInjection,
} from './hostFilter';

interface StorageMockHandles {
  storage: Record<string, unknown>;
  getSpy: ReturnType<typeof vi.fn>;
}

function installChromeStorageMock(
  initial: Record<string, unknown> = {},
  options: { rejectGet?: Error } = {},
): StorageMockHandles {
  const storage: Record<string, unknown> = { ...initial };
  const getSpy = vi.fn(async (keys: string | string[]) => {
    if (options.rejectGet) {
      throw options.rejectGet;
    }
    const arr = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of arr) {
      if (k in storage) out[k] = storage[k];
    }
    return out;
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: {
        get: getSpy,
        set: vi.fn(async () => undefined),
      },
    },
  };
  return { storage, getSpy };
}

describe('decideInjection (pure)', () => {
  describe('Requirement 46.2 — block-list match', () => {
    it('skips with reason="block-list" when host exactly matches the block-list', () => {
      const result = decideInjection('bank.example.com', {
        allow: [],
        block: ['bank.example.com'],
      });
      expect(result).toEqual({ skip: true, reason: 'block-list' });
    });

    it('skips when host matches a `*.example.com` wildcard in the block-list', () => {
      const result = decideInjection('app.bank.example.com', {
        allow: [],
        block: ['*.bank.example.com'],
      });
      expect(result).toEqual({ skip: true, reason: 'block-list' });
    });

    it('skips when the block-list also matches the apex via `*.bank.example.com`', () => {
      const result = decideInjection('bank.example.com', {
        allow: [],
        block: ['*.bank.example.com'],
      });
      expect(result).toEqual({ skip: true, reason: 'block-list' });
    });

    it('does NOT skip when host does not match any block-list pattern', () => {
      const result = decideInjection('example.com', {
        allow: [],
        block: ['bank.example.com', '*.internal.local'],
      });
      expect(result).toEqual({ skip: false });
    });

    it('does NOT skip when block-list is empty', () => {
      const result = decideInjection('example.com', { allow: [], block: [] });
      expect(result).toEqual({ skip: false });
    });

    it('treats whitespace-only block-list entries as empty (does not lock everything out)', () => {
      const result = decideInjection('example.com', {
        allow: [],
        block: ['  ', '\t', ''],
      });
      expect(result).toEqual({ skip: false });
    });
  });

  describe('Requirement 46.3 — allow-list mode', () => {
    it('skips with reason="allow-list" when allow-list is non-empty and host does not match', () => {
      const result = decideInjection('example.com', {
        allow: ['internal.local', '*.acme.test'],
        block: [],
      });
      expect(result).toEqual({ skip: true, reason: 'allow-list' });
    });

    it('does NOT skip when host matches the allow-list exactly', () => {
      const result = decideInjection('internal.local', {
        allow: ['internal.local'],
        block: [],
      });
      expect(result).toEqual({ skip: false });
    });

    it('does NOT skip when host matches a wildcard in the allow-list', () => {
      const result = decideInjection('app.acme.test', {
        allow: ['*.acme.test'],
        block: [],
      });
      expect(result).toEqual({ skip: false });
    });

    it('does NOT skip when allow-list is empty (default-allow)', () => {
      const result = decideInjection('any.host.example', {
        allow: [],
        block: [],
      });
      expect(result).toEqual({ skip: false });
    });

    it('does NOT skip when allow-list contains only whitespace entries', () => {
      const result = decideInjection('any.host.example', {
        allow: ['  ', '\n'],
        block: [],
      });
      expect(result).toEqual({ skip: false });
    });
  });

  describe('precedence', () => {
    it('block-list wins over allow-list when host matches both', () => {
      const result = decideInjection('bank.example.com', {
        allow: ['*.example.com'],
        block: ['bank.example.com'],
      });
      expect(result).toEqual({ skip: true, reason: 'block-list' });
    });

    it('allow-list miss skips even when block-list does not match', () => {
      const result = decideInjection('rogue.example.com', {
        allow: ['internal.local'],
        block: ['*.bank.example.com'],
      });
      expect(result).toEqual({ skip: true, reason: 'allow-list' });
    });
  });

  describe('host normalisation', () => {
    it('normalises the host to lower-case before matching', () => {
      const result = decideInjection('APP.Bank.Example.com', {
        allow: [],
        block: ['*.bank.example.com'],
      });
      expect(result).toEqual({ skip: true, reason: 'block-list' });
    });

    it('trims surrounding whitespace from the host', () => {
      const result = decideInjection('  example.com\n', {
        allow: ['example.com'],
        block: [],
      });
      expect(result).toEqual({ skip: false });
    });
  });
});

describe('readHostFilterLists', () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('reads both lists from chrome.storage.sync', async () => {
    installChromeStorageMock({
      [STORAGE_KEY_ALLOW_LIST]: ['internal.local', '*.acme.test'],
      [STORAGE_KEY_BLOCK_LIST]: ['*.bank.example.com'],
    });

    const lists = await readHostFilterLists();
    expect(lists).toEqual({
      allow: ['internal.local', '*.acme.test'],
      block: ['*.bank.example.com'],
    });
  });

  it('treats missing keys as empty lists', async () => {
    installChromeStorageMock({});
    const lists = await readHostFilterLists();
    expect(lists).toEqual({ allow: [], block: [] });
  });

  it('drops non-string entries from each list', async () => {
    installChromeStorageMock({
      [STORAGE_KEY_ALLOW_LIST]: ['internal.local', 42, null, 'ok.test'],
      [STORAGE_KEY_BLOCK_LIST]: [{ bad: 1 }, '*.bank.example.com'],
    });
    const lists = await readHostFilterLists();
    expect(lists.allow).toEqual(['internal.local', 'ok.test']);
    expect(lists.block).toEqual(['*.bank.example.com']);
  });

  it('returns empty lists when chrome.storage is unavailable', async () => {
    delete (globalThis as { chrome?: unknown }).chrome;
    const lists = await readHostFilterLists();
    expect(lists).toEqual({ allow: [], block: [] });
  });
});

describe('shouldSkipInjection (storage-backed guard)', () => {
  beforeEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('returns skip=false when both lists are empty (default-allow)', async () => {
    installChromeStorageMock({});
    const decision = await shouldSkipInjection('example.com');
    expect(decision).toEqual({ skip: false });
  });

  it('returns skip=true reason="block-list" when host matches block-list', async () => {
    installChromeStorageMock({
      [STORAGE_KEY_BLOCK_LIST]: ['*.bank.example.com'],
    });
    const decision = await shouldSkipInjection('app.bank.example.com');
    expect(decision).toEqual({ skip: true, reason: 'block-list' });
  });

  it('returns skip=true reason="allow-list" when allow-list is non-empty and host does not match', async () => {
    installChromeStorageMock({
      [STORAGE_KEY_ALLOW_LIST]: ['internal.local', '*.acme.test'],
    });
    const decision = await shouldSkipInjection('rogue.example.com');
    expect(decision).toEqual({ skip: true, reason: 'allow-list' });
  });

  it('returns skip=false when host matches the allow-list', async () => {
    installChromeStorageMock({
      [STORAGE_KEY_ALLOW_LIST]: ['internal.local', '*.acme.test'],
    });
    const decision = await shouldSkipInjection('app.acme.test');
    expect(decision).toEqual({ skip: false });
  });

  it('returns skip=false on storage failure (defaults to allow)', async () => {
    installChromeStorageMock(
      {},
      { rejectGet: new Error('chrome.storage exploded') },
    );
    const decision = await shouldSkipInjection('example.com');
    expect(decision).toEqual({ skip: false });
  });

  it('returns skip=false when chrome.storage is unavailable', async () => {
    delete (globalThis as { chrome?: unknown }).chrome;
    const decision = await shouldSkipInjection('example.com');
    expect(decision).toEqual({ skip: false });
  });

  it('reads window.location.hostname as the default host', async () => {
    installChromeStorageMock({
      [STORAGE_KEY_BLOCK_LIST]: [window.location.hostname || 'localhost'],
    });
    // jsdom's default location.hostname is 'localhost'.
    const decision = await shouldSkipInjection();
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe('block-list');
  });
});
