/**
 * Unit tests for `lib/serverOrigin.ts` — API origin resolution precedence
 * (user setting → build-time → default), Server URL validation, and the
 * persist path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_API_ORIGIN,
  buildTimeOrigin,
  STORAGE_KEY_API_ORIGIN,
  __resetServerOriginCacheForTests,
  resolveServerOrigin,
  resolveServerOriginSync,
  setServerOrigin,
  validateServerUrl,
} from './serverOrigin';

interface ChromeStub {
  storage: {
    local: {
      _data: Record<string, unknown>;
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
    };
    onChanged: { addListener: ReturnType<typeof vi.fn> };
  };
}

function installChromeStub(initial: Record<string, unknown> = {}): ChromeStub {
  const data: Record<string, unknown> = { ...initial };
  const stub: ChromeStub = {
    storage: {
      local: {
        _data: data,
        get: vi.fn(async (key: string) =>
          typeof key === 'string' && key in data ? { [key]: data[key] } : {},
        ),
        set: vi.fn(async (entries: Record<string, unknown>) => {
          Object.assign(data, entries);
        }),
      },
      onChanged: { addListener: vi.fn() },
    },
  };
  vi.stubGlobal('chrome', stub);
  return stub;
}

beforeEach(() => {
  __resetServerOriginCacheForTests();
  delete (globalThis as { __PINPOINT_API_ORIGIN__?: string })
    .__PINPOINT_API_ORIGIN__;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetServerOriginCacheForTests();
  delete (globalThis as { __PINPOINT_API_ORIGIN__?: string })
    .__PINPOINT_API_ORIGIN__;
});

describe('validateServerUrl', () => {
  it('accepts any https origin and normalises away the path', () => {
    expect(validateServerUrl('https://feedback.example.com')).toBe(
      'https://feedback.example.com',
    );
    expect(validateServerUrl('https://feedback.example.com:8443/ignored')).toBe(
      'https://feedback.example.com:8443',
    );
  });

  it('accepts http only for loopback hosts', () => {
    expect(validateServerUrl('http://localhost:3001')).toBe(
      'http://localhost:3001',
    );
    expect(validateServerUrl('http://127.0.0.1:3001')).toBe(
      'http://127.0.0.1:3001',
    );
  });

  it('rejects http to a remote host, bad schemes, and junk', () => {
    expect(validateServerUrl('http://example.com')).toBeNull();
    expect(validateServerUrl('ftp://example.com')).toBeNull();
    expect(validateServerUrl('not a url')).toBeNull();
    expect(validateServerUrl('')).toBeNull();
    expect(validateServerUrl('   ')).toBeNull();
  });
});

describe('resolveServerOrigin precedence', () => {
  it('prefers the user setting in storage over everything', async () => {
    installChromeStub({ [STORAGE_KEY_API_ORIGIN]: 'https://my.server.test' });
    (globalThis as { __PINPOINT_API_ORIGIN__?: string }).__PINPOINT_API_ORIGIN__ =
      'https://build.server.test';
    expect(await resolveServerOrigin()).toBe('https://my.server.test');
  });

  it('falls back to the build-time origin when no user setting', async () => {
    installChromeStub({});
    (globalThis as { __PINPOINT_API_ORIGIN__?: string }).__PINPOINT_API_ORIGIN__ =
      'https://build.server.test';
    expect(await resolveServerOrigin()).toBe('https://build.server.test');
  });

  it('falls back to the hard default when neither is set', async () => {
    installChromeStub({});
    expect(await resolveServerOrigin()).toBe(DEFAULT_API_ORIGIN);
  });

  it('returns the hard default with no chrome at all', async () => {
    // No chrome stub installed.
    expect(await resolveServerOrigin()).toBe(DEFAULT_API_ORIGIN);
  });
});

describe('re-validation on read (F7)', () => {
  const setBuild = (v: string): void => {
    (globalThis as { __PINPOINT_API_ORIGIN__?: string }).__PINPOINT_API_ORIGIN__ = v;
  };

  it.each(['http://evil.test', 'javascript:alert(1)', 'ftp://x.test', 'not a url', 'file:///etc/passwd'])(
    'ignores an invalid stored origin %s and falls back to the build-time origin',
    async (bad) => {
      installChromeStub({ [STORAGE_KEY_API_ORIGIN]: bad });
      setBuild('https://build.server.test');
      expect(await resolveServerOrigin()).toBe('https://build.server.test');
      expect(resolveServerOriginSync()).toBe('https://build.server.test');
    },
  );

  it('falls back to the default when both stored and build-time origins are invalid', async () => {
    installChromeStub({ [STORAGE_KEY_API_ORIGIN]: 'http://evil.test' });
    setBuild('http://also-evil.test');
    expect(await resolveServerOrigin()).toBe(DEFAULT_API_ORIGIN);
    expect(resolveServerOriginSync()).toBe(DEFAULT_API_ORIGIN);
  });

  it('ignores an invalid build-time origin when nothing is stored', async () => {
    installChromeStub({});
    setBuild('http://remote.test');
    expect(buildTimeOrigin()).toBeNull();
    expect(await resolveServerOrigin()).toBe(DEFAULT_API_ORIGIN);
  });

  it('normalises a valid stored origin (strips path)', async () => {
    installChromeStub({ [STORAGE_KEY_API_ORIGIN]: 'https://my.server.test/some/path' });
    expect(await resolveServerOrigin()).toBe('https://my.server.test');
  });

  it('re-validates values arriving via storage.onChanged', async () => {
    const stub = installChromeStub({});
    await resolveServerOrigin();
    const listener = stub.storage.onChanged.addListener.mock.calls[0]![0] as (
      c: Record<string, { newValue?: unknown }>,
      area: string,
    ) => void;
    listener({ [STORAGE_KEY_API_ORIGIN]: { newValue: 'http://evil.test' } }, 'local');
    expect(resolveServerOriginSync()).toBe(DEFAULT_API_ORIGIN);
    listener({ [STORAGE_KEY_API_ORIGIN]: { newValue: 'https://good.test' } }, 'local');
    expect(resolveServerOriginSync()).toBe('https://good.test');
  });
});

describe('resolveServerOriginSync', () => {
  it('returns the default before priming', () => {
    expect(resolveServerOriginSync()).toBe(DEFAULT_API_ORIGIN);
  });

  it('returns the cached user setting after an async resolve primes it', async () => {
    installChromeStub({ [STORAGE_KEY_API_ORIGIN]: 'https://primed.test' });
    await resolveServerOrigin();
    expect(resolveServerOriginSync()).toBe('https://primed.test');
  });
});

describe('setServerOrigin', () => {
  it('validates, normalises, persists, and primes the cache', async () => {
    const stub = installChromeStub({});
    const saved = await setServerOrigin('https://deployed.example.com/dashboard');
    expect(saved).toBe('https://deployed.example.com');
    expect(stub.storage.local.set).toHaveBeenCalledWith({
      [STORAGE_KEY_API_ORIGIN]: 'https://deployed.example.com',
    });
    expect(resolveServerOriginSync()).toBe('https://deployed.example.com');
  });

  it('returns null and persists nothing for an invalid URL', async () => {
    const stub = installChromeStub({});
    const saved = await setServerOrigin('http://evil.example.com');
    expect(saved).toBeNull();
    expect(stub.storage.local.set).not.toHaveBeenCalled();
  });
});
