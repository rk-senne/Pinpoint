/**
 * Centralised auth-token storage for the Pinpoint Extension.
 *
 * The Bearer_Token returned by `POST /api/v1/auth/login` is persisted in
 * `chrome.storage.local` under a single canonical key. Every caller in
 * the extension (popup, options page, content script, service worker,
 * `lib/api.ts`) reads and writes through the helpers exported here so the
 * key name appears in exactly one place.
 *
 * Each helper guards `chrome.storage.local` and degrades to a no-op /
 * `null` when the API is unavailable (e.g. unit tests that never stub
 * the `chrome` global). That mirrors the legacy duplicated implementations
 * the helpers replaced.
 */

/** Single source of truth for the auth-token key in `chrome.storage.local`. */
export const STORAGE_KEY_TOKEN = 'pinpoint_auth_token';

/**
 * Read the stored bearer token, or `null` when none is stored / the
 * extension storage API is unavailable (e.g. content-script tests that
 * did not stub `chrome`).
 */
export async function getStoredAuthToken(): Promise<string | null> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
  const result = await chrome.storage.local.get(STORAGE_KEY_TOKEN);
  const token = result?.[STORAGE_KEY_TOKEN];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Persist a freshly minted bearer token. No-op outside an extension
 * context so unit tests that import this module don't need to stub
 * `chrome.storage.local`.
 */
export async function setStoredAuthToken(token: string): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  await chrome.storage.local.set({ [STORAGE_KEY_TOKEN]: token });
}

/**
 * Remove the stored bearer from `chrome.storage.local`. Used by the
 * 401 cleanup path (Req 33.5) and by the options-page logout flow
 * (Req 33.2). No-op outside an extension context.
 */
export async function clearStoredAuthToken(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  await chrome.storage.local.remove(STORAGE_KEY_TOKEN);
}
