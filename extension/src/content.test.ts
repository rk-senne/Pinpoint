// @vitest-environment jsdom
/**
 * Unit tests for the content script's `resolveProjectForUrl` helper
 * (task 30.3, Requirement 39.2).
 *
 * The helper consults the URL → Project mapping cache populated by
 * `<fl-project-picker>` (task 30.2) **before** falling back to
 * `GET /api/v1/projects/by-url`. These tests verify both branches:
 *
 *   - Cache hit → return the cached `projectId` and skip the network call.
 *   - Cache miss → perform the network call and return its `projectId`.
 *
 * `apiFetch` and `lookupProject` are mocked at module-resolution time so
 * importing `./content` does not actually hit the network or
 * `chrome.storage.local`. The content script's top-level side effects
 * (`installHistoryPatch`, `mountOverlay`) run inside jsdom against the
 * mocked dependencies and are otherwise irrelevant to this test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` factories are hoisted above all imports, so any references they
// close over must be hoisted too — `vi.hoisted` ensures these spies exist
// before the mocks resolve.
const { apiFetchMock, lookupProjectMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  lookupProjectMock: vi.fn(),
}));

vi.mock('./lib/api', () => ({
  apiFetch: apiFetchMock,
  // The connection monitor (task 36.8) imports `API_BASE` from this
  // module to build its heartbeat URL. Re-export the real value so
  // `createConnectionMonitor()` (called inside `mountOverlay`) does
  // not blow up at module-resolution time.
  API_BASE: '/api/v1',
  // OverlayHost reads the default API origin from this module (task
  // 4) so its `#serverUrl` field initialiser has a value before the
  // host is wired up. Mirror the real default here.
  DEFAULT_API_ORIGIN: 'http://localhost:3001',
  // connectionMonitor calls `resolveServerOrigin()` to build the
  // heartbeat URL. Provide a stub so module evaluation does not
  // throw — the test never exercises a live heartbeat.
  resolveServerOrigin: () => 'http://localhost:3001',
}));

vi.mock('./lib/projectMappingStore', () => ({
  lookupProject: lookupProjectMock,
}));

// Import after the mocks are registered so the content script picks up
// the spies instead of the real modules.
import {
  __setOverlayEnabledForTests,
  fetchPickerProjects,
  maybeShowProjectPicker,
  resolveProjectForUrl,
} from './content';
import { FlOverlayHost } from './components/OverlayHost';

describe('resolveProjectForUrl — task 30.3 / Req 39.2', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    lookupProjectMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the cached projectId and skips the by-url call on cache hit', async () => {
    lookupProjectMock.mockResolvedValueOnce('p1');
    apiFetchMock.mockRejectedValue(
      new Error('apiFetch must not be called on cache hit'),
    );

    const result = await resolveProjectForUrl(
      'https://example.test/dashboard?ref=email#section',
    );

    expect(result).toBe('p1');
    // The cache key drops the query string and fragment per task 30.2.
    expect(lookupProjectMock).toHaveBeenCalledTimes(1);
    expect(lookupProjectMock).toHaveBeenCalledWith({
      origin: 'https://example.test',
      pathname: '/dashboard',
    });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('falls back to GET /by-url and returns its projectId on cache miss', async () => {
    lookupProjectMock.mockResolvedValueOnce(null);
    apiFetchMock.mockResolvedValueOnce({ projectId: 'p2', pageId: 'page-7' });

    const href = 'https://app.acme.test/inbox';
    const result = await resolveProjectForUrl(href);

    expect(result).toBe('p2');
    expect(lookupProjectMock).toHaveBeenCalledTimes(1);
    expect(lookupProjectMock).toHaveBeenCalledWith({
      origin: 'https://app.acme.test',
      pathname: '/inbox',
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(
      `/projects/by-url?url=${encodeURIComponent(href)}`,
    );
  });

  it('returns null when the cache misses and the by-url call rejects', async () => {
    lookupProjectMock.mockResolvedValueOnce(null);
    apiFetchMock.mockRejectedValueOnce(new Error('Request failed with status 404'));

    const result = await resolveProjectForUrl('https://example.test/missing');

    expect(result).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the network when URL parsing fails', async () => {
    // Force `new URL(href)` to throw by passing an invalid string.
    apiFetchMock.mockResolvedValueOnce({ projectId: 'p3', pageId: 'page-3' });

    const result = await resolveProjectForUrl('not a url');

    expect(result).toBe('p3');
    // `lookupProject` is never reached when URL parsing throws — the
    // helper degrades to the server path so the overlay still works.
    expect(lookupProjectMock).not.toHaveBeenCalled();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------- */
