/**
 * Per-host disclosure-seen persistence (Requirement 47.1, task 39.2).
 *
 * The Extension surfaces a one-time disclosure modal the first time the
 * popover opens on a host (task 39.1). Once the user clicks
 * "Acknowledge" we persist a boolean flag to `chrome.storage.sync`
 * keyed by host (`disclosure-seen-<host>`) so subsequent popover opens
 * on the same host skip straight to the dialog. The flag is reset
 * whenever the user toggles either capture preference on the options
 * page so users see the disclosure again with the updated data
 * categories.
 *
 * Storage shape (`chrome.storage.sync`):
 *
 *   {
 *     "disclosure-seen-app.example.com":  true,
 *     "disclosure-seen-other.test:8080":  true
 *   }
 *
 * All helpers gracefully no-op / return `false` when
 * `chrome.storage.sync` is unavailable (jsdom unit tests, the
 * dashboard, or any non-extension caller) so consumers do not have
 * to special-case the test environment.
 */

/**
 * Storage-key prefix shared with `<fl-popover>` (task 39.1). The full
 * key is `${STORAGE_KEY_PREFIX}${host}` where host is typically
 * `window.location.host` (host + port). Exported so `Popover.ts` and
 * the reset path can compute keys consistently and tests can assert
 * the layout without hard-coding the literal.
 */
export const STORAGE_KEY_PREFIX = 'disclosure-seen-';

/**
 * `chrome.storage.sync` is unavailable when this module is exercised
 * outside a Manifest V3 context (jsdom unit tests, the dashboard, the
 * options page when running standalone). The helpers degrade to a
 * noop / `false` response in that case so callers do not have to
 * special-case the test environment.
 */
function getSyncArea(): chrome.storage.StorageArea | null {
  const c = (globalThis as unknown as { chrome?: typeof chrome }).chrome;
  const area = c?.storage?.sync;
  if (!area || typeof area.get !== 'function' || typeof area.set !== 'function') {
    return null;
  }
  return area;
}

/**
 * Read the per-host disclosure-seen flag for `host` from
 * `chrome.storage.sync`. Returns `false` on missing slot, malformed
 * value, storage error, or when the storage area is unavailable so the
 * popover defaults to surfacing the disclosure on the first open of a
 * new host.
 */
export async function readDisclosureSeen(host: string): Promise<boolean> {
  if (typeof host !== 'string' || host.length === 0) return false;
  const area = getSyncArea();
  if (!area) return false;
  const key = `${STORAGE_KEY_PREFIX}${host}`;
  try {
    const got = await area.get(key);
    return Boolean((got as Record<string, unknown> | null | undefined)?.[key]);
  } catch {
    // Storage outage — surface as "not seen" so the user gets another
    // chance to acknowledge once the storage area recovers.
    return false;
  }
}

/**
 * Persist the per-host disclosure-seen flag for `host` to
 * `chrome.storage.sync`. Best-effort: empty hosts and storage outages
 * are silently swallowed because a failure here must never block the
 * popover from opening — the next mount will simply re-prompt.
 */
export async function writeDisclosureSeen(
  host: string,
  seen: boolean,
): Promise<void> {
  if (typeof host !== 'string' || host.length === 0) return;
  const area = getSyncArea();
  if (!area) return;
  const key = `${STORAGE_KEY_PREFIX}${host}`;
  try {
    await area.set({ [key]: Boolean(seen) });
  } catch {
    /* swallow — persistence failures must not break popover open flow */
  }
}

/**
 * Remove every `disclosure-seen-*` key from `chrome.storage.sync`.
 * Called from the options page after either capture toggle changes
 * (task 39.2) so users see the disclosure again with the updated
 * data categories on the next popover open per host. Unrelated keys
 * (`fl_allow_list`, `fl_block_list`, `pinPositionerOptOutHosts`, …)
 * are preserved.
 *
 * Best-effort: silently no-ops when `chrome.storage.sync` is
 * unavailable. When `chrome.storage.sync.remove` rejects on a
 * particular key the helper continues with the remaining keys so a
 * single transient failure does not block the rest of the reset.
 */
export async function resetAllDisclosureSeen(): Promise<void> {
  const area = getSyncArea();
  if (!area) return;
  // The `getBytesInUse` / `get(null)` overloads return every stored
  // entry; we filter to only the disclosure-seen-* keys so unrelated
  // settings stay put.
  let stored: Record<string, unknown> = {};
  try {
    const got = await area.get(null);
    if (got && typeof got === 'object' && !Array.isArray(got)) {
      stored = got as Record<string, unknown>;
    }
  } catch {
    return;
  }
  const keysToRemove = Object.keys(stored).filter((k) =>
    k.startsWith(STORAGE_KEY_PREFIX),
  );
  if (keysToRemove.length === 0) return;
  if (typeof area.remove !== 'function') return;
  try {
    await area.remove(keysToRemove);
  } catch {
    // Fall back to per-key removal so a single rejected slot does not
    // strand the rest of the disclosure-seen entries.
    for (const key of keysToRemove) {
      try {
        await area.remove(key);
      } catch {
        /* swallow */
      }
    }
  }
}
