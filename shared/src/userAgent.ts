// @pinpoint/shared — User-Agent parsing and browser-only Brave/Arc overrides.
//
// `parseUserAgent` is total: it never throws for any input string and always
// returns an object whose `browserFamily` and `osFamily` are members of their
// closed enums (Property 11, Requirements 17.1 and 17.2).
//
// The canonical `EnvironmentMetadata`, `BrowserFamily`, `OsFamily`, and
// `DeviceType` types live in `types.ts` (task 1.4); import them from
// `@pinpoint/shared` (or `./types.js` from inside this package).

import Bowser from 'bowser';
import type {
  BrowserFamily,
  DeviceType,
  EnvironmentMetadata,
  OsFamily,
} from './types.js';

// --- Bowser → closed-enum mappings ------------------------------------------

const BROWSER_MAP: Record<string, BrowserFamily> = {
  Chrome: 'Chrome',
  Chromium: 'Chrome',
  'Microsoft Edge': 'Edge',
  Safari: 'Safari',
  Firefox: 'Firefox',
  Opera: 'Opera',
};

const OS_MAP: Record<string, OsFamily> = {
  macOS: 'macOS',
  'OS X': 'macOS',
  Windows: 'Windows',
  Linux: 'Linux',
  iOS: 'iOS',
  Android: 'Android',
  'Chrome OS': 'ChromeOS',
};

// Sentinel returned on any parse failure (including empty input or thrown
// errors from Bowser). Cloned per call so callers cannot mutate the constant.
function unknownEnvironment(uaString: string): EnvironmentMetadata {
  return {
    browserFamily: 'unknown',
    browserVersion: null,
    osFamily: 'unknown',
    osVersion: null,
    deviceType: 'desktop',
    userAgentRaw: uaString,
  };
}

/**
 * Parse a raw User-Agent string into normalized `EnvironmentMetadata`.
 *
 * Total function: never throws. On parse failure (including empty strings or
 * malformed input that causes `Bowser.parse` to throw) returns an
 * `EnvironmentMetadata` with `browserFamily='unknown'`, `osFamily='unknown'`,
 * both versions `null`, `deviceType='desktop'`, and the original raw string.
 *
 * Validates Requirements 17.1, 17.2.
 */
export function parseUserAgent(uaString: string): EnvironmentMetadata {
  const raw = typeof uaString === 'string' ? uaString : '';

  let parsed: ReturnType<typeof Bowser.parse> | null = null;
  try {
    // Bowser throws on empty/non-string input; trap and fall through.
    if (raw.length > 0) {
      parsed = Bowser.parse(raw);
    }
  } catch {
    parsed = null;
  }

  if (!parsed) {
    return unknownEnvironment(raw);
  }

  const browserName = parsed.browser?.name ?? '';
  const osName = parsed.os?.name ?? '';
  const platformType = parsed.platform?.type ?? '';

  const browserFamily: BrowserFamily =
    BROWSER_MAP[browserName] ?? (browserName ? 'Other' : 'unknown');
  const osFamily: OsFamily = OS_MAP[osName] ?? (osName ? 'Other' : 'unknown');
  const deviceType: DeviceType =
    platformType === 'mobile' || platformType === 'tablet' ? platformType : 'desktop';

  return {
    browserFamily,
    browserVersion: parsed.browser?.version ?? null,
    osFamily,
    osVersion: parsed.os?.version ?? null,
    deviceType,
    userAgentRaw: raw,
  };
}

// --- Browser-only Brave / Arc overrides -------------------------------------

interface BraveNavigator {
  brave?: { isBrave?: () => Promise<boolean> };
}

/**
 * Apply browser-only overrides for Brave and Arc, which both masquerade as
 * Chrome in `navigator.userAgent`. Safe to call on the server: in the absence
 * of `navigator` / `getComputedStyle` / `document` it simply returns `meta`.
 *
 * Brave is detected via the non-standard `navigator.brave.isBrave()` async
 * predicate. Arc is detected via the `--arc-palette-background` CSS custom
 * property that Arc injects on the document root. When neither matches the
 * input is returned unchanged.
 */
export async function detectBraveAndArcOverrides(
  meta: EnvironmentMetadata,
): Promise<EnvironmentMetadata> {
  // Brave: async, returns boolean.
  const nav: BraveNavigator | undefined =
    typeof navigator !== 'undefined' ? (navigator as unknown as BraveNavigator) : undefined;
  try {
    if (nav?.brave?.isBrave && (await nav.brave.isBrave())) {
      return { ...meta, browserFamily: 'Brave' };
    }
  } catch {
    // Non-standard API; ignore failures and fall through to Arc detection.
  }

  // Arc: a CSS variable injected on Arc's :root; empty string elsewhere.
  if (
    typeof getComputedStyle === 'function' &&
    typeof document !== 'undefined' &&
    document.documentElement
  ) {
    try {
      const arcSig = getComputedStyle(document.documentElement)
        .getPropertyValue('--arc-palette-background')
        .trim();
      if (arcSig.length > 0) {
        return { ...meta, browserFamily: 'Arc' };
      }
    } catch {
      // Some hosts (very old jsdom, sandboxed iframes) throw here; ignore.
    }
  }

  return meta;
}
