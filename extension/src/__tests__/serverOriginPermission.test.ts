/**
 * `requestServerOriginPermission` must call `chrome.permissions.request`
 * synchronously (first thing, before any await) so it still runs inside the
 * user-input handler: Firefox rejects the request otherwise
 * ("permissions.request may only be called from a user input handler").
 * Found by driving the real Firefox build (e2e/firefox/run.mjs).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestServerOriginPermission } from '../../options/options';

function stubChrome(perms: Record<string, unknown>): void {
  (globalThis as unknown as { chrome: unknown }).chrome = { permissions: perms };
}

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('requestServerOriginPermission', () => {
  it('calls permissions.request synchronously, before any await', () => {
    const request = vi.fn().mockResolvedValue(true);
    const contains = vi.fn().mockResolvedValue(false);
    stubChrome({ request, contains });

    void requestServerOriginPermission('https://pinpoint.example.com');

    // No microtask has run yet: request must already have been invoked.
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ origins: ['https://pinpoint.example.com/*'] });
    expect(contains).not.toHaveBeenCalled();
  });

  it('returns the request result', async () => {
    stubChrome({ request: vi.fn().mockResolvedValue(false), contains: vi.fn() });
    expect(await requestServerOriginPermission('https://a.example')).toBe(false);
    stubChrome({ request: vi.fn().mockResolvedValue(true), contains: vi.fn() });
    expect(await requestServerOriginPermission('https://a.example')).toBe(true);
  });

  it('falls back to contains() when request is refused outside a gesture', async () => {
    const request = vi.fn().mockRejectedValue(new Error('may only be called from a user input handler'));
    stubChrome({ request, contains: vi.fn().mockResolvedValue(true) });
    expect(await requestServerOriginPermission('https://a.example')).toBe(true);
    stubChrome({ request, contains: vi.fn().mockResolvedValue(false) });
    expect(await requestServerOriginPermission('https://a.example')).toBe(false);
    stubChrome({ request, contains: vi.fn().mockRejectedValue(new Error('x')) });
    expect(await requestServerOriginPermission('https://a.example')).toBe(false);
  });

  it('is a no-op success when the permissions API is unavailable', async () => {
    stubChrome({});
    expect(await requestServerOriginPermission('https://a.example')).toBe(true);
  });
});
