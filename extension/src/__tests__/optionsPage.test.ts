// @vitest-environment jsdom

/**
 * Unit tests for the Options page (Requirement 46.1, task 38.1).
 *
 * The options page persists allow-list and block-list of host patterns to
 * `chrome.storage.sync` under `fl_allow_list` / `fl_block_list` and rehydrates
 * the textareas from those keys on load.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  STORAGE_KEY_ALLOW_LIST,
  STORAGE_KEY_BLOCK_LIST,
  STORAGE_KEY_CAPTURE_CONSOLE,
  STORAGE_KEY_CAPTURE_NETWORK,
  STORAGE_KEY_PIN_POSITIONER_OPT_OUT,
  STORAGE_KEY_TOKEN,
  initOptionsPage,
  parseList,
  serializeList,
} from '../../options/options';

interface SyncRecord {
  [key: string]: unknown;
}

function installChromeStorageMock(initial: SyncRecord = {}, localInitial: SyncRecord = {}): {
  storage: SyncRecord;
  localStorage: SyncRecord;
  setSpy: ReturnType<typeof vi.fn>;
  localSetSpy: ReturnType<typeof vi.fn>;
  removeSpy: ReturnType<typeof vi.fn>;
  syncRemoveSpy: ReturnType<typeof vi.fn>;
} {
  const storage: SyncRecord = { ...initial };
  const localStorage: SyncRecord = { ...localInitial };
  const setSpy = vi.fn(async (entries: SyncRecord) => {
    Object.assign(storage, entries);
  });
  const removeSpy = vi.fn(async (key: string | string[]) => {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) {
      delete localStorage[k];
    }
  });
  const syncRemoveSpy = vi.fn(async (key: string | string[]) => {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) {
      delete storage[k];
    }
  });
  const localSetSpy = vi.fn(async (entries: SyncRecord) => {
    Object.assign(localStorage, entries);
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: {
        get: vi.fn(async (keys: string | string[] | null) => {
          if (keys === null || keys === undefined) {
            return { ...storage };
          }
          const arr = Array.isArray(keys) ? keys : [keys];
          const out: SyncRecord = {};
          for (const k of arr) {
            if (k in storage) out[k] = storage[k];
          }
          return out;
        }),
        set: setSpy,
        remove: syncRemoveSpy,
      },
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          const out: SyncRecord = {};
          for (const k of arr) {
            if (k in localStorage) out[k] = localStorage[k];
          }
          return out;
        }),
        set: localSetSpy,
        remove: removeSpy,
      },
    },
  };
  return { storage, localStorage, setSpy, localSetSpy, removeSpy, syncRemoveSpy };
}

function renderOptionsHtml(): void {
  document.body.innerHTML = `
    <textarea id="allow-list"></textarea>
    <textarea id="block-list"></textarea>
    <textarea id="pin-positioner-opt-out"></textarea>
    <input id="capture-console" type="checkbox" />
    <input id="capture-network" type="checkbox" />
    <div id="status"></div>
    <p id="auth-state"></p>
    <button id="logout-button" type="button" hidden></button>
    <div id="auth-status"></div>
  `;
}

describe('options page helpers', () => {
  it('parseList trims, splits on newlines, and drops empty lines', () => {
    expect(parseList('example.com\n*.bank.example.com\n\n  internal.local  ')).toEqual([
      'example.com',
      '*.bank.example.com',
      'internal.local',
    ]);
  });

  it('parseList handles CRLF line endings', () => {
    expect(parseList('a.com\r\nb.com\r\n')).toEqual(['a.com', 'b.com']);
  });

  it('serializeList joins with newlines', () => {
    expect(serializeList(['a.com', 'b.com'])).toBe('a.com\nb.com');
  });

  it('serializeList of empty array yields empty string', () => {
    expect(serializeList([])).toBe('');
  });
});

describe('initOptionsPage', () => {
  beforeEach(() => {
    renderOptionsHtml();
  });

  it('populates textareas from chrome.storage.sync on load', async () => {
    installChromeStorageMock({
      [STORAGE_KEY_ALLOW_LIST]: ['example.com', '*.example.org'],
      [STORAGE_KEY_BLOCK_LIST]: ['*.bank.example.com'],
    });

    await initOptionsPage(document);

    const allow = document.getElementById('allow-list') as HTMLTextAreaElement;
    const block = document.getElementById('block-list') as HTMLTextAreaElement;
    expect(allow.value).toBe('example.com\n*.example.org');
    expect(block.value).toBe('*.bank.example.com');
  });

  it('treats missing keys as empty lists', async () => {
    installChromeStorageMock({});
    await initOptionsPage(document);
    const allow = document.getElementById('allow-list') as HTMLTextAreaElement;
    const block = document.getElementById('block-list') as HTMLTextAreaElement;
    expect(allow.value).toBe('');
    expect(block.value).toBe('');
  });

  it('persists parsed allow-list to chrome.storage.sync on change', async () => {
    const { setSpy, storage } = installChromeStorageMock({});
    await initOptionsPage(document);

    const allow = document.getElementById('allow-list') as HTMLTextAreaElement;
    allow.value = 'example.com\n  *.example.org  \n\n';
    allow.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(setSpy).toHaveBeenCalledWith({
      [STORAGE_KEY_ALLOW_LIST]: ['example.com', '*.example.org'],
    });
    expect(storage[STORAGE_KEY_ALLOW_LIST]).toEqual(['example.com', '*.example.org']);
  });

  it('persists parsed block-list to chrome.storage.sync on change', async () => {
    const { setSpy, storage } = installChromeStorageMock({});
    await initOptionsPage(document);

    const block = document.getElementById('block-list') as HTMLTextAreaElement;
    block.value = '*.bank.example.com';
    block.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(setSpy).toHaveBeenCalledWith({
      [STORAGE_KEY_BLOCK_LIST]: ['*.bank.example.com'],
    });
    expect(storage[STORAGE_KEY_BLOCK_LIST]).toEqual(['*.bank.example.com']);
  });
});

describe('initOptionsPage PinPositioner opt-out (Requirement 51.3 / Task 43.2)', () => {
  beforeEach(() => {
    renderOptionsHtml();
  });

  it('hydrates the opt-out textarea from chrome.storage.sync on load', async () => {
    installChromeStorageMock({
      [STORAGE_KEY_PIN_POSITIONER_OPT_OUT]: ['heavy.example.com', '*.busy.app'],
    });
    await initOptionsPage(document);
    const optOut = document.getElementById(
      'pin-positioner-opt-out',
    ) as HTMLTextAreaElement;
    expect(optOut.value).toBe('heavy.example.com\n*.busy.app');
  });

  it('treats a missing opt-out key as an empty list', async () => {
    installChromeStorageMock({});
    await initOptionsPage(document);
    const optOut = document.getElementById(
      'pin-positioner-opt-out',
    ) as HTMLTextAreaElement;
    expect(optOut.value).toBe('');
  });

  it('persists the parsed opt-out list to chrome.storage.sync on change', async () => {
    const { setSpy, storage } = installChromeStorageMock({});
    await initOptionsPage(document);

    const optOut = document.getElementById(
      'pin-positioner-opt-out',
    ) as HTMLTextAreaElement;
    optOut.value = '  heavy.example.com  \n*.busy.app\n\n';
    optOut.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(setSpy).toHaveBeenCalledWith({
      [STORAGE_KEY_PIN_POSITIONER_OPT_OUT]: [
        'heavy.example.com',
        '*.busy.app',
      ],
    });
    expect(storage[STORAGE_KEY_PIN_POSITIONER_OPT_OUT]).toEqual([
      'heavy.example.com',
      '*.busy.app',
    ]);
  });
});

describe('initOptionsPage capture toggles (Requirement 36.4 / Task 27.5)', () => {
  beforeEach(() => {
    renderOptionsHtml();
  });

  it('defaults both checkboxes to ON when no prefs are stored', async () => {
    installChromeStorageMock({}, {});
    await initOptionsPage(document);

    const consoleBox = document.getElementById(
      'capture-console',
    ) as HTMLInputElement;
    const networkBox = document.getElementById(
      'capture-network',
    ) as HTMLInputElement;
    expect(consoleBox.checked).toBe(true);
    expect(networkBox.checked).toBe(true);
  });

  it('hydrates checkboxes from stored prefs (mixed values)', async () => {
    installChromeStorageMock(
      {},
      {
        [STORAGE_KEY_CAPTURE_CONSOLE]: false,
        [STORAGE_KEY_CAPTURE_NETWORK]: true,
      },
    );
    await initOptionsPage(document);

    const consoleBox = document.getElementById(
      'capture-console',
    ) as HTMLInputElement;
    const networkBox = document.getElementById(
      'capture-network',
    ) as HTMLInputElement;
    expect(consoleBox.checked).toBe(false);
    expect(networkBox.checked).toBe(true);
  });

  it('persists console toggle changes to chrome.storage.local', async () => {
    const { localStorage, localSetSpy } = installChromeStorageMock({}, {});
    await initOptionsPage(document);

    const consoleBox = document.getElementById(
      'capture-console',
    ) as HTMLInputElement;
    consoleBox.checked = false;
    consoleBox.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(localSetSpy).toHaveBeenCalledWith({
      [STORAGE_KEY_CAPTURE_CONSOLE]: false,
    });
    expect(localStorage[STORAGE_KEY_CAPTURE_CONSOLE]).toBe(false);
  });

  it('persists network toggle changes to chrome.storage.local', async () => {
    const { localStorage, localSetSpy } = installChromeStorageMock({}, {});
    await initOptionsPage(document);

    const networkBox = document.getElementById(
      'capture-network',
    ) as HTMLInputElement;
    networkBox.checked = false;
    networkBox.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();

    expect(localSetSpy).toHaveBeenCalledWith({
      [STORAGE_KEY_CAPTURE_NETWORK]: false,
    });
    expect(localStorage[STORAGE_KEY_CAPTURE_NETWORK]).toBe(false);
  });

  it('round-trip: re-init after persisting a disabled toggle hydrates as off', async () => {
    const { localStorage } = installChromeStorageMock({}, {});
    await initOptionsPage(document);

    const consoleBox = document.getElementById(
      'capture-console',
    ) as HTMLInputElement;
    consoleBox.checked = false;
    consoleBox.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();
    expect(localStorage[STORAGE_KEY_CAPTURE_CONSOLE]).toBe(false);

    // Re-render the page and re-init: the previously-persisted false
    // should drive the checkbox state.
    renderOptionsHtml();
    await initOptionsPage(document);
    const fresh = document.getElementById(
      'capture-console',
    ) as HTMLInputElement;
    expect(fresh.checked).toBe(false);
  });
});

describe('initOptionsPage capture toggles reset disclosure-seen (Requirement 47.1 / Task 39.2)', () => {
  beforeEach(() => {
    renderOptionsHtml();
  });

  it('toggling the console capture pref clears every disclosure-seen-* key', async () => {
    const { storage, syncRemoveSpy } = installChromeStorageMock(
      {
        'disclosure-seen-app.example.com': true,
        'disclosure-seen-other.test:8080': true,
        // Unrelated key — should be preserved.
        fl_allow_list: ['example.com'],
      },
      {},
    );
    await initOptionsPage(document);

    const consoleBox = document.getElementById(
      'capture-console',
    ) as HTMLInputElement;
    consoleBox.checked = false;
    consoleBox.dispatchEvent(new Event('change'));
    // The change handler awaits `persistCapturePref` then
    // `resetAllDisclosureSeen`, which itself awaits a `get(null)` and
    // a `remove([...])`. Flush enough microtasks for the chain to
    // settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The disclosure-seen-* keys should have been removed via the
    // chrome.storage.sync.remove path.
    expect(syncRemoveSpy).toHaveBeenCalledTimes(1);
    const removedKeys = syncRemoveSpy.mock.calls[0]![0] as string[];
    expect(new Set(removedKeys)).toEqual(
      new Set([
        'disclosure-seen-app.example.com',
        'disclosure-seen-other.test:8080',
      ]),
    );
    expect(storage['disclosure-seen-app.example.com']).toBeUndefined();
    expect(storage['disclosure-seen-other.test:8080']).toBeUndefined();
    // Unrelated allow-list slot stays put.
    expect(storage['fl_allow_list']).toEqual(['example.com']);
  });

  it('toggling the network capture pref clears every disclosure-seen-* key', async () => {
    const { storage, syncRemoveSpy } = installChromeStorageMock(
      {
        'disclosure-seen-a.example.com': true,
        'disclosure-seen-b.example.com': true,
      },
      {},
    );
    await initOptionsPage(document);

    const networkBox = document.getElementById(
      'capture-network',
    ) as HTMLInputElement;
    networkBox.checked = false;
    networkBox.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(syncRemoveSpy).toHaveBeenCalledTimes(1);
    expect(storage['disclosure-seen-a.example.com']).toBeUndefined();
    expect(storage['disclosure-seen-b.example.com']).toBeUndefined();
  });

  it('does not call sync.remove when no disclosure-seen-* keys exist', async () => {
    const { syncRemoveSpy } = installChromeStorageMock({}, {});
    await initOptionsPage(document);

    const consoleBox = document.getElementById(
      'capture-console',
    ) as HTMLInputElement;
    consoleBox.checked = false;
    consoleBox.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(syncRemoveSpy).not.toHaveBeenCalled();
  });

  it('does not reset disclosure-seen on allow-list / block-list changes', async () => {
    const { storage, syncRemoveSpy } = installChromeStorageMock(
      { 'disclosure-seen-app.example.com': true },
      {},
    );
    await initOptionsPage(document);

    const allow = document.getElementById('allow-list') as HTMLTextAreaElement;
    allow.value = 'example.com';
    allow.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(syncRemoveSpy).not.toHaveBeenCalled();
    expect(storage['disclosure-seen-app.example.com']).toBe(true);
  });
});

describe('initOptionsPage logout (Requirement 33.2 / Task 24.2)', () => {
  beforeEach(() => {
    renderOptionsHtml();
  });

  function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
    return new Response(JSON.stringify(body), {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  }

  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  it('hides the logout button when no token is stored', async () => {
    installChromeStorageMock({}, {});
    await initOptionsPage(document);
    await flush();
    const button = document.getElementById('logout-button') as HTMLButtonElement;
    expect(button.hidden).toBe(true);
    const state = document.getElementById('auth-state')!;
    expect(state.textContent).toMatch(/signed out/i);
  });

  it('shows the logout button when a token is stored', async () => {
    installChromeStorageMock({}, { [STORAGE_KEY_TOKEN]: 'jwt-stored' });
    await initOptionsPage(document);
    await flush();
    const button = document.getElementById('logout-button') as HTMLButtonElement;
    expect(button.hidden).toBe(false);
    const state = document.getElementById('auth-state')!;
    expect(state.textContent).toMatch(/signed in/i);
  });

  it('logout clicks call POST /api/v1/auth/logout, clear the bearer, and update the UI', async () => {
    const { localStorage, removeSpy } = installChromeStorageMock(
      {},
      { [STORAGE_KEY_TOKEN]: 'jwt-stored' },
    );
    const fetchSpy = vi.fn(async () => jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchSpy);

    await initOptionsPage(document);
    await flush();

    const button = document.getElementById('logout-button') as HTMLButtonElement;
    button.click();
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toMatch(/\/api\/v1\/auth\/logout$/);
    expect(calledInit.method).toBe('POST');
    expect((calledInit.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer jwt-stored',
    );

    expect(removeSpy).toHaveBeenCalledWith(STORAGE_KEY_TOKEN);
    expect(STORAGE_KEY_TOKEN in localStorage).toBe(false);

    expect(button.hidden).toBe(true);
    const state = document.getElementById('auth-state')!;
    expect(state.textContent).toMatch(/signed out/i);
    const status = document.getElementById('auth-status')!;
    expect(status.textContent).toMatch(/signed out/i);

    vi.unstubAllGlobals();
  });

  it('logout still clears the local token when the server call fails', async () => {
    const { localStorage, removeSpy } = installChromeStorageMock(
      {},
      { [STORAGE_KEY_TOKEN]: 'jwt-stored' },
    );
    const fetchSpy = vi.fn(async () =>
      jsonResponse(
        { error: { code: 'UNAUTHORIZED', message: 'Token expired.' } },
        { status: 401 },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await initOptionsPage(document);
    await flush();

    const button = document.getElementById('logout-button') as HTMLButtonElement;
    button.click();
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(STORAGE_KEY_TOKEN);
    expect(STORAGE_KEY_TOKEN in localStorage).toBe(false);
    expect(button.hidden).toBe(true);

    vi.unstubAllGlobals();
  });
});
