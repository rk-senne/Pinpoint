/**
 * URL → Project mapping cache (Requirement 39.2, task 30.2).
 *
 * When `<fl-project-picker>` resolves a "no auto-detected project for this
 * URL" 404 by asking the user to pick a Project manually, we persist the
 * picked Project against the page's `urlKey` (= `origin + pathname`) so a
 * subsequent visit to the same URL can short-circuit the picker entirely
 * (task 30.3 reads this cache before falling back to `GET /api/v1/projects/by-url`).
 *
 * Storage shape (`chrome.storage.local`):
 *
 *   {
 *     "fl_project_mappings": {
 *       "https://example.com/dashboard": "<projectId>",
 *       "https://app.acme.test/inbox":   "<projectId>"
 *     }
 *   }
 *
 * The mapping is intentionally keyed by `origin + pathname` and ignores
 * the query string and hash. Two visits to the same logical page that
 * differ only by `?ref=…` or `#section` resolve to the same Project,
 * matching the design.md note in §"Project Picker Fallback":
 *
 *   > On every URL change the Extension consults the cache before
 *   > hitting `GET /by-url`; a cache hit short-circuits the picker.
 *
 * The module is deliberately decoupled from the Custom Element: the
 * picker calls `rememberProject` on selection (task 30.2) and the overlay
 * host (or content script) calls `lookupProject` on enable / SPA nav
 * (task 30.3). Both paths reach the same `chrome.storage.local` slot.
 */

/** `chrome.storage.local` key under which the mapping object is stored. */
export const PROJECT_MAPPING_STORAGE_KEY = 'fl_project_mappings';

/**
 * Subset of `window.Location` used for cache key derivation. Declaring an
 * explicit interface keeps the helper testable without a full `Location`
 * stub and lets the picker call it with `{ origin, pathname }` synthesised
 * from any source (e.g. SPA navigation events).
 */
export interface UrlLocation {
  readonly origin: string;
  readonly pathname: string;
}

/**
 * Cache key for a location. Concatenates `origin` + `pathname` so that
 * differing query strings or fragments collapse to a single mapping.
 *
 *   urlKey({ origin: 'https://x.test', pathname: '/p' }) === 'https://x.test/p'
 */
export function urlKey(loc: UrlLocation): string {
  const origin = typeof loc?.origin === 'string' ? loc.origin : '';
  const pathname = typeof loc?.pathname === 'string' ? loc.pathname : '';
  return `${origin}${pathname}`;
}

/**
 * `chrome.storage.local` is unavailable when the helper is exercised
 * outside a Manifest V3 context (e.g. plain Vitest / Node). All public
 * helpers degrade to a noop / null response in that case so callers do
 * not have to special-case the test environment.
 */
function getStorageArea(): chrome.storage.StorageArea | null {
  if (typeof chrome === 'undefined') return null;
  const local = chrome.storage?.local;
  return local ?? null;
}

/**
 * Read the current `urlKey → projectId` map from storage. Always returns
 * a fresh object the caller may mutate; corrupt or missing slots coerce
 * to an empty map.
 */
async function readMappings(): Promise<Record<string, string>> {
  const storage = getStorageArea();
  if (!storage) return {};
  const result = await storage.get(PROJECT_MAPPING_STORAGE_KEY);
  const raw = result?.[PROJECT_MAPPING_STORAGE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}

/**
 * Persist (or overwrite) the `urlKey(loc) → projectId` mapping in
 * `chrome.storage.local` under `fl_project_mappings`. Existing entries
 * for other URLs are preserved.
 */
export async function rememberProject(
  loc: UrlLocation,
  projectId: string,
): Promise<void> {
  if (typeof projectId !== 'string' || projectId.length === 0) return;
  const storage = getStorageArea();
  if (!storage) return;
  const mappings = await readMappings();
  mappings[urlKey(loc)] = projectId;
  await storage.set({ [PROJECT_MAPPING_STORAGE_KEY]: mappings });
}

/**
 * Return the Project previously remembered for this `urlKey`, or `null`
 * when the cache has no entry. Task 30.3 calls this on overlay enable
 * before falling back to `GET /api/v1/projects/by-url`.
 */
export async function lookupProject(loc: UrlLocation): Promise<string | null> {
  const mappings = await readMappings();
  const found = mappings[urlKey(loc)];
  return typeof found === 'string' && found.length > 0 ? found : null;
}
