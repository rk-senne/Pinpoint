// @vitest-environment jsdom
/**
 * consoleCapture.test.ts — Mission C2. Exercises the shared console + JS-error
 * capture: ring-buffer bounds, truncation, secret scrubbing, pass-through
 * console semantics, window error / unhandledrejection capture, the 32 KB
 * serialized snapshot clamp, and uninstall restoration.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConsoleCapture,
  MESSAGE_MAX,
  STACK_MAX,
  MAX_SERIALIZED_BYTES,
  scrubSecrets,
} from './consoleCapture';

interface FakeWindow {
  listeners: Map<string, Array<(ev: unknown) => void>>;
  addEventListener(type: string, cb: (ev: unknown) => void): void;
  removeEventListener(type: string, cb: (ev: unknown) => void): void;
  emit(type: string, ev: unknown): void;
}

function fakeWindow(): FakeWindow {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  return {
    listeners,
    addEventListener(type, cb) {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
    removeEventListener(type, cb) {
      const arr = listeners.get(type) ?? [];
      listeners.set(
        type,
        arr.filter((l) => l !== cb),
      );
    },
    emit(type, ev) {
      for (const cb of listeners.get(type) ?? []) cb(ev);
    },
  };
}

function fakeConsole() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scrubSecrets', () => {
  it('redacts Bearer tokens', () => {
    expect(scrubSecrets('Authorization: Bearer abc.DEF-123')).toContain('[REDACTED]');
    expect(scrubSecrets('Authorization: Bearer abc.DEF-123')).not.toContain('abc.DEF-123');
  });

  it('redacts sensitive query params but keeps the key', () => {
    const out = scrubSecrets('GET /x?token=secret123&password=hunter2&q=ok');
    expect(out).toContain('token=[REDACTED]');
    expect(out).toContain('password=[REDACTED]');
    expect(out).toContain('q=ok');
    expect(out).not.toContain('secret123');
    expect(out).not.toContain('hunter2');
  });

  it('redacts JWT-looking strings', () => {
    const jwt = 'eyJhbGc.eyJzdWIiOiIx.SflKxwRJ';
    expect(scrubSecrets(`token is ${jwt}`)).not.toContain(jwt);
  });

  it('redacts emails when enabled and keeps them when disabled', () => {
    expect(scrubSecrets('contact me@example.com')).not.toContain('me@example.com');
    expect(scrubSecrets('contact me@example.com', false)).toContain('me@example.com');
  });
});

describe('ConsoleCapture — console wrapping', () => {
  it('captures warn/error (not log by default) and passes through', () => {
    const console = fakeConsole();
    const warnSpy = console.warn;
    const errorSpy = console.error;
    const cap = new ConsoleCapture({ console, window: fakeWindow() });
    cap.install();

    console.warn('a warning');
    console.error('a failure');
    console.log('ignored by default');

    // Pass-through: the ORIGINAL spies are still invoked with the exact args.
    expect(warnSpy).toHaveBeenCalledWith('a warning');
    expect(errorSpy).toHaveBeenCalledWith('a failure');

    const logs = cap.getConsoleLogs();
    expect(logs.map((l) => l.level)).toEqual(['warn', 'error']);
    cap.uninstall();
  });

  it('captures console.log when captureLog is true', () => {
    const console = fakeConsole();
    const cap = new ConsoleCapture({ console, window: fakeWindow(), captureLog: true });
    cap.install();
    console.log('hello');
    expect(cap.getConsoleLogs().map((l) => l.level)).toEqual(['log']);
    cap.uninstall();
  });

  it('bounds the buffer to maxEntries (FIFO)', () => {
    const console = fakeConsole();
    const cap = new ConsoleCapture({ console, window: fakeWindow(), maxEntries: 3 });
    cap.install();
    for (let i = 0; i < 10; i++) console.error(`e${i}`);
    const logs = cap.getConsoleLogs();
    expect(logs).toHaveLength(3);
    expect(logs[0].message).toBe('e7');
    expect(logs[2].message).toBe('e9');
    cap.uninstall();
  });

  it('truncates message and stack and scrubs secrets', () => {
    const console = fakeConsole();
    const cap = new ConsoleCapture({ console, window: fakeWindow() });
    cap.install();
    const err = new Error('boom with token=supersecret');
    err.stack = 'Error: boom\n'.repeat(500); // > STACK_MAX
    console.error('x'.repeat(2000), err);
    const [entry] = cap.getConsoleLogs();
    expect(entry.message.length).toBeLessThanOrEqual(MESSAGE_MAX);
    expect(entry.message).not.toContain('supersecret');
    expect(entry.stack!.length).toBeLessThanOrEqual(STACK_MAX);
    cap.uninstall();
  });

  it('restores the originals on uninstall', () => {
    const console = fakeConsole();
    const originalWarn = console.warn;
    const cap = new ConsoleCapture({ console, window: fakeWindow() });
    cap.install();
    expect(console.warn).not.toBe(originalWarn);
    cap.uninstall();
    expect(console.warn).toBe(originalWarn);
  });
});

describe('ConsoleCapture — window errors', () => {
  it('captures error events with source/line/col and scrubbed message', () => {
    const win = fakeWindow();
    const cap = new ConsoleCapture({ console: fakeConsole(), window: win });
    cap.install();
    win.emit('error', {
      message: 'Uncaught token=leak',
      filename: 'https://app/x.js',
      lineno: 42,
      colno: 7,
      error: new Error('Uncaught token=leak'),
    });
    const [e] = cap.getJsErrors();
    expect(e.kind).toBe('error');
    expect(e.source).toBe('https://app/x.js');
    expect(e.lineno).toBe(42);
    expect(e.colno).toBe(7);
    expect(e.message).not.toContain('leak');
    cap.uninstall();
    // After uninstall the listener is gone — no new entries.
    win.emit('error', { message: 'late' });
    expect(cap.getJsErrors()).toHaveLength(1);
  });

  it('captures unhandledrejection with a string reason', () => {
    const win = fakeWindow();
    const cap = new ConsoleCapture({ console: fakeConsole(), window: win });
    cap.install();
    win.emit('unhandledrejection', { reason: 'nope' });
    const [e] = cap.getJsErrors();
    expect(e.kind).toBe('unhandledrejection');
    expect(e.message).toBe('nope');
    cap.uninstall();
  });
});

describe('ConsoleCapture — snapshot budget', () => {
  it('bounds snapshots to <= MAX_SERIALIZED_BYTES by dropping oldest', () => {
    const console = fakeConsole();
    // A large per-buffer cap so the raw buffer (200 × ~500 chars ≈ 100 KB)
    // comfortably exceeds the 32 KB serialized budget and forces dropping.
    const cap = new ConsoleCapture({ console, window: fakeWindow(), maxEntries: 200 });
    cap.install();
    for (let i = 0; i < 200; i++) console.error('y'.repeat(MESSAGE_MAX));
    expect(cap.getConsoleLogs()).toHaveLength(200);
    const snap = cap.snapshot();
    const bytes = new TextEncoder().encode(JSON.stringify(snap)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_SERIALIZED_BYTES);
    // Some entries were dropped to fit the budget.
    expect(snap.consoleLogs.length).toBeLessThan(200);
    cap.uninstall();
  });

  it('install/uninstall are idempotent', () => {
    const console = fakeConsole();
    const cap = new ConsoleCapture({ console, window: fakeWindow() });
    cap.install();
    cap.install();
    cap.uninstall();
    cap.uninstall();
    expect(cap.getConsoleLogs()).toEqual([]);
  });
});

describe('scrubSecrets — structured secrets (F4)', () => {
  it.each([
    ['{"password":"hunter2"}', 'hunter2'],
    ['{"token": "abc.def-ghi"}', 'abc.def-ghi'],
    ["{'secret':'s3cr3t!'}", 's3cr3t!'],
    ['{"api_key":"k-12345"}', 'k-12345'],
    ['{"accessToken":"zzz999"}', 'zzz999'],
    ['body: {"user":"a","password":"p w d with space"}', 'p w d with space'],
    ['password: hunter2', 'hunter2'],
  ])('redacts JSON-style %s', (input, secret) => {
    const out = scrubSecrets(input, false);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('keeps JSON well-formed and non-secret keys intact', () => {
    const out = scrubSecrets('{"user":"bob","password":"x"}', false);
    expect(JSON.parse(out)).toEqual({ user: 'bob', password: '[REDACTED]' });
  });

  it('redacts Basic credentials but not the English word', () => {
    const b64 = Buffer.from('alice:s3cret').toString('base64');
    expect(scrubSecrets(`Authorization: Basic ${b64}`)).not.toContain(b64);
    expect(scrubSecrets('Basic configuration loaded')).toBe('Basic configuration loaded');
  });

  it.each(['pk_live_abcdef1234567890', 'sk_test_ABCDEF1234567890', 'pk_widget_0123456789abcdef'])(
    'redacts key %s',
    (key) => {
      expect(scrubSecrets(`using ${key} now`)).toBe('using [REDACTED] now');
    },
  );

  it('redacts Luhn-valid 13-19 digit card numbers (plain, spaced, dashed)', () => {
    expect(scrubSecrets('card 4111111111111111 x')).toBe('card [REDACTED] x');
    expect(scrubSecrets('card 4111 1111 1111 1111')).toBe('card [REDACTED]');
    expect(scrubSecrets('card 4111-1111-1111-1111')).toBe('card [REDACTED]');
    expect(scrubSecrets('amex 378282246310005')).toBe('amex [REDACTED]');
    expect(scrubSecrets('long 6011111111111117')).toBe('long [REDACTED]');
  });

  it('leaves Luhn-invalid digit runs and short numbers alone', () => {
    expect(scrubSecrets('id 4111111111111112')).toBe('id 4111111111111112');
    expect(scrubSecrets('order 123456789012')).toBe('order 123456789012');
    expect(scrubSecrets('status 200 in 35ms')).toBe('status 200 in 35ms');
  });
});
