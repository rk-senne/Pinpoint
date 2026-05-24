// @vitest-environment jsdom
/**
 * Unit tests for `dashboard/src/lib/api.ts` — Task 7.4 / Requirements
 * 18.1, 18.4, 25.3.
 *
 * Covers:
 * - Every fetch carries `credentials: 'include'` so the HttpOnly
 *   `fl_session` cookie is attached (Req 18.1, 18.4).
 * - `POST/PUT/PATCH/DELETE` carry the `X-CSRF-Token` header echoing the
 *   in-memory CSRF token (double-submit-cookie pattern, Req 18.4).
 * - `GET` does NOT carry the `X-CSRF-Token` header (the server's CSRF
 *   middleware exempts read-only methods).
 * - When no CSRF token is in memory, `POST` is sent without the header.
 * - Errors surface the server's `error.message` envelope.
 * - All requests are prefixed with `/api/v1` (Req 25.3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(async () => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function importApi() {
  return await import('./api');
}

async function importAuth() {
  return await import('./auth');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiFetch', () => {
  it('prefixes every request with /api/v1', async () => {
    const auth = await importAuth();
    auth.setCsrfToken('csrf-abc');

    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    vi.stubGlobal('fetch', fetchSpy);

    const { apiFetch } = await importApi();
    await apiFetch('/users/me');

    const [url] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/users/me');
  });

  it('sends credentials: "include" so the fl_session cookie is attached (Req 18.1)', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    vi.stubGlobal('fetch', fetchSpy);

    const { apiFetch } = await importApi();
    await apiFetch('/users/me');

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe('include');
  });

  it('attaches X-CSRF-Token on POST when a CSRF token is in memory (Req 18.4)', async () => {
    const auth = await importAuth();
    auth.setCsrfToken('csrf-abc');

    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    vi.stubGlobal('fetch', fetchSpy);

    const { apiFetch } = await importApi();
    await apiFetch('/projects', { method: 'POST', body: JSON.stringify({}) });

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-CSRF-Token']).toBe('csrf-abc');
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.credentials).toBe('include');
  });

  it('attaches X-CSRF-Token on PUT, PATCH, and DELETE', async () => {
    const auth = await importAuth();
    auth.setCsrfToken('csrf-xyz');

    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    vi.stubGlobal('fetch', fetchSpy);

    const { apiFetch } = await importApi();

    await apiFetch('/x', { method: 'PUT' });
    await apiFetch('/x', { method: 'PATCH' });
    await apiFetch('/x', { method: 'DELETE' });

    for (const call of fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>) {
      const init = call[1];
      const headers = init.headers as Record<string, string>;
      expect(headers['X-CSRF-Token']).toBe('csrf-xyz');
    }
  });

  it('does NOT attach X-CSRF-Token on GET (read-only requests are exempt)', async () => {
    const auth = await importAuth();
    auth.setCsrfToken('csrf-abc');

    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    vi.stubGlobal('fetch', fetchSpy);

    const { apiFetch } = await importApi();
    await apiFetch('/users/me');

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-CSRF-Token']).toBeUndefined();
  });

  it('omits X-CSRF-Token on POST when no CSRF token is in memory', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    vi.stubGlobal('fetch', fetchSpy);

    const { apiFetch } = await importApi();
    await apiFetch('/auth/login', { method: 'POST' });

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-CSRF-Token']).toBeUndefined();
    // Credentials are still sent so any pre-existing cookies travel.
    expect(init.credentials).toBe('include');
  });

  it('returns the parsed JSON body on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ id: 'p-1', name: 'Demo' }))),
    );

    const { apiFetch } = await importApi();
    const result = await apiFetch<{ id: string; name: string }>('/projects/p-1');
    expect(result).toEqual({ id: 'p-1', name: 'Demo' });
  });

  it('throws an Error carrying the server-provided error.message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            { error: { code: 'BAD', message: 'nope nope nope' } },
            400,
          ),
        ),
      ),
    );

    const { apiFetch } = await importApi();
    await expect(apiFetch('/projects')).rejects.toThrow('nope nope nope');
  });

  it('falls back to a status-based message when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('plain', { status: 500 }))),
    );

    const { apiFetch } = await importApi();
    await expect(apiFetch('/projects')).rejects.toThrow(/500/);
  });

  it('preserves caller-supplied headers and merges them with the CSRF header', async () => {
    const auth = await importAuth();
    auth.setCsrfToken('csrf-abc');

    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    vi.stubGlobal('fetch', fetchSpy);

    const { apiFetch } = await importApi();
    await apiFetch('/x', {
      method: 'POST',
      headers: { 'X-Custom': 'hello' },
    });

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Custom']).toBe('hello');
    expect(headers['X-CSRF-Token']).toBe('csrf-abc');
  });
});
