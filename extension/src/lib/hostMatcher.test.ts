/**
 * Unit tests for `hostMatcher`.
 *
 * Validates Requirement 46.4: pattern matching for the allow-list /
 * block-list supports exact hosts and `*.example.com` wildcards.
 *
 * Includes a fast-check property test asserting the reflexive identity:
 * for any string `h`, `hostMatchesPattern(h, h)` is true (after trim).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { hostMatchesAny, hostMatchesPattern } from './hostMatcher';

describe('hostMatchesPattern', () => {
  describe('exact match', () => {
    it('matches when pattern equals host', () => {
      expect(hostMatchesPattern('example.com', 'example.com')).toBe(true);
    });

    it('does not match when pattern differs from host', () => {
      expect(hostMatchesPattern('example.com', 'example.org')).toBe(false);
      expect(hostMatchesPattern('app.example.com', 'example.com')).toBe(false);
    });

    it('does not match a suffix-only host against an exact pattern', () => {
      expect(hostMatchesPattern('notexample.com', 'example.com')).toBe(false);
    });
  });

  describe('wildcard `*.example.com`', () => {
    it('matches the apex domain `example.com`', () => {
      expect(hostMatchesPattern('example.com', '*.example.com')).toBe(true);
    });

    it('matches a single-level subdomain `app.example.com`', () => {
      expect(hostMatchesPattern('app.example.com', '*.example.com')).toBe(true);
    });

    it('matches a deep subdomain `a.b.example.com`', () => {
      expect(hostMatchesPattern('a.b.example.com', '*.example.com')).toBe(true);
    });

    it('does not match `notexample.com`', () => {
      expect(hostMatchesPattern('notexample.com', '*.example.com')).toBe(false);
    });

    it('does not match `example.org`', () => {
      expect(hostMatchesPattern('example.org', '*.example.com')).toBe(false);
    });

    it('does not match a host whose suffix only happens to end with the same chars without a dot boundary', () => {
      // `xexample.com` ends with `example.com` as a substring but not as a
      // dotted suffix, so the wildcard must NOT match.
      expect(hostMatchesPattern('xexample.com', '*.example.com')).toBe(false);
    });
  });

  describe('case-insensitivity', () => {
    it('treats hosts and patterns as case-insensitive', () => {
      expect(hostMatchesPattern('Example.COM', 'example.com')).toBe(true);
      expect(hostMatchesPattern('APP.Example.com', '*.EXAMPLE.com')).toBe(true);
    });
  });

  describe('whitespace handling', () => {
    it('trims surrounding whitespace from both inputs', () => {
      expect(hostMatchesPattern('  example.com  ', '\texample.com\n')).toBe(true);
      expect(hostMatchesPattern('app.example.com', '  *.example.com  ')).toBe(true);
    });
  });

  describe('empty patterns', () => {
    it('returns false for an empty pattern', () => {
      expect(hostMatchesPattern('example.com', '')).toBe(false);
    });

    it('returns false for a whitespace-only pattern', () => {
      expect(hostMatchesPattern('example.com', '   ')).toBe(false);
      expect(hostMatchesPattern('example.com', '\t\n')).toBe(false);
    });

    it('returns false for the bare `*.` pattern (no suffix)', () => {
      expect(hostMatchesPattern('example.com', '*.')).toBe(false);
    });
  });

  describe('no other wildcards supported', () => {
    it('does not treat mid-string `*` as a wildcard', () => {
      expect(hostMatchesPattern('app.example.com', 'app.*.com')).toBe(false);
    });

    it('does not treat trailing `*` as a wildcard', () => {
      expect(hostMatchesPattern('example.com', 'example.*')).toBe(false);
    });
  });
});

describe('hostMatchesAny', () => {
  it('returns true when any pattern matches', () => {
    expect(
      hostMatchesAny('app.example.com', ['example.org', '*.example.com', 'foo.bar'])
    ).toBe(true);
  });

  it('returns false when no pattern matches', () => {
    expect(
      hostMatchesAny('app.example.com', ['example.org', '*.bank.example.com'])
    ).toBe(false);
  });

  it('returns false for an empty list', () => {
    expect(hostMatchesAny('example.com', [])).toBe(false);
  });

  it('ignores empty / whitespace-only entries in the list', () => {
    expect(hostMatchesAny('example.com', ['', '   ', 'example.com'])).toBe(true);
    expect(hostMatchesAny('example.com', ['', '   '])).toBe(false);
  });
});

describe('hostMatchesPattern — property: reflexive identity', () => {
  it('hostMatchesPattern(h, h) === true for any non-empty trimmed host', () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 64 })
          // Drop strings that are empty after trim — those produce empty
          // patterns, which the spec explicitly defines as non-matching.
          .filter((s) => s.trim().length > 0),
        (h) => {
          expect(hostMatchesPattern(h, h)).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });
});
