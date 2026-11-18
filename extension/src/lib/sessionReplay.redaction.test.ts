// @vitest-environment jsdom
/**
 * sessionReplay.redaction.test.ts — Mission C3. Verifies that captured input
 * values are redaction-applied before they can land in the replay buffer:
 * password / credit-card / opt-in fields are fully masked, and remaining
 * text is scrubbed of Bearer tokens / JWTs / sensitive params.
 */

import { describe, expect, it } from 'vitest';

import { redactInputValue } from './sessionReplay';

function input(attrs: Record<string, string>, value: string): HTMLInputElement {
  const el = document.createElement('input');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.value = value;
  document.body.appendChild(el);
  return el;
}

describe('redactInputValue', () => {
  it('fully masks password fields', () => {
    expect(redactInputValue(input({ type: 'password' }, 'hunter2'))).toBe('[REDACTED]');
  });

  it('fully masks credit-card autofill fields', () => {
    expect(redactInputValue(input({ autocomplete: 'cc-number' }, '4111111111111111'))).toBe(
      '[REDACTED]',
    );
  });

  it('masks fields under a data-fl-redact opt-in', () => {
    const el = input({ 'data-fl-redact': '' }, 'sensitive');
    expect(redactInputValue(el)).toBe('[REDACTED]');
  });

  it('scrubs secrets from ordinary text values', () => {
    const out = redactInputValue(input({ type: 'text' }, 'Bearer abc.def-123'));
    expect(out).not.toContain('abc.def-123');
    expect(out).toContain('[REDACTED]');
  });

  it('passes through benign values (truncated to 100 chars)', () => {
    expect(redactInputValue(input({ type: 'text' }, 'hello world'))).toBe('hello world');
    expect(redactInputValue(input({ type: 'text' }, 'x'.repeat(200))).length).toBe(100);
  });

  it('is null-safe', () => {
    expect(redactInputValue(null)).toBe('');
  });
});
