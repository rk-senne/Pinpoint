// @vitest-environment jsdom
/**
 * widget consoleCapture.test.ts — Mission C2. The widget carries its own copy
 * of the capture module (no `@pinpoint/shared` dep); this verifies the same
 * guarantees: scrubbing, bounds, pass-through, and the 32 KB snapshot clamp.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConsoleCapture,
  MESSAGE_MAX,
  MAX_SERIALIZED_BYTES,
  scrubSecrets,
} from './consoleCapture';

function fakeConsole() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

afterEach(() => vi.restoreAllMocks());

describe('widget consoleCapture', () => {
  it('scrubs Bearer tokens, params, JWTs and emails', () => {
    expect(scrubSecrets('Bearer abc123')).not.toContain('abc123');
    expect(scrubSecrets('?api_key=xyz')).toContain('api_key=[REDACTED]');
    expect(scrubSecrets('eyJa.eyJb.sig')).toBe('[REDACTED]');
    expect(scrubSecrets('x@y.com')).not.toContain('x@y.com');
  });

  it('captures warn/error and passes through to the originals', () => {
    const console = fakeConsole();
    const errorSpy = console.error;
    const cap = new ConsoleCapture({ console });
    cap.install();
    console.error('kaboom');
    expect(errorSpy).toHaveBeenCalledWith('kaboom');
    expect(cap.getConsoleLogs()[0].level).toBe('error');
    cap.uninstall();
  });

  it('clamps snapshot to <= 32 KB', () => {
    const console = fakeConsole();
    const cap = new ConsoleCapture({ console });
    cap.install();
    for (let i = 0; i < 50; i++) console.error('z'.repeat(MESSAGE_MAX));
    const snap = cap.snapshot();
    const bytes = new TextEncoder().encode(JSON.stringify(snap)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_SERIALIZED_BYTES);
    cap.uninstall();
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