/* Project picker fallback — task 29.4 / Req 38.2                        */
/* -------------------------------------------------------------------- */

describe('fetchPickerProjects — task 29.4 / Req 38.2', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    lookupProjectMock.mockReset();
  });

  it('GETs /projects and maps `updatedAt` to the picker`s `lastUsedAt`', async () => {
    apiFetchMock.mockResolvedValueOnce({
      projects: [
        {
          id: 'p1',
          name: 'Alpha',
          urls: [],
          status: 'active',
          ownerId: 'u1',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-06-01T00:00:00Z',
        },
        {
          id: 'p2',
          name: 'Beta',
          urls: [],
          status: 'active',
          ownerId: 'u1',
          createdAt: '2024-02-01T00:00:00Z',
          updatedAt: '2024-04-01T00:00:00Z',
        },
      ],
    });

    const result = await fetchPickerProjects();

    expect(apiFetchMock).toHaveBeenCalledWith('/projects');
    expect(result).toEqual([
      { id: 'p1', name: 'Alpha', lastUsedAt: '2024-06-01T00:00:00Z' },
      { id: 'p2', name: 'Beta', lastUsedAt: '2024-04-01T00:00:00Z' },
    ]);
  });

  it('returns an empty list when the server response has no projects array', async () => {
    apiFetchMock.mockResolvedValueOnce({});
    const result = await fetchPickerProjects();
    expect(result).toEqual([]);
  });
});

