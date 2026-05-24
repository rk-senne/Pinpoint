/**
 * Unit tests for `extension/src/lib/api.ts` — the central API client and
 * its sliding-window refresh wrapper (Requirement 33.4, task 24.4).
 *
 * Coverage:
 *   - `decodeJwtExp` returns the `exp` claim for a well-formed token,
 *     handles the URL-safe alphabet + missing padding, and returns `null`
 *     for malformed inputs.
 *   - `shouldRefreshToken` flips at the 5-minute boundary.
 *   - `apiFetchRaw` calls `/auth/refresh` exactly once when the stored
 *     token is within the refresh window, replaces the stored token, and
 *     uses the new token on the original request.
 *   - Concurrent calls coalesce onto a single in-flight refresh.
 *   - When `/auth/refresh` returns 401, the wrapper does NOT loop — it
 *     proceeds with the original token and lets the caller surface the
 *     resulting 401 (handled by task 24.5).
 *   - A token comfortably away from expiry triggers no refresh call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REFRESH_THRESHOLD_SECONDS,
  __resetInflightRefreshForTests,
  apiFetchRaw,
  decodeJwtExp,
  shouldRefreshToken,
} from './api';

const STORAGE_KEY_TOKEN = 'pinpoint_auth_token';

interface ChromeStub {
  storage: {
    local: {
      _data: Record<string, unknown>;
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
  };
  action?: {
    openPopup: ReturnType<typeof vi.fn>;
  };
}

interface InstallChromeStubOptions {
  initialToken?: string;
  /** When true, attaches a `chrome.action.openPopup` mock so the wrapper
   *  exercises the service-worker path; otherwise the wrapper falls
   *  through to the `pinpoint:auth-required` event. */
  withAction?: boolean;
}

function installChromeStub(
  optionsOrToken: InstallChromeStubOptions | string = {},
): ChromeStub {
  const options: InstallChromeStubOptions =
    typeof optionsOrToken === 'string'
      ? { initialToken: optionsOrToken }
      : optionsOrToken;
  const data: Record<string, unknown> = {};
  if (options.initialToken) data[STORAGE_KEY_TOKEN] = options.initialToken;
  const stub: ChromeStub = {
    storage: {
      local: {
        _data: data,
        get: vi.fn(async (key: string) => {
          if (typeof key === 'string') {
            return key in data ? { [key]: data[key] } : {};
          }
          return {};
        }),
        set: vi.fn(async (entries: Record<string, unknown>) => {
          Object.assign(data, entries);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const key of list) delete data[key];
        }),
      },
    },
  };
  if (options.withAction) {
    stub.action = { openPopup: vi.fn(() => undefined) };
  }
  vi.stubGlobal('chrome', stub);
  return stub;
}

