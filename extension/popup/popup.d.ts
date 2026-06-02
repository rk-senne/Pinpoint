/**
 * Popup login surface (Requirement 33.1, task 24.1).
 *
 * Single-screen email/password form that submits to `/api/v1/auth/login`
 * via the shared `apiFetch` wrapper, stores the returned Bearer_Token in
 * `chrome.storage.local` under `pinpoint_auth_token` (matching the
 * convention in `content.ts` and `lib/api.ts`), and surfaces server error
 * envelopes inline.
 *
 * After a successful login the popup:
 *   1. Broadcasts `chrome.runtime.sendMessage({ type: 'login-complete' })`
 *      so the service worker / open content scripts can refresh themselves
 *      against the new token (design.md "Popup login flow").
 *   2. Reloads the active tab in the current window so its content script
 *      re-mounts the overlay against the freshly-stored token, fulfilling
 *      "sends a runtime message to refresh active tabs after login" in
 *      task 24.1.
 *
 * The module exports `initPopup` (and helpers) for unit testing under
 * jsdom; when loaded as the popup page itself the bottom of this file
 * bootstraps it on `DOMContentLoaded`.
 */
/** Runtime message type the rest of the extension listens for. */
export declare const LOGIN_COMPLETE_MESSAGE: {
    readonly type: "login-complete";
};
/**
 * Wire the popup form. Exposed for jsdom-based unit tests; the page itself
 * calls this on `DOMContentLoaded` (see bottom of file).
 */
export declare function initPopup(doc?: Document): Promise<void>;
//# sourceMappingURL=popup.d.ts.map