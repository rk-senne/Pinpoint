/**
 * Feature: pinpoint-app, Property 11: parseUserAgent is total
 *
 * For ANY input string (the empty string, garbage bytes, well-formed
 * real-world User-Agent strings, or arbitrary fast-check strings),
 * `parseUserAgent(s)` shall:
 *   1. Never throw an exception.
 *   2. Return an object whose shape satisfies `EnvironmentMetadataSchema`,
 *      which guarantees `browserFamily` and `osFamily` are members of their
 *      closed enums.
 *
 * **Validates: Requirements 17.1, 17.2**
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseUserAgent } from '../../userAgent.js';
import { EnvironmentMetadataSchema } from '../../schemas.js';

/**
 * Curated fixture list of real-world User-Agent strings spanning the major
 * browser/OS/device combinations the parser is expected to recognise, plus a
 * few intentionally degenerate inputs (empty, whitespace, garbage bytes).
 *
 * The property must hold for every entry: no throw, schema-conforming output.
 */
const REAL_WORLD_UAS: readonly string[] = [
  // --- Desktop, mainstream ---
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.2478.67',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0',
  // --- Mobile / tablet ---
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  // --- ChromeOS ---
  'Mozilla/5.0 (X11; CrOS x86_64 15633.69.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  // --- Brave / Arc (UA-indistinguishable from Chrome) ---
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  // --- Degenerate / adversarial ---
  '',
  ' ',
  '   \t\n  ',
  'not a user agent',
  '!@#$%^&*()_+-={}[]|\\:;"\'<>,.?/~`',
  '\u0000\u0001\u0002\uFFFD',
  'Mozilla/5.0', // truncated prefix
  'A'.repeat(4096), // pathologically long
];

/**
 * fast-check arbitrary that mixes:
 *   - fully arbitrary strings (`fc.string()` covers empty + garbage + unicode)
 *   - the curated real-world fixture list (`fc.constantFrom(...)`)
 * via `fc.oneof` so shrinking can land on either bucket.
 */
const arbUserAgent = fc.oneof(
  fc.string(),
  fc.constantFrom(...REAL_WORLD_UAS),
);

describe('Property 11: parseUserAgent is total (Requirements 17.1, 17.2)', () => {
  it('never throws and returns a value satisfying EnvironmentMetadataSchema for any input string', () => {
    fc.assert(
      fc.property(arbUserAgent, (ua) => {
        // Must not throw under any input (totality).
        const result = parseUserAgent(ua);

        // Schema validation enforces the closed BrowserFamily / OsFamily /
        // DeviceType enums plus the required field shape.
        const parsed = EnvironmentMetadataSchema.safeParse(result);
        expect(parsed.success).toBe(true);

        // Raw input must round-trip into userAgentRaw verbatim, so callers
        // can reproduce the original string from the persisted metadata.
        expect(result.userAgentRaw).toBe(ua);
      }),
      { numRuns: 500 },
    );
  });

  it('returns the documented sentinel shape for every degenerate / fixture input', () => {
    for (const ua of REAL_WORLD_UAS) {
      // Must not throw.
      const result = parseUserAgent(ua);
      // Always conforms to the schema.
      const parsed = EnvironmentMetadataSchema.safeParse(result);
      expect(parsed.success).toBe(true);
      // Raw is preserved verbatim.
      expect(result.userAgentRaw).toBe(ua);
    }
  });
});