/**
 * Mint a JWT-shaped string with a base64url-encoded payload that carries
 * the requested `exp` (and optionally other claims). Signature is a
 * placeholder — `decodeJwtExp` performs no signature verification.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=+$/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${enc(header)}.${enc(payload)}.signature-placeholder`;
}

function jsonResponse(
  body: unknown,
  init: ResponseInit = { status: 200 },
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

beforeEach(() => {
  __resetInflightRefreshForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('decodeJwtExp', () => {
  it('returns the `exp` claim from a base64url-encoded payload', () => {
    const exp = 1_700_000_000;
    expect(decodeJwtExp(makeJwt({ userId: 'u1', exp }))).toBe(exp);
  });

  it('handles URL-safe alphabet (`-` / `_`) and missing padding', () => {
    // Force a payload whose base64 encoding contains `-` and `_`. We do
    // this by stuffing the userId with bytes that round-trip into both
    // characters: `??>` → "Pz8+" (with `+`), `???` → "Pz8/" (with `/`).
    const exp = 1_234_567_890;
    const token = makeJwt({ userId: '???>', exp });
    expect(token).toMatch(/[-_]/);
    expect(decodeJwtExp(token)).toBe(exp);
  });

  it('returns null for malformed tokens', () => {
    expect(decodeJwtExp('')).toBeNull();
    expect(decodeJwtExp('not-a-jwt')).toBeNull();
    expect(decodeJwtExp('only.one')).toBeNull();
    // Payload that is not valid base64url JSON.
    expect(decodeJwtExp('aaa.???.bbb')).toBeNull();
  });

  it('returns null when the payload has no numeric `exp`', () => {
    expect(decodeJwtExp(makeJwt({ userId: 'u1' }))).toBeNull();
    expect(decodeJwtExp(makeJwt({ exp: 'soon' }))).toBeNull();
  });
});

describe('shouldRefreshToken', () => {
  const NOW = 1_700_000_000;

  it('returns true when exp is within the 5-minute window', () => {
    const token = makeJwt({ exp: NOW + REFRESH_THRESHOLD_SECONDS - 1 });
    expect(shouldRefreshToken(token, NOW)).toBe(true);
  });

  it('returns false when exp is outside the window', () => {
    const token = makeJwt({ exp: NOW + REFRESH_THRESHOLD_SECONDS + 60 });
    expect(shouldRefreshToken(token, NOW)).toBe(false);
  });

  it('returns true for an already-expired token (exp in the past)', () => {
    const token = makeJwt({ exp: NOW - 60 });
    expect(shouldRefreshToken(token, NOW)).toBe(true);
  });

  it('returns false when the token cannot be decoded', () => {
    expect(shouldRefreshToken('garbage', NOW)).toBe(false);
  });
});

describe('apiFetchRaw — sliding-window refresh (Req 33.4)', () => {
  it('refreshes the token when within 5 minutes of expiry, then uses the new token', async () => {
    const expiringToken = makeJwt({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) + 60, // < 5 min away
    });
    const chromeStub = installChromeStub(expiringToken);

    const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/refresh')) {
        // Sanity-check the refresh request carries the *current* token.
        expect((init.headers as Record<string, string>).Authorization).toBe(
          `Bearer ${expiringToken}`,
        );
        return jsonResponse({ token: 'fresh-token' });
      }
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const res = await apiFetchRaw('/projects');
    expect(res.ok).toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const refreshCall = fetchSpy.mock.calls[0]!;
    const originalCall = fetchSpy.mock.calls[1]!;
    expect(refreshCall[0]).toMatch(/\/api\/v1\/auth\/refresh$/);
    expect(refreshCall[1].method).toBe('POST');

    // Original request used the freshly-minted token, not the old one.
    expect(originalCall[0]).toMatch(/\/api\/v1\/projects$/);
    expect((originalCall[1].headers as Record<string, string>).Authorization).toBe(
      'Bearer fresh-token',
    );

    // Storage was updated with the new token.
    expect(chromeStub.storage.local.set).toHaveBeenCalledWith({
      [STORAGE_KEY_TOKEN]: 'fresh-token',
    });
    expect(chromeStub.storage.local._data[STORAGE_KEY_TOKEN]).toBe('fresh-token');
  });

  it('does NOT refresh when the token is comfortably away from expiry', async () => {
    const freshToken = makeJwt({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) + 60 * 60, // 1h away
    });
    installChromeStub(freshToken);

    const fetchSpy = vi.fn(
      async (_url: string, _init: RequestInit) => jsonResponse({ ok: true }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await apiFetchRaw('/projects');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toMatch(/\/api\/v1\/projects$/);
    expect((calledInit.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${freshToken}`,
    );
  });

  it('coalesces concurrent calls onto a single /auth/refresh round-trip', async () => {
    const expiringToken = makeJwt({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) + 30,
    });
    installChromeStub(expiringToken);

    let resolveRefresh: (value: Response) => void = () => {};
    const refreshPromise = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });

    const fetchSpy = vi.fn(async (url: string, _init: RequestInit) => {
      if (url.endsWith('/auth/refresh')) return refreshPromise;
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal('fetch', fetchSpy);

    // Fire three requests before the refresh resolves.
    const inFlight = Promise.all([
      apiFetchRaw('/a'),
      apiFetchRaw('/b'),
      apiFetchRaw('/c'),
    ]);

    // Yield a few microtasks so the wrappers can issue their refresh calls.
    await Promise.resolve();
    await Promise.resolve();

    resolveRefresh(jsonResponse({ token: 'fresh-token' }));
    await inFlight;

    const refreshCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).endsWith('/auth/refresh'),
    );
    expect(refreshCalls.length).toBe(1);

    // All three originals fired with the new token.
    const originals = fetchSpy.mock.calls.filter(
      ([url]) => !String(url).endsWith('/auth/refresh'),
    );
    expect(originals).toHaveLength(3);
    for (const call of originals) {
      const init = call[1];
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer fresh-token',
      );
    }
  });

  it('does not loop when /auth/refresh returns 401; falls through with the original token', async () => {
    const expiringToken = makeJwt({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const chromeStub = installChromeStub(expiringToken);

    const fetchSpy = vi.fn(async (url: string, _init: RequestInit) => {
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse(
          { error: { code: 'INVALID_TOKEN', message: 'expired' } },
          { status: 401 },
        );
      }
      return jsonResponse(
        { error: { code: 'INVALID_TOKEN', message: 'expired' } },
        { status: 401 },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const res = await apiFetchRaw('/projects');
    expect(res.status).toBe(401);

    // Exactly one refresh attempt, exactly one original request — no loop.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [, originalInit] = fetchSpy.mock.calls[1]!;
    // Original request used the *old* token because the refresh failed.
    expect((originalInit.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${expiringToken}`,
    );
    // The 401 from `/projects` (not the refresh) triggers task 24.5's
    // clear-and-prompt path: storage is wiped, and the call is logged
    // through `chrome.storage.local.remove`.
    expect(chromeStub.storage.local.remove).toHaveBeenCalledWith(
      STORAGE_KEY_TOKEN,
    );
    expect(STORAGE_KEY_TOKEN in chromeStub.storage.local._data).toBe(false);
  });

  it('omits Authorization when no token is stored and never refreshes', async () => {
    installChromeStub();

    const fetchSpy = vi.fn(
      async (_url: string, _init: RequestInit) => jsonResponse({ ok: true }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await apiFetchRaw('/projects');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe('apiFetchRaw — 401 cleanup (Req 33.5, task 24.5)', () => {
  /**
   * The wrapper has two possible "surface the prompt" paths:
   *   - **Service-worker path:** `chrome.action.openPopup()` is callable
   *     so we invoke it directly. No DOM event is dispatched.
   *   - **Content-script / overlay path:** `chrome.action` is undefined
   *     (content scripts don't have access to the action API) so we
   *     dispatch a `pinpoint:auth-required` CustomEvent for the
   *     overlay to listen for.
   * Both flows must clear the stored bearer and return the original 401
   * Response unchanged.
   */
  function freshTokenSecondsFromNow(secondsFromNow: number): string {
    return makeJwt({
      userId: 'u1',
      exp: Math.floor(Date.now() / 1000) + secondsFromNow,
    });
  }

  it('on 401 from /projects, clears the stored token and dispatches the auth-required CustomEvent (content-script fallback)', async () => {
    const token = freshTokenSecondsFromNow(60 * 60); // 1h, no refresh
    const chromeStub = installChromeStub(token);

    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(
        { error: { code: 'INVALID_TOKEN', message: 'expired' } },
        { status: 401 },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    // Capture any dispatched events.
    const dispatched: Event[] = [];
    const fakeWindow = {
      dispatchEvent: vi.fn((event: Event) => {
        dispatched.push(event);
        return true;
      }),
    };
    vi.stubGlobal('window', fakeWindow);

    const res = await apiFetchRaw('/projects');
    expect(res.status).toBe(401);

    // The original 401 is returned unchanged so the caller can inspect it.
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_TOKEN');

    // Stored token wiped via chrome.storage.local.remove.
    expect(chromeStub.storage.local.remove).toHaveBeenCalledWith(
      STORAGE_KEY_TOKEN,
    );
    expect(STORAGE_KEY_TOKEN in chromeStub.storage.local._data).toBe(false);

    // CustomEvent fired since chrome.action is unavailable here.
    expect(fakeWindow.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.type).toBe('pinpoint:auth-required');
  });

  it('on 401 from /projects, calls chrome.action.openPopup() when running as the service worker', async () => {
    const token = freshTokenSecondsFromNow(60 * 60);
    const chromeStub = installChromeStub({
      initialToken: token,
      withAction: true,
    });
    // Service-worker contexts have no `window`. Stubbing it as
    // `undefined` is the closest we can get without a separate vitest
    // env, and lets us assert the wrapper does not try to dispatch a
    // CustomEvent when `chrome.action.openPopup` is available.
    vi.stubGlobal('window', undefined);

    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(
        { error: { code: 'INVALID_TOKEN', message: 'expired' } },
        { status: 401 },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const res = await apiFetchRaw('/projects');
    expect(res.status).toBe(401);

    expect(chromeStub.action!.openPopup).toHaveBeenCalledTimes(1);
    expect(chromeStub.storage.local.remove).toHaveBeenCalledWith(
      STORAGE_KEY_TOKEN,
    );
    expect(STORAGE_KEY_TOKEN in chromeStub.storage.local._data).toBe(false);
  });

  it('does NOT trigger the cleanup path when the wrapped request itself is /auth/refresh', async () => {
    const token = freshTokenSecondsFromNow(60 * 60); // 1h, no auto-refresh
    const chromeStub = installChromeStub(token);

    const dispatched: Event[] = [];
    const fakeWindow = {
      dispatchEvent: vi.fn((event: Event) => {
        dispatched.push(event);
        return true;
      }),
    };
    vi.stubGlobal('window', fakeWindow);

    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(
        { error: { code: 'INVALID_TOKEN', message: 'expired' } },
        { status: 401 },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const res = await apiFetchRaw('/auth/refresh', { method: 'POST' });
    expect(res.status).toBe(401);

    // Cleanup path skipped: token still in storage, no events dispatched.
    expect(chromeStub.storage.local.remove).not.toHaveBeenCalled();
    expect(chromeStub.storage.local._data[STORAGE_KEY_TOKEN]).toBe(token);
    expect(fakeWindow.dispatchEvent).not.toHaveBeenCalled();
  });

  it('a 200 response leaves the token intact and never surfaces the prompt', async () => {
    const token = freshTokenSecondsFromNow(60 * 60);
    const chromeStub = installChromeStub({
      initialToken: token,
      withAction: true,
    });

    const dispatched: Event[] = [];
    const fakeWindow = {
      dispatchEvent: vi.fn((event: Event) => {
        dispatched.push(event);
        return true;
      }),
    };
    vi.stubGlobal('window', fakeWindow);

    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ ok: true }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const res = await apiFetchRaw('/projects');
    expect(res.ok).toBe(true);

    expect(chromeStub.storage.local.remove).not.toHaveBeenCalled();
    expect(chromeStub.action!.openPopup).not.toHaveBeenCalled();
    expect(fakeWindow.dispatchEvent).not.toHaveBeenCalled();
    expect(chromeStub.storage.local._data[STORAGE_KEY_TOKEN]).toBe(token);
  });
});
