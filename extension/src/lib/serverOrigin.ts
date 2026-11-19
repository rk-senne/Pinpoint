/**
 * Server-origin resolution for the Pinpoint Extension.
 *
 * The API origin is resolved with the following precedence (highest first):
 *
 *   1. **User setting** — `pinpoint_api_origin` in `chrome.storage.local`,
 *      set from the options page ("Server URL"). This lets a user point a
 *      single installed build at their own deployment without a rebuild.
 *   2. **Build-time default** — `VITE_PINPOINT_API_ORIGIN`, injected by Vite
 *      `define` as the compile-time global `__PINPOINT_API_ORIGIN__`. Lets a
 *      packaged build ship with the correct production origin baked in.
 *   3. **Hard default** — `http://localhost:3001` for local dev.
 *
 * Content scripts cannot use relative URLs (they run on arbitrary host
 * pages), and the service worker performs the actual relayed fetches, so
 * every network surface in the extension funnels through this resolver.
 *
 * Reads are cached in-memory after the first successful storage read and
 * invalidated via a `chrome.storage.onChanged` listener, so the hot path
 * (`resolveServerOriginSync`) is synchronous for callers that already
 * primed the cache (e.g. `OverlayHost`'s field initialiser). The async
 * variant (`resolveServerOrigin`) always consults storage first.
 */

/** `chrome.storage.local` key holding the user-configured API origin. */
export const STORAGE_KEY_API_ORIGIN = 'pinpoint_api_origin';

/** Hard-coded fallback origin for local development. */
export const DEFAULT_API_ORIGIN = 'http://localhost:3001';

/**
 * Build-time origin injected by Vite `define`. When the build sets
 * `VITE_PINPOINT_API_ORIGIN`, `vite.config.ts` replaces every reference to
 * `__PINPOINT_API_ORIGIN__` with the string literal. Unset builds leave the
 * global `undefined` and fall through to {@link DEFAULT_API_ORIGIN}.
 */
export function buildTimeOrigin(): string | null {
  const override = (globalThis as { __PINPOINT_API_ORIGIN__?: string })
    .__PINPOINT_API_ORIGIN__;
  if (typeof override === 'string' && override.length > 0) {
    // Re-validate: a bad build-time value must never become the API origin.
    return validateServerUrl(override);
  }
  return null;
}

/**
 * Validate a user-supplied server URL. Accepts only:
 *   - `https://<host>[:port]` (any https host), OR
 *   - `http://localhost[:port]` / `http://127.0.0.1[:port]` / `http://[::1]`
 *     (loopback plaintext for local dev).
 *
 * Plain `http://` to a non-loopback host is rejected: credentialed API
 * traffic over cleartext to a remote host is unsafe, and the browser would
 * block mixed content on an https page anyway. Returns the normalised
 * origin (scheme + host + port, no trailing slash/path) on success, or
 * `null` when the input is not an acceptable server URL.
 */
export function validateServerUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]';
  if (url.protocol === 'https:') {
    // Any https host is acceptable.
  } else if (url.protocol === 'http:') {
    if (!isLoopback) return null;
  } else {
    return null;
  }
  return url.origin;
}

/** In-memory cache of the resolved origin. `undefined` = not yet read. */
let cachedOrigin: string | undefined;
let changeListenerInstalled = false;

/**
 * Install a `chrome.storage.onChanged` listener (once) that invalidates the
 * in-memory cache when the user changes the server URL on the options page.
 * No-op outside an extension context.
 */
function ensureChangeListener(): void {
  if (changeListenerInstalled) return;
  if (
    typeof chrome === 'undefined' ||
    !chrome.storage?.onChanged?.addListener
  ) {
    return;
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (STORAGE_KEY_API_ORIGIN in changes) {
      const next = changes[STORAGE_KEY_API_ORIGIN].newValue;
      cachedOrigin =
        (typeof next === 'string' ? validateServerUrl(next) : null) ??
        buildTimeOrigin() ??
        DEFAULT_API_ORIGIN;
    }
  });
  changeListenerInstalled = true;
}

/**
 * Resolve the API origin, consulting `chrome.storage.local` first. Caches
 * the result so subsequent `resolveServerOriginSync` reads are hot. Falls
 * back to the build-time origin, then the hard default, when no user
 * setting exists or storage is unavailable (unit tests without a `chrome`
 * stub).
 */
export async function resolveServerOrigin(): Promise<string> {
  ensureChangeListener();
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY_API_ORIGIN);
      const value = stored?.[STORAGE_KEY_API_ORIGIN];
      // Re-validate on every read: storage may have been written by an older
      // build, another extension context, or tampering. An invalid stored
      // value falls through to the build-time / default origin.
      const valid = typeof value === 'string' ? validateServerUrl(value) : null;
      if (valid !== null) {
        cachedOrigin = valid;
        return valid;
      }
    } catch {
      // Storage failure — fall through to build-time / default.
    }
  }
  const resolved = buildTimeOrigin() ?? DEFAULT_API_ORIGIN;
  cachedOrigin = resolved;
  return resolved;
}

/**
 * Synchronous best-effort resolver for callers that cannot await (e.g. a
 * class field initialiser). Returns the cached value when primed, otherwise
 * the build-time origin / hard default. Callers that need the user setting
 * must prime the cache first via {@link resolveServerOrigin} (or
 * {@link primeServerOrigin}).
 */
export function resolveServerOriginSync(): string {
  if (cachedOrigin !== undefined) return cachedOrigin;
  return buildTimeOrigin() ?? DEFAULT_API_ORIGIN;
}

/** Prime the in-memory cache. Call once at bootstrap. Returns the origin. */
export async function primeServerOrigin(): Promise<string> {
  return resolveServerOrigin();
}

/**
 * Persist a user-configured server URL to `chrome.storage.local` after
 * validating it. Returns the normalised origin on success or `null` when
 * the URL is rejected. The `chrome.storage.onChanged` listener updates the
 * in-memory cache; we also set it eagerly so the current context sees the
 * change without waiting for the event.
 */
export async function setServerOrigin(raw: string): Promise<string | null> {
  const normalised = validateServerUrl(raw);
  if (normalised === null) return null;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY_API_ORIGIN]: normalised });
  }
  cachedOrigin = normalised;
  return normalised;
}

/** Test-only cache reset so specs start from a clean slate. */
export function __resetServerOriginCacheForTests(): void {
  cachedOrigin = undefined;
  changeListenerInstalled = false;
}
