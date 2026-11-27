// @vitest-environment jsdom

/**
 * Unit tests for the popup login surface (Requirement 33.1, task 24.1).
 *
 * Covers:
 * - Posts to `/api/v1/auth/login` with the entered credentials.
 * - Stores the returned bearer in `chrome.storage.local` under
 *   `pinpoint_auth_token` (matching `content.ts` / `lib/api.ts`).
 * - Sends `chrome.runtime.sendMessage({ type: 'login-complete' })` and
 *   asks the service worker to open the overlay on the active tab via
 *   `{ type: 'PP_REQUEST_TOGGLE', tabId }` (on-demand injection path).
 * - Surfaces server-error envelopes inline.
 * - Validation prevents empty submissions and never reaches `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOGIN_COMPLETE_MESSAGE,
  initPopup,
} from '../../popup/popup';
import { STORAGE_KEY_TOKEN } from '../lib/authTokenStore';

const POPUP_HTML = `
  <form id="popup-login-form" novalidate>
    <input id="popup-email" name="email" type="email" />
    <input id="popup-password" name="password" type="password" />
    <button id="popup-submit" type="submit">Sign in</button>
    <div id="popup-error" role="alert" hidden></div>
  </form>
`;

interface ChromeStub {
  storage: {
    local: {
      _data: Record<string, unknown>;
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
    };
  };
  runtime: {
    sendMessage: ReturnType<typeof vi.fn>;
  };
  tabs: {
    query: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
  };
}

function installChromeStub(): ChromeStub {
  const data: Record<string, unknown> = {};
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
      },
    },
    runtime: {
      sendMessage: vi.fn(),
    },
    tabs: {
      query: vi.fn(async () => [{ id: 42 }]),
      reload: vi.fn(async () => undefined),
    },
  };
  vi.stubGlobal('chrome', stub);
  return stub;
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

let chromeStub: ChromeStub;

beforeEach(() => {
  document.body.innerHTML = POPUP_HTML;
  chromeStub = installChromeStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function flush(): Promise<void> {
  // Settle the chained promises in the submit handler.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('initPopup', () => {
  it('POSTs credentials to /api/v1/auth/login, stores the bearer, broadcasts login-complete, and requests overlay toggle on the active tab', async () => {
    // Prevent the popup's `window.close()` call from tearing down jsdom.
    vi.spyOn(window, 'close').mockImplementation(() => {});

    const fetchSpy = vi.fn(async () =>
      jsonResponse({
        user: {
          id: 'u1',
          email: 'alice@example.test',
          name: 'Alice',
          createdAt: '2024-01-01T00:00:00Z',
        },
        token: 'jwt-from-login',
        csrfToken: 'csrf-token',
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await initPopup(document);

    (document.getElementById('popup-email') as HTMLInputElement).value =
      'alice@example.test';
    (document.getElementById('popup-password') as HTMLInputElement).value =
      'hunter2';

    document.getElementById('popup-login-form')!.dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );

    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toMatch(/\/api\/v1\/auth\/login$/);
    expect(calledInit.method).toBe('POST');
    expect(calledInit.headers).toMatchObject({
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(calledInit.body as string)).toEqual({
      email: 'alice@example.test',
      password: 'hunter2',
    });

    expect(chromeStub.storage.local.set).toHaveBeenCalledWith({
      [STORAGE_KEY_TOKEN]: 'jwt-from-login',
    });
    expect(chromeStub.storage.local._data[STORAGE_KEY_TOKEN]).toBe('jwt-from-login');

    expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith(
      LOGIN_COMPLETE_MESSAGE,
    );
    expect(chromeStub.tabs.query).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
    expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'PP_REQUEST_TOGGLE',
      tabId: 42,
    });
  });

  it('shows the server error envelope inline and does not store a token', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(
        { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } },
        { status: 401 },
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await initPopup(document);

    (document.getElementById('popup-email') as HTMLInputElement).value =
      'alice@example.test';
    (document.getElementById('popup-password') as HTMLInputElement).value =
      'wrong';

    document.getElementById('popup-login-form')!.dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );

    await flush();

    const error = document.getElementById('popup-error')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('Invalid email or password.');
    expect(chromeStub.storage.local.set).not.toHaveBeenCalled();
    expect(chromeStub.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('blocks submission when fields are empty and never calls fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await initPopup(document);

    document.getElementById('popup-login-form')!.dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );

    await flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    const error = document.getElementById('popup-error')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('Please enter your email and password.');
    expect(chromeStub.storage.local.set).not.toHaveBeenCalled();
  });

  it('disables the submit button while a request is in flight', async () => {
    vi.spyOn(window, 'close').mockImplementation(() => {});

    let resolveFetch: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void = () => {};
    const fetchPromise: Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> =
      new Promise((resolve) => {
        resolveFetch = resolve;
      });
    const fetchSpy = vi.fn(() => fetchPromise);
    vi.stubGlobal('fetch', fetchSpy);

    await initPopup(document);

    (document.getElementById('popup-email') as HTMLInputElement).value =
      'alice@example.test';
    (document.getElementById('popup-password') as HTMLInputElement).value =
      'hunter2';

    document.getElementById('popup-login-form')!.dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );

    // Allow the synchronous portion of the submit handler to run.
    await Promise.resolve();

    const submit = document.getElementById('popup-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe('Signing in…');

    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({
        user: {
          id: 'u1',
          email: 'a@b.test',
          name: 'A',
          createdAt: '2024-01-01T00:00:00Z',
        },
        token: 'tok',
      }),
    });
    // Drain enough microtasks for the async submit handler's `try { ...
    // } finally { setLoading(false) }` to run all the way through.
    for (let i = 0; i < 5; i += 1) await flush();

    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe('Sign in');
  });
});

describe('initPopup signed-in view', () => {
  const SIGNED_IN_HTML = `
    <section id="popup-signed-in" hidden>
      <span id="popup-avatar"></span>
      <div id="popup-user-name"></div><div id="popup-user-email"></div>
      <button id="popup-open-overlay" type="button"></button>
      <button id="popup-open-options" type="button"></button>
      <button id="popup-signout" type="button"></button>
    </section>
    <h1 id="popup-signin-title">Sign in</h1>
  `;

  beforeEach(() => {
    document.body.innerHTML = SIGNED_IN_HTML + POPUP_HTML;
  });

  it('shows the sign-in form when no token is stored', async () => {
    await initPopup(document);
    expect(document.getElementById('popup-signed-in')!.hidden).toBe(true);
    expect((document.getElementById('popup-login-form') as HTMLFormElement).hidden).toBe(false);
  });

  it('shows who is signed in instead of the form, and signs out', async () => {
    chromeStub.storage.local._data[STORAGE_KEY_TOKEN] = 'jwt';
    (chromeStub.storage.local as unknown as { remove: unknown }).remove = vi.fn(async (k: string) => {
      delete chromeStub.storage.local._data[k];
    });
    const fetchSpy = vi.fn(async (url: string) =>
      String(url).endsWith('/users/me')
        ? jsonResponse({ user: { name: 'Ada Lovelace', email: 'ada@example.test' } })
        : jsonResponse({}),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await initPopup(document);
    await flush();
    expect(document.getElementById('popup-signed-in')!.hidden).toBe(false);
    expect((document.getElementById('popup-login-form') as HTMLFormElement).hidden).toBe(true);
    expect(document.getElementById('popup-user-name')!.textContent).toBe('Ada Lovelace');
    expect(document.getElementById('popup-user-email')!.textContent).toBe('ada@example.test');
    expect(document.getElementById('popup-avatar')!.textContent).toBe('A');

    document.getElementById('popup-signout')!.click();
    await flush();
    expect(fetchSpy.mock.calls.some(([u]) => String(u).endsWith('/auth/logout'))).toBe(true);
    expect(chromeStub.storage.local._data[STORAGE_KEY_TOKEN]).toBeUndefined();
    expect(document.getElementById('popup-signed-in')!.hidden).toBe(true);
    expect((document.getElementById('popup-login-form') as HTMLFormElement).hidden).toBe(false);
  });

  it('"Annotate this page" asks the service worker to toggle the active tab', async () => {
    vi.spyOn(window, 'close').mockImplementation(() => {});
    chromeStub.storage.local._data[STORAGE_KEY_TOKEN] = 'jwt';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ user: { name: 'A', email: 'a@x.test' } })));
    await initPopup(document);
    document.getElementById('popup-open-overlay')!.click();
    await flush();
    expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith({ type: 'PP_REQUEST_TOGGLE', tabId: 42 });
  });
});
