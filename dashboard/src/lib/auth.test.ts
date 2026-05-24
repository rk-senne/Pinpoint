// @vitest-environment jsdom
/**
 * Unit tests for `dashboard/src/lib/auth.ts` — Task 7.4 / Requirements
 * 18.1, 18.2, 18.4.
 *
 * Covers:
 * - Tokens are NOT persisted to `localStorage` or `sessionStorage`
 *   (Req 18.2). The CSRF token and the in-memory bearer JWT live in
 *   module-level variables.
 * - `setCsrfToken` / `getCsrfToken` round-trip (cleared via `clearAuth`).
 * - `setToken` / `getToken` round-trip (cleared via `clearAuth`).
 * - `clearAuth()` drops every token in one shot.
 * - `getIsAuthed()` returns `true` iff a CSRF token is in memory.
 * - `probeIsAuthed()` consults `GET /users/me` when no CSRF token is
 *   present and returns true on 2xx, false on 401, and false on
 *   network error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(async () => {
  vi.resetModules();
  // Clear any leakage from prior tests — ensures the module-level
  // tokens really do start as `null`.
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function importAuth() {
  return await import('./auth');
}

describe('CSRF token slot', () => {
  it('starts empty', async () => {
    const auth = await importAuth();
    expect(auth.getCsrfToken()).toBeNull();
  });

  it('round-trips through setCsrfToken / getCsrfToken / clearAuth', async () => {
    const auth = await importAuth();

    auth.setCsrfToken('csrf-abc');
    expect(auth.getCsrfToken()).toBe('csrf-abc');

    auth.clearAuth();
    expect(auth.getCsrfToken()).toBeNull();
  });

  it('does not write the CSRF token to localStorage or sessionStorage (Req 18.2)', async () => {
    const auth = await importAuth();

    auth.setCsrfToken('csrf-abc');

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe('Bearer token slot (in-memory only)', () => {
  it('starts empty', async () => {
    const auth = await importAuth();
    expect(auth.getToken()).toBeNull();
  });

  it('round-trips through setToken / getToken / clearAuth', async () => {
    const auth = await importAuth();

    auth.setToken('jwt-1');
    expect(auth.getToken()).toBe('jwt-1');

    auth.clearAuth();
    expect(auth.getToken()).toBeNull();
  });

  it('does not persist the bearer JWT to localStorage or sessionStorage (Req 18.2)', async () => {
    const auth = await importAuth();

    auth.setToken('jwt-1');

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe('clearAuth', () => {
  it('drops both the CSRF token and the bearer JWT in one call', async () => {
    const auth = await importAuth();

    auth.setCsrfToken('csrf-abc');
    auth.setToken('jwt-1');

    auth.clearAuth();

    expect(auth.getCsrfToken()).toBeNull();
    expect(auth.getToken()).toBeNull();
  });
});

describe('getIsAuthed', () => {
  it('returns false when no CSRF token has been captured', async () => {
    const auth = await importAuth();
    expect(auth.getIsAuthed()).toBe(false);
  });

  it('returns true once the CSRF token is set', async () => {
    const auth = await importAuth();

    auth.setCsrfToken('csrf-abc');

    expect(auth.getIsAuthed()).toBe(true);
  });

  it('returns false again after clearAuth', async () => {
    const auth = await importAuth();

    auth.setCsrfToken('csrf-abc');
    expect(auth.getIsAuthed()).toBe(true);

    auth.clearAuth();
    expect(auth.getIsAuthed()).toBe(false);
  });
});

describe('probeIsAuthed', () => {
  it('returns true synchronously when a CSRF token is already in memory', async () => {
    const auth = await importAuth();
    auth.setCsrfToken('csrf-abc');

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(auth.probeIsAuthed()).resolves.toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('hits /api/v1/users/me with credentials when no CSRF token is in memory', async () => {
    const auth = await importAuth();

    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await auth.probeIsAuthed();

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/users/me');
    expect(init.credentials).toBe('include');
  });

  it('returns false when the probe responds 401', async () => {
    const auth = await importAuth();

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({}), { status: 401 })),
      ),
    );

    await expect(auth.probeIsAuthed()).resolves.toBe(false);
  });

  it('returns false when the probe rejects (network error)', async () => {
    const auth = await importAuth();

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));

    await expect(auth.probeIsAuthed()).resolves.toBe(false);
  });
});
