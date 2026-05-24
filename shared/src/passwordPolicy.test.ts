import { describe, it, expect } from 'vitest';
import {
  PASSWORD_MIN_LENGTH,
  validatePassword,
  getCommonPasswordCount,
} from './passwordPolicy.js';

describe('validatePassword', () => {
  it('accepts a password that is long enough and not in the blocklist', () => {
    expect(validatePassword('correcthorsebatterystaple')).toEqual({ ok: true });
  });

  it('exposes a 10-character minimum-length floor (Req 1.10)', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
  });

  it('rejects passwords shorter than the minimum length', () => {
    const result = validatePassword('short9chr');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/at least 10 characters/i);
    }
  });

  it('rejects the empty string', () => {
    const result = validatePassword('');
    expect(result.ok).toBe(false);
  });

  it('rejects a password from the common-passwords blocklist (Req 1.11)', () => {
    // "qwertyuiop" is in the SecLists top-10k corpus and is exactly 10 chars long,
    // so it satisfies the length floor but MUST still be rejected by the blocklist.
    const result = validatePassword('qwertyuiop');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/too common/i);
    }
  });

  it('matches the blocklist case-insensitively', () => {
    expect(validatePassword('QwErTyUiOp').ok).toBe(false);
    expect(validatePassword('QWERTYUIOP').ok).toBe(false);
    expect(validatePassword('qwertyuiop').ok).toBe(false);
  });

  it('treats a 10-character password not in the blocklist as valid', () => {
    expect(validatePassword('Tr0ub4dor!9')).toEqual({ ok: true });
  });

  it('does not throw on non-string inputs', () => {
    // Defensive: callers should validate type, but we still want a graceful answer.
    const result = validatePassword(undefined as unknown as string);
    expect(result.ok).toBe(false);
  });

  it('loads exactly the expected number of common passwords', () => {
    // Sanity check that the bundled JSON file shipped with the package.
    expect(getCommonPasswordCount()).toBeGreaterThanOrEqual(9000);
    expect(getCommonPasswordCount()).toBeLessThanOrEqual(10000);
  });
});
