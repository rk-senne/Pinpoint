/**
 * Per-site allow/block list guard for the content script (Requirement
 * 46.2, 46.3 — tasks 38.2, 38.3).
 *
 * The Extension options page (task 38.1, Requirement 46.1) persists two
 * lists of host patterns to `chrome.storage.sync` under
 * `fl_allow_list` / `fl_block_list`. Pattern matching itself lives in
 * `./hostMatcher` (task 38.4, Requirement 46.4): exact hosts and
 * `*.example.com` wildcards.
 *
 * Decision rules (block-list wins, matching the hint text on the options
 * page and the precedence implied by Req 46.2):
 *
 *   1. Block-list non-empty AND host matches it → SKIP injection.
 *   2. Allow-list non-empty AND host does NOT match it → SKIP injection.
 *   3. Otherwise → INJECT.
 *
 * Storage failures (chrome.storage rejects, sync namespace unavailable,
 * etc.) deliberately default to "allow / inject" so a flaky storage
 * surface never prevents the overlay from mounting on otherwise-valid
 * pages.
 */

import { hostMatchesAny } from './hostMatcher';

/** `chrome.storage.sync` key for the allow-list (matches options page). */
export const STORAGE_KEY_ALLOW_LIST = 'fl_allow_list';
/** `chrome.storage.sync` key for the block-list (matches options page). */
export const STORAGE_KEY_BLOCK_LIST = 'fl_block_list';

export interface HostFilterLists {
  allow: string[];
  block: string[];
}

export type SkipReason = 'block-list' | 'allow-list';

export interface InjectionDecision {
  /** `true` when the content script should bail before any DOM work. */
  skip: boolean;
  /** Why we skipped — present only when `skip` is `true`. */
  reason?: SkipReason;
}

/**
 * Pure decision function — given a host and the persisted lists, returns
 * whether the content script should bail. No I/O, no storage, no DOM.
 *
 * Empty / whitespace-only entries in either list are dropped before the
 * "is the list non-empty" check so a textarea full of blank lines does
 * not lock the user out of every page.
 */
export function decideInjection(
  hostname: string,
  lists: HostFilterLists,
): InjectionDecision {
  const host = hostname.trim().toLowerCase();
  const allow = lists.allow.filter((p) => p.trim().length > 0);
  const block = lists.block.filter((p) => p.trim().length > 0);

  // Block-list takes precedence: a host listed in BOTH still gets blocked.
  if (block.length > 0 && hostMatchesAny(host, block)) {
    return { skip: true, reason: 'block-list' };
  }

  // Non-empty allow-list with no matching pattern → skip.
  if (allow.length > 0 && !hostMatchesAny(host, allow)) {
    return { skip: true, reason: 'allow-list' };
  }

  return { skip: false };
}

/**
 * Read the persisted allow/block lists from `chrome.storage.sync`.
 *
 * Missing keys, missing arrays, and non-string entries all collapse to
 * "empty list" rather than throwing, matching the resilient behaviour of
 * the options page itself. The returned promise rejects only when
 * `chrome.storage.sync.get` itself rejects — callers (notably
 * `shouldSkipInjection`) wrap this in try/catch and fall back to "allow".
 */
export async function readHostFilterLists(): Promise<HostFilterLists> {
  if (typeof chrome === 'undefined' || !chrome.storage?.sync) {
    return { allow: [], block: [] };
  }
  const stored = await chrome.storage.sync.get([
    STORAGE_KEY_ALLOW_LIST,
    STORAGE_KEY_BLOCK_LIST,
  ]);
  const allow = Array.isArray(stored?.[STORAGE_KEY_ALLOW_LIST])
    ? (stored[STORAGE_KEY_ALLOW_LIST] as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      )
    : [];
  const block = Array.isArray(stored?.[STORAGE_KEY_BLOCK_LIST])
    ? (stored[STORAGE_KEY_BLOCK_LIST] as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      )
    : [];
  return { allow, block };
}

/**
 * Read the current host name from `window.location.hostname`, trimmed
 * and lower-cased. Returns the empty string when `window.location` is
 * unavailable (e.g. unit tests without jsdom). The empty string never
 * matches a non-empty allow/block pattern, so callers fall through to
 * the default "inject" branch — which is the safe default.
 */
export function currentHostname(): string {
  if (typeof window === 'undefined' || !window.location) return '';
  const raw = window.location.hostname ?? '';
  return raw.trim().toLowerCase();
}

/**
 * Top-level guard for the content script. Returns `{ skip: true }` when
 * the content script must bail before mounting the overlay; otherwise
 * `{ skip: false }`. Storage failures default to "inject" (safe default
 * — a broken `chrome.storage.sync` must not silently disable the
 * extension on every page).
 */
export async function shouldSkipInjection(
  hostname: string = currentHostname(),
): Promise<InjectionDecision> {
  try {
    const lists = await readHostFilterLists();
    return decideInjection(hostname, lists);
  } catch {
    // Storage failure → default to "allow / inject".
    return { skip: false };
  }
}
