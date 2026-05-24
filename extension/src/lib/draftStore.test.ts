/**
 * Unit tests for `draftStore` (Requirement 41.1, task 32.1).
 *
 * Fakes `chrome.storage.session` via `vi.stubGlobal` so the tests run
 * under Node without the @types/chrome runtime. The fake mirrors the
 * Manifest V3 promise-returning shape: `get(key)` resolves with an
 * object, `set(entries)` merges, `remove(key)` deletes the slot.
 *
 * Coverage:
 *   - `saveDraft` writes to `chrome.storage.session` (NOT `local`) under
 *     the `fl_drafts` key; existing entries for other URLs are preserved.
 *   - `loadDraft` returns the previously persisted draft, or `null` when
 *     no draft exists for that URL.
 *   - `deleteDraft` removes the entry without touching unrelated URLs.
 *   - Corrupt slots (non-object, array, malformed entries) coerce to an
 *     empty map rather than throwing.
 *   - All helpers degrade to noop / `null` when `chrome.storage.session`
 *     is unavailable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  STORAGE_KEY_DRAFTS,
  deleteDraft,
  loadDraft,
  saveDraft,
} from './draftStore';

interface ChromeStub {
  storage: {
    session: {
      _data: Record<string, unknown>;
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
    local: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
    };
  };
}

let chromeStub: ChromeStub;

function buildChromeStub(initial: Record<string, unknown> = {}): ChromeStub {
  const data: Record<string, unknown> = { ...initial };
  return {
    storage: {
      session: {
        _data: data,
        get: vi.fn(async (key?: string | string[] | null) => {
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
        remove: vi.fn(async (key: string) => {
          delete data[key];
        }),
      },
      // local is included so we can assert that draftStore NEVER touches
      // it — drafts are session-scoped per design.md.
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
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

describe('saveDraft', () => {
  it('persists the draft under fl_drafts in chrome.storage.session', async () => {
    await saveDraft('https://example.com/dashboard', {
      body: 'hello',
      severity: 'major',
      type: 'note',
    });

    expect(chromeStub.storage.session.set).toHaveBeenCalledTimes(1);
    expect(chromeStub.storage.session._data[STORAGE_KEY_DRAFTS]).toEqual({
      'https://example.com/dashboard': {
        body: 'hello',
        severity: 'major',
        type: 'note',
      },
    });
  });

  it('writes to chrome.storage.session, not chrome.storage.local', async () => {
    await saveDraft('https://example.com/p', {
      body: 'b',
      severity: 'minor',
      type: 'suggestion',
    });

    expect(chromeStub.storage.session.set).toHaveBeenCalled();
    expect(chromeStub.storage.local.set).not.toHaveBeenCalled();
  });

  it('preserves drafts for other URLs when writing a new one', async () => {
    chromeStub.storage.session._data[STORAGE_KEY_DRAFTS] = {
      'https://other.test/x': {
        body: 'keep me',
        severity: 'critical',
        type: 'note',
      },
    };

    await saveDraft('https://example.com/dashboard', {
      body: 'fresh',
      severity: 'minor',
      type: 'guideline',
    });

    expect(chromeStub.storage.session._data[STORAGE_KEY_DRAFTS]).toEqual({
      'https://other.test/x': {
        body: 'keep me',
        severity: 'critical',
        type: 'note',
      },
      'https://example.com/dashboard': {
        body: 'fresh',
        severity: 'minor',
        type: 'guideline',
      },
    });
  });

  it('overwrites the entry when the same URL is saved with new content', async () => {
    await saveDraft('https://example.com/p', {
      body: 'first',
      severity: 'major',
      type: 'note',
    });
    await saveDraft('https://example.com/p', {
      body: 'second',
      severity: 'minor',
      type: 'suggestion',
    });

    expect(chromeStub.storage.session._data[STORAGE_KEY_DRAFTS]).toEqual({
      'https://example.com/p': {
        body: 'second',
        severity: 'minor',
        type: 'suggestion',
      },
    });
  });

  it('is a noop when url is empty', async () => {
    await saveDraft('', { body: 'b', severity: 'major', type: 'note' });
    expect(chromeStub.storage.session.set).not.toHaveBeenCalled();
  });
});

describe('loadDraft', () => {
  it('returns null when the cache has no entry for the URL', async () => {
    expect(await loadDraft('https://example.com/p')).toBeNull();
  });

  it('returns the draft previously saved for the URL', async () => {
    await saveDraft('https://example.com/p', {
      body: 'restored',
      severity: 'critical',
      type: 'note',
    });

    expect(await loadDraft('https://example.com/p')).toEqual({
      body: 'restored',
      severity: 'critical',
      type: 'note',
    });
  });

  it('returns null for a different URL even when other entries exist', async () => {
    await saveDraft('https://example.com/a', {
      body: 'a',
      severity: 'major',
      type: 'note',
    });

    expect(await loadDraft('https://example.com/b')).toBeNull();
  });

  it('coerces a corrupt non-object slot to null', async () => {
    chromeStub.storage.session._data[STORAGE_KEY_DRAFTS] = 'not-an-object';
    expect(await loadDraft('https://example.com/p')).toBeNull();
  });

  it('coerces an array slot to null', async () => {
    chromeStub.storage.session._data[STORAGE_KEY_DRAFTS] = ['oops'];
    expect(await loadDraft('https://example.com/p')).toBeNull();
  });

  it('skips malformed entries (missing fields, wrong types)', async () => {
    chromeStub.storage.session._data[STORAGE_KEY_DRAFTS] = {
      'https://example.com/bad': { body: 42, severity: 'major', type: 'note' },
      'https://example.com/good': {
        body: 'ok',
        severity: 'minor',
        type: 'suggestion',
      },
    };

    expect(await loadDraft('https://example.com/bad')).toBeNull();
    expect(await loadDraft('https://example.com/good')).toEqual({
      body: 'ok',
      severity: 'minor',
      type: 'suggestion',
    });
  });
});

describe('deleteDraft', () => {
  it('removes the entry for the URL', async () => {
    await saveDraft('https://example.com/p', {
      body: 'b',
      severity: 'major',
      type: 'note',
    });
    expect(await loadDraft('https://example.com/p')).not.toBeNull();

    await deleteDraft('https://example.com/p');

    expect(await loadDraft('https://example.com/p')).toBeNull();
  });

  it('preserves drafts for other URLs', async () => {
    await saveDraft('https://a.test/x', {
      body: 'a',
      severity: 'major',
      type: 'note',
    });
    await saveDraft('https://b.test/y', {
      body: 'b',
      severity: 'minor',
      type: 'suggestion',
    });

    await deleteDraft('https://a.test/x');

    expect(await loadDraft('https://a.test/x')).toBeNull();
    expect(await loadDraft('https://b.test/y')).toEqual({
      body: 'b',
      severity: 'minor',
      type: 'suggestion',
    });
  });

  it('is a noop when no draft exists for the URL', async () => {
    await deleteDraft('https://example.com/never-saved');
    // No `set` call when there was nothing to remove.
    expect(chromeStub.storage.session.set).not.toHaveBeenCalled();
  });

  it('is a noop when url is empty', async () => {
    await deleteDraft('');
    expect(chromeStub.storage.session.set).not.toHaveBeenCalled();
  });
});

describe('without chrome.storage.session available', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('saveDraft resolves without throwing', async () => {
    await expect(
      saveDraft('https://x.test/p', {
        body: 'b',
        severity: 'major',
        type: 'note',
      }),
    ).resolves.toBeUndefined();
  });

  it('loadDraft resolves to null', async () => {
    await expect(loadDraft('https://x.test/p')).resolves.toBeNull();
  });

  it('deleteDraft resolves without throwing', async () => {
    await expect(deleteDraft('https://x.test/p')).resolves.toBeUndefined();
  });
});

describe('when chrome.storage exists but session is missing', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    // Some hosts (e.g. an old Manifest V2 polyfill in jsdom) expose
    // `chrome.storage.local` but not `.session`. The helpers must
    // degrade gracefully there too.
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
      },
    });
  });

  it('saveDraft is a noop (does not fall back to local)', async () => {
    await saveDraft('https://x.test/p', {
      body: 'b',
      severity: 'major',
      type: 'note',
    });
    const c = chrome as unknown as { storage: { local: { set: ReturnType<typeof vi.fn> } } };
    expect(c.storage.local.set).not.toHaveBeenCalled();
  });

  it('loadDraft resolves to null', async () => {
    await expect(loadDraft('https://x.test/p')).resolves.toBeNull();
  });
});
