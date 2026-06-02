/**
 * Options page controller — persists allow-list and block-list of host
 * patterns to `chrome.storage.sync` under `fl_allow_list` / `fl_block_list`,
 * a per-host PinPositioner opt-out list to `chrome.storage.sync` under
 * `pinPositionerOptOutHosts`, and provides a logout control that calls
 * `POST /api/v1/auth/logout` and clears the stored Bearer_Token from
 * `chrome.storage.local`.
 *
 * Requirement 46.1: The Extension options page provides an allow-list and a
 * block-list of host patterns.
 * Requirement 51.3 / Task 43.2: The Extension options page provides a
 * per-host opt-out toggle that disables PinPositioner's layout-driven
 * repositioning.
 * Requirement 33.2 / Task 24.2: The Extension provides an in-extension
 * logout surface that calls `POST /api/v1/auth/logout` and clears the
 * stored Bearer_Token.
 */
import { STORAGE_KEY_TOKEN } from '../src/lib/authTokenStore';
export declare const STORAGE_KEY_ALLOW_LIST = "fl_allow_list";
export declare const STORAGE_KEY_BLOCK_LIST = "fl_block_list";
/**
 * Re-export the canonical PinPositioner opt-out storage key from
 * `src/lib/PinPositioner.ts` so existing imports of
 * `STORAGE_KEY_PIN_POSITIONER_OPT_OUT` from this module keep working
 * without a second source of truth (Req 51.3 / task 43.2). The
 * positioner reads the same key, watches it via
 * `chrome.storage.onChanged`, and tests `window.location.hostname`
 * against the persisted host patterns.
 */
export declare const STORAGE_KEY_PIN_POSITIONER_OPT_OUT = "pinPositionerOptOutHosts";
/**
 * Storage keys for the capture toggles persisted in `chrome.storage.local`.
 * Both default to `true` (capture enabled). The matching keys are read by
 * `CaptureBuffer` so flipping a toggle here gates console / network capture
 * on the next push (Req 36.4).
 */
export declare const STORAGE_KEY_CAPTURE_CONSOLE = "fl_capture_console_enabled";
export declare const STORAGE_KEY_CAPTURE_NETWORK = "fl_capture_network_enabled";
export { STORAGE_KEY_TOKEN };
/**
 * Parse a textarea value into a list of host patterns. Splits on newlines,
 * trims whitespace, and drops empty lines.
 */
export declare function parseList(raw: string): string[];
/** Serialize a list of host patterns into textarea content (one per line). */
export declare function serializeList(patterns: string[]): string;
interface AuthElements {
    authState: HTMLElement | null;
    logoutButton: HTMLButtonElement | null;
    authStatus: HTMLElement | null;
}
/**
 * Logout handler. Best-effort: call `POST /api/v1/auth/logout` (a failure
 * is tolerated — the user wants to be signed out either way), then drop
 * the bearer from `chrome.storage.local` and refresh the UI.
 */
export declare function performLogout(auth: AuthElements): Promise<void>;
export declare function initOptionsPage(doc?: Document): Promise<void>;
//# sourceMappingURL=options.d.ts.map