describe('maybeShowProjectPicker — task 29.4 / Req 38.2', () => {
  let host: FlOverlayHost;
  let chromeStore: Record<string, unknown>;

  beforeEach(() => {
    apiFetchMock.mockReset();
    lookupProjectMock.mockReset();
    document.body.replaceChildren();
    chromeStore = { pinpoint_auth_token: 'fake-token' };
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => {
            if (key in chromeStore) return { [key]: chromeStore[key] };
            return {};
          }),
          set: vi.fn(async (entries: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(entries)) chromeStore[k] = v;
          }),
          remove: vi.fn(async (key: string) => {
            delete chromeStore[key];
          }),
        },
      },
    });
    host = document.createElement('fl-overlay-host') as FlOverlayHost;
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.unstubAllGlobals();
    __setOverlayEnabledForTests(false);
  });

  it('reveals the picker with the fetched projects when overlay is enabled and the user is signed in', async () => {
    __setOverlayEnabledForTests(true);
    apiFetchMock.mockResolvedValueOnce({
      projects: [
        {
          id: 'p1',
          name: 'Alpha',
          urls: [],
          status: 'active',
          ownerId: 'u1',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-06-01T00:00:00Z',
        },
      ],
    });

    await maybeShowProjectPicker(host);

    expect(apiFetchMock).toHaveBeenCalledWith('/projects');
    expect(host.pickerVisible).toBe(true);
    const picker = host.shadowRoot!.querySelector('fl-project-picker') as HTMLElement & {
      projects: ReadonlyArray<{ id: string; name: string; lastUsedAt: string }>;
    };
    expect(picker.projects.map((p) => p.id)).toEqual(['p1']);
  });

  it('does NOT show the picker when the overlay is disabled', async () => {
    __setOverlayEnabledForTests(false);
    await maybeShowProjectPicker(host);
    expect(host.pickerVisible).toBe(false);
    // Crucially we also skip the network call — no point fetching while
    // the shadow host is `display: none`.
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('does NOT show the picker when the user is signed out', async () => {
    __setOverlayEnabledForTests(true);
    delete chromeStore.pinpoint_auth_token;

    await maybeShowProjectPicker(host);

    expect(host.pickerVisible).toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('does NOT show the picker when the host already has a Project bound', async () => {
    __setOverlayEnabledForTests(true);
    host.projectId = 'project-existing';
    apiFetchMock.mockResolvedValueOnce({ projects: [] });

    await maybeShowProjectPicker(host);

    expect(host.pickerVisible).toBe(false);
  });

  it('swallows network errors from /projects so the host page stays stable', async () => {
    __setOverlayEnabledForTests(true);
    apiFetchMock.mockRejectedValueOnce(new Error('boom'));

    await expect(maybeShowProjectPicker(host)).resolves.toBeUndefined();
    expect(host.pickerVisible).toBe(false);
  });
});

/* -------------------------------------------------------------------- */
/* Per-site allow/block guard — task 38.2 / Req 46.2                     */
/* -------------------------------------------------------------------- */

/**
 * The content script's top-level `runGuardThenBootstrap()` runs on
 * module load: it reads `chrome.storage.sync` for the persisted block /
 * allow lists (keys `fl_allow_list` / `fl_block_list`) and bails before
 * `bootstrap()` when `location.hostname` matches the block-list (or
 * fails the non-empty allow-list).
 *
 * These integration tests exercise that path end-to-end — installing a
 * `chrome.storage.sync` stub, dynamically `import()`ing the content
 * script so the guard re-runs against the stub, then asserting the
 * DOM-level outcome:
 *
 *   - block-list match → no `<div id="pinpoint-shadow-host">` is
 *     appended to the document, no `<fl-overlay-host>` mounted.
 *   - block-list does NOT match (and allow-list empty) → the shadow
 *     host appears with `<fl-overlay-host>` inside its open Shadow Root.
 *
 * Storage failures default to "inject" so a flaky `chrome.storage.sync`
 * never silently disables the extension; we cover that case too so any
 * regression in the fail-open contract is caught here as well as in
 * `hostFilter.test.ts`.
 */
describe('content script bootstrap guard — task 38.2 / Req 46.2', () => {
  /**
   * Build a `chrome` stub with both `storage.sync` (allow/block lists,
   * task 38.1) and `storage.local` (auth token, task 23.2) wired up.
   * `mountOverlay()` reads the auth token regardless of guard outcome,
   * so the stub must satisfy both surfaces or the bootstrap path
   * crashes before we can inspect the DOM.
   */
  function installChromeStub(opts: {
    block?: string[];
    allow?: string[];
    rejectSyncGet?: boolean;
    omitSync?: boolean;
  } = {}) {
    const syncGet = vi.fn(async () => {
      if (opts.rejectSyncGet) throw new Error('storage.sync exploded');
      return {
        ...(opts.allow ? { fl_allow_list: opts.allow } : {}),
        ...(opts.block ? { fl_block_list: opts.block } : {}),
      };
    });
    const stub: Record<string, unknown> = {
      runtime: { onMessage: { addListener: vi.fn() } },
      storage: {
        local: {
          // No stored auth token → `mountOverlay` resolves null, the
          // overlay still appends but seedProjectData is skipped.
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
    };
    if (!opts.omitSync) {
      (stub.storage as { sync?: unknown }).sync = {
        get: syncGet,
        set: vi.fn(async () => undefined),
      };
    }
    vi.stubGlobal('chrome', stub);
    return { syncGet };
  }

  /**
   * Drive the dynamic-import guard run to completion. The guard fires
   * `await shouldSkipInjection()` then either returns early or calls
   * `bootstrap()` → `mountOverlay()` (also async). Awaiting a couple
   * of microtask ticks lets every promise settle so the assertion
   * sees the final DOM state.
   */
  async function flushAsync(): Promise<void> {
    // Two awaits cover the two `await`s in
    // `runGuardThenBootstrap` → `bootstrap` → `mountOverlay`.
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  }

  function shadowHost(): HTMLElement | null {
    return document.getElementById('pinpoint-shadow-host');
  }

  beforeEach(() => {
    apiFetchMock.mockReset();
    lookupProjectMock.mockReset();
    document.body.replaceChildren();
    // Each test imports `./content` fresh so the top-level guard
    // re-runs against the per-test storage stub. The rest of the
    // module-cache is reset too so `historyPatch`'s `__installed__`
    // sentinel and the Syncer's `installed` flag start from scratch.
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('does NOT append the shadow host when the current host matches the block-list', async () => {
    // jsdom's default location.hostname is `localhost`; block exactly
    // that so the guard's `currentHostname()` returns a matching value.
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    installChromeStub({ block: ['localhost'] });

    await import('./content.js');
    await flushAsync();

    expect(shadowHost()).toBeNull();
    expect(document.querySelector('fl-overlay-host')).toBeNull();
    // Bail-time log includes the host and the bail reason so an
    // operator inspecting devtools can tell injection was suppressed
    // intentionally rather than crashing silently.
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('skipping injection on localhost'),
    );
    // The overlay never mounts → `apiFetch` is never called either,
    // confirming the guard short-circuits *before* any network I/O.
    expect(apiFetchMock).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('does NOT append the shadow host when a wildcard block-list pattern matches', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    // jsdom hostname is `localhost`; `*.localhost` would NOT match the
    // apex per `hostMatcher` rules, but `*.local` would not match
    // either. We use the `*.<suffix>` rule that matches the apex itself
    // (suffix === host) so wildcard support is exercised end-to-end.
    installChromeStub({ block: ['*.localhost'] });

    await import('./content.js');
    await flushAsync();

    expect(shadowHost()).toBeNull();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('block-list'),
    );
    debugSpy.mockRestore();
  });

  it('appends the shadow host with <fl-overlay-host> when the host is not blocked', async () => {
    // No matching pattern → guard falls through to `bootstrap()` →
    // `mountOverlay()` and the shadow host is created. We also stub
    // `apiFetch` so `resolveProjectForUrl` returns null (no project
    // mapping) without a real network call.
    apiFetchMock.mockRejectedValue(new Error('Request failed with status 404'));
    lookupProjectMock.mockResolvedValue(null);
    installChromeStub({ block: ['some.other.host'] });

    await import('./content.js');
    await flushAsync();

    const host = shadowHost();
    expect(host).not.toBeNull();
    // The script attaches an open Shadow Root and appends a single
    // `<fl-overlay-host>` inside it (design.md §"Shadow DOM root").
    const root = host!.shadowRoot;
    expect(root).not.toBeNull();
    expect(root!.querySelector('fl-overlay-host')).not.toBeNull();
  });

  it('falls back to "inject" when chrome.storage.sync rejects (fail-open contract)', async () => {
    apiFetchMock.mockRejectedValue(new Error('Request failed with status 404'));
    lookupProjectMock.mockResolvedValue(null);
    // Storage.sync exists but its `.get` rejects — `shouldSkipInjection`
    // catches and defaults to allow so the user's overlay never
    // disappears just because storage is flaky.
    installChromeStub({ rejectSyncGet: true });

    await import('./content.js');
    await flushAsync();

    expect(shadowHost()).not.toBeNull();
  });

  it('falls back to "inject" when chrome.storage.sync is unavailable', async () => {
    apiFetchMock.mockRejectedValue(new Error('Request failed with status 404'));
    lookupProjectMock.mockResolvedValue(null);
    // No `chrome.storage.sync` namespace at all (some service-worker
    // contexts strip it). `readHostFilterLists` short-circuits to an
    // empty list pair; the decision falls through to "inject".
    installChromeStub({ omitSync: true });

    await import('./content.js');
    await flushAsync();

    expect(shadowHost()).not.toBeNull();
  });
});

/* -------------------------------------------------------------------- */
/* Per-site allow-list guard — task 38.3 / Req 46.3                      */
/* -------------------------------------------------------------------- */

/**
 * Allow-list mode (Req 46.3): when the user has populated the allow-list
 * via the extension options page (task 38.1), the content script must
 * inject only on hosts that match a pattern in the list. Hosts outside
 * the list — even ones that are not on the block-list — must be left
 * untouched.
 *
 * Coverage mirrors the three branches of `decideInjection` for an
 * allow-list-only configuration, exercised end-to-end through the
 * top-level `runGuardThenBootstrap()`:
 *
 *   - Empty allow-list (default-allow) → shadow host mounts.
 *   - Non-empty allow-list with no matching pattern → no mount.
 *   - Non-empty allow-list with a matching pattern → mounts.
 *
 * The pure decision logic and storage round-trip are already covered
 * exhaustively in `extension/src/lib/hostFilter.test.ts`; these tests
 * verify the wiring between that decision and the actual DOM-level
 * side effects of the content script.
 */
describe('content script bootstrap guard — task 38.3 / Req 46.3', () => {
  /**
   * Mirrors the helper in the 38.2 block above so the two suites stay
   * aligned. Builds a minimal `chrome` stub with both `storage.sync`
   * (allow/block lists) and `storage.local` (auth token), then registers
   * it as a global before the dynamic `import('./content')`.
   */
  function installChromeStub(opts: {
    allow?: string[];
    block?: string[];
  } = {}) {
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener: vi.fn() } },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
        sync: {
          get: vi.fn(async () => ({
            ...(opts.allow ? { fl_allow_list: opts.allow } : {}),
            ...(opts.block ? { fl_block_list: opts.block } : {}),
          })),
          set: vi.fn(async () => undefined),
        },
      },
    });
  }

  async function flushAsync(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  }

  function shadowHost(): HTMLElement | null {
    return document.getElementById('pinpoint-shadow-host');
  }

  beforeEach(() => {
    apiFetchMock.mockReset();
    lookupProjectMock.mockReset();
    // Stub the network and project-mapping cache so `mountOverlay()`
    // resolves null (no project bound) without any real I/O regardless
    // of which branch the guard takes.
    apiFetchMock.mockRejectedValue(new Error('Request failed with status 404'));
    lookupProjectMock.mockResolvedValue(null);
    document.body.replaceChildren();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('mounts the overlay when the allow-list is empty (default-allow)', async () => {
    // No allow-list, no block-list → the guard falls through to
    // `bootstrap()` and the shadow host appears with
    // `<fl-overlay-host>` inside its open Shadow Root.
    installChromeStub({});

    await import('./content.js');
    await flushAsync();

    const host = shadowHost();
    expect(host).not.toBeNull();
    expect(host!.shadowRoot!.querySelector('fl-overlay-host')).not.toBeNull();
  });

  it('does NOT mount the overlay when the allow-list is non-empty and the host does not match', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    // jsdom's default `location.hostname` is `localhost`; populating the
    // allow-list with patterns that do NOT cover `localhost` leaves the
    // current host outside the allow-list and the guard must bail.
    installChromeStub({ allow: ['example.com', '*.acme.test'] });

    await import('./content.js');
    await flushAsync();

    expect(shadowHost()).toBeNull();
    expect(document.querySelector('fl-overlay-host')).toBeNull();
    // The bail-time `console.debug` carries the allow-list reason so an
    // operator inspecting devtools can distinguish "user excluded this
    // host" from "the script crashed silently".
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('host not in non-empty allow-list'),
    );
    // The overlay never mounts → no network call hits `apiFetch`.
    expect(apiFetchMock).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('mounts the overlay when the allow-list is non-empty and the host matches', async () => {
    // jsdom's default `location.hostname` is `localhost`; including it
    // verbatim in the allow-list lets the guard fall through to
    // `bootstrap()` even though the list is non-empty.
    installChromeStub({ allow: ['localhost', 'example.com'] });

    await import('./content.js');
    await flushAsync();

    const host = shadowHost();
    expect(host).not.toBeNull();
    expect(host!.shadowRoot!.querySelector('fl-overlay-host')).not.toBeNull();
  });
});
