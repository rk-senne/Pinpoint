"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.STORAGE_KEY_TOKEN = exports.STORAGE_KEY_CAPTURE_NETWORK = exports.STORAGE_KEY_CAPTURE_CONSOLE = exports.STORAGE_KEY_PIN_POSITIONER_OPT_OUT = exports.STORAGE_KEY_BLOCK_LIST = exports.STORAGE_KEY_ALLOW_LIST = void 0;
exports.parseList = parseList;
exports.serializeList = serializeList;
exports.performLogout = performLogout;
exports.initOptionsPage = initOptionsPage;
const api_1 = require("../src/lib/api");
const authTokenStore_1 = require("../src/lib/authTokenStore");
Object.defineProperty(exports, "STORAGE_KEY_TOKEN", { enumerable: true, get: function () { return authTokenStore_1.STORAGE_KEY_TOKEN; } });
const disclosureSeenStore_1 = require("../src/lib/disclosureSeenStore");
const PinPositioner_1 = require("../src/lib/PinPositioner");
exports.STORAGE_KEY_ALLOW_LIST = 'fl_allow_list';
exports.STORAGE_KEY_BLOCK_LIST = 'fl_block_list';
/**
 * Re-export the canonical PinPositioner opt-out storage key from
 * `src/lib/PinPositioner.ts` so existing imports of
 * `STORAGE_KEY_PIN_POSITIONER_OPT_OUT` from this module keep working
 * without a second source of truth (Req 51.3 / task 43.2). The
 * positioner reads the same key, watches it via
 * `chrome.storage.onChanged`, and tests `window.location.hostname`
 * against the persisted host patterns.
 */
exports.STORAGE_KEY_PIN_POSITIONER_OPT_OUT = PinPositioner_1.PIN_POSITIONER_OPT_OUT_STORAGE_KEY;
/**
 * Storage keys for the capture toggles persisted in `chrome.storage.local`.
 * Both default to `true` (capture enabled). The matching keys are read by
 * `CaptureBuffer` so flipping a toggle here gates console / network capture
 * on the next push (Req 36.4).
 */
exports.STORAGE_KEY_CAPTURE_CONSOLE = 'fl_capture_console_enabled';
exports.STORAGE_KEY_CAPTURE_NETWORK = 'fl_capture_network_enabled';
/**
 * Parse a textarea value into a list of host patterns. Splits on newlines,
 * trims whitespace, and drops empty lines.
 */
function parseList(raw) {
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
/** Serialize a list of host patterns into textarea content (one per line). */
function serializeList(patterns) {
    return patterns.join('\n');
}
function getElements(doc) {
    const allowList = doc.getElementById('allow-list');
    const blockList = doc.getElementById('block-list');
    const status = doc.getElementById('status');
    const captureConsoleRaw = doc.getElementById('capture-console');
    const captureNetworkRaw = doc.getElementById('capture-network');
    const pinPositionerOptOutRaw = doc.getElementById('pin-positioner-opt-out');
    if (!(allowList instanceof HTMLTextAreaElement) ||
        !(blockList instanceof HTMLTextAreaElement) ||
        !status) {
        throw new Error('options page: required elements missing');
    }
    return {
        allowList,
        blockList,
        status,
        pinPositionerOptOut: pinPositionerOptOutRaw instanceof HTMLTextAreaElement
            ? pinPositionerOptOutRaw
            : null,
        captureConsole: captureConsoleRaw instanceof HTMLInputElement ? captureConsoleRaw : null,
        captureNetwork: captureNetworkRaw instanceof HTMLInputElement ? captureNetworkRaw : null,
    };
}
function getAuthElements(doc) {
    const authState = doc.getElementById('auth-state');
    const logoutButtonRaw = doc.getElementById('logout-button');
    const authStatus = doc.getElementById('auth-status');
    return {
        authState,
        logoutButton: logoutButtonRaw instanceof HTMLButtonElement ? logoutButtonRaw : null,
        authStatus,
    };
}
async function loadFromStorage(els) {
    const stored = await chrome.storage.sync.get([
        exports.STORAGE_KEY_ALLOW_LIST,
        exports.STORAGE_KEY_BLOCK_LIST,
        exports.STORAGE_KEY_PIN_POSITIONER_OPT_OUT,
    ]);
    const allow = Array.isArray(stored[exports.STORAGE_KEY_ALLOW_LIST])
        ? stored[exports.STORAGE_KEY_ALLOW_LIST].filter((v) => typeof v === 'string')
        : [];
    const block = Array.isArray(stored[exports.STORAGE_KEY_BLOCK_LIST])
        ? stored[exports.STORAGE_KEY_BLOCK_LIST].filter((v) => typeof v === 'string')
        : [];
    const optOut = Array.isArray(stored[exports.STORAGE_KEY_PIN_POSITIONER_OPT_OUT])
        ? stored[exports.STORAGE_KEY_PIN_POSITIONER_OPT_OUT].filter((v) => typeof v === 'string')
        : [];
    els.allowList.value = serializeList(allow);
    els.blockList.value = serializeList(block);
    if (els.pinPositionerOptOut) {
        els.pinPositionerOptOut.value = serializeList(optOut);
    }
}
async function persistAllowList(value) {
    await chrome.storage.sync.set({
        [exports.STORAGE_KEY_ALLOW_LIST]: parseList(value),
    });
}
async function persistBlockList(value) {
    await chrome.storage.sync.set({
        [exports.STORAGE_KEY_BLOCK_LIST]: parseList(value),
    });
}
/**
 * Persist the parsed PinPositioner per-host opt-out list to
 * `chrome.storage.sync` (Req 51.3 / task 43.2). PinPositioner watches the
 * same key via `chrome.storage.onChanged` so changes apply live without a
 * page reload.
 */
async function persistPinPositionerOptOut(value) {
    await chrome.storage.sync.set({
        [exports.STORAGE_KEY_PIN_POSITIONER_OPT_OUT]: parseList(value),
    });
}
/**
 * Load the persisted capture toggles from `chrome.storage.local` and
 * apply them to the checkboxes. Missing keys default to `true` (capture
 * enabled), matching Req 36.4.
 */
async function loadCapturePrefs(els) {
    if (!els.captureConsole && !els.captureNetwork)
        return;
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
        if (els.captureConsole)
            els.captureConsole.checked = true;
        if (els.captureNetwork)
            els.captureNetwork.checked = true;
        return;
    }
    const stored = await chrome.storage.local.get([
        exports.STORAGE_KEY_CAPTURE_CONSOLE,
        exports.STORAGE_KEY_CAPTURE_NETWORK,
    ]);
    if (els.captureConsole) {
        const raw = stored[exports.STORAGE_KEY_CAPTURE_CONSOLE];
        els.captureConsole.checked = typeof raw === 'boolean' ? raw : true;
    }
    if (els.captureNetwork) {
        const raw = stored[exports.STORAGE_KEY_CAPTURE_NETWORK];
        els.captureNetwork.checked = typeof raw === 'boolean' ? raw : true;
    }
}
async function persistCapturePref(key, value) {
    if (typeof chrome === 'undefined' || !chrome.storage?.local)
        return;
    await chrome.storage.local.set({ [key]: value });
}
function flashStatus(els, message) {
    els.status.textContent = message;
    window.setTimeout(() => {
        if (els.status.textContent === message) {
            els.status.textContent = '';
        }
    }, 1500);
}
/** Read the stored bearer token via the canonical helper. */
const readStoredToken = authTokenStore_1.getStoredAuthToken;
/**
 * Render the auth section based on whether a token is currently stored.
 * Hides the logout button when signed out, shows it otherwise.
 */
function renderAuthSection(auth, signedIn) {
    if (auth.authState) {
        auth.authState.textContent = signedIn
            ? 'You are signed in to Pinpoint.'
            : 'You are signed out. Sign in via the extension popup.';
    }
    if (auth.logoutButton) {
        auth.logoutButton.hidden = !signedIn;
        auth.logoutButton.disabled = false;
    }
}
/**
 * Logout handler. Best-effort: call `POST /api/v1/auth/logout` (a failure
 * is tolerated — the user wants to be signed out either way), then drop
 * the bearer from `chrome.storage.local` and refresh the UI.
 */
async function performLogout(auth) {
    if (auth.logoutButton) {
        auth.logoutButton.disabled = true;
    }
    try {
        await (0, api_1.apiFetch)('/auth/logout', { method: 'POST' });
    }
    catch {
        // Swallow — logging out should always succeed locally even if the
        // server call fails (offline, expired token, etc.).
    }
    await (0, authTokenStore_1.clearStoredAuthToken)();
    renderAuthSection(auth, false);
    if (auth.authStatus) {
        const message = 'Signed out.';
        auth.authStatus.textContent = message;
        if (typeof window !== 'undefined') {
            window.setTimeout(() => {
                if (auth.authStatus && auth.authStatus.textContent === message) {
                    auth.authStatus.textContent = '';
                }
            }, 1500);
        }
    }
}
async function initAuthSection(doc) {
    const auth = getAuthElements(doc);
    // Auth section is optional — if the page omits it (e.g. older test
    // fixtures), skip wiring entirely.
    if (!auth.authState && !auth.logoutButton)
        return;
    const token = await readStoredToken();
    renderAuthSection(auth, token !== null);
    if (auth.logoutButton) {
        auth.logoutButton.addEventListener('click', () => {
            void performLogout(auth);
        });
    }
}
async function initOptionsPage(doc = document) {
    const els = getElements(doc);
    await loadFromStorage(els);
    await loadCapturePrefs(els);
    els.allowList.addEventListener('change', async () => {
        await persistAllowList(els.allowList.value);
        flashStatus(els, 'Allow-list saved.');
    });
    els.blockList.addEventListener('change', async () => {
        await persistBlockList(els.blockList.value);
        flashStatus(els, 'Block-list saved.');
    });
    if (els.pinPositionerOptOut) {
        els.pinPositionerOptOut.addEventListener('change', async () => {
            await persistPinPositionerOptOut(els.pinPositionerOptOut.value);
            flashStatus(els, 'Performance opt-out saved.');
        });
    }
    if (els.captureConsole) {
        els.captureConsole.addEventListener('change', async () => {
            await persistCapturePref(exports.STORAGE_KEY_CAPTURE_CONSOLE, els.captureConsole.checked);
            // Capture surface changed → reset every per-host disclosure-seen
            // flag so users see the disclosure again with the updated data
            // categories on the next popover open per host (Req 47.1, task
            // 39.2).
            await (0, disclosureSeenStore_1.resetAllDisclosureSeen)();
            flashStatus(els, 'Capture preferences saved.');
        });
    }
    if (els.captureNetwork) {
        els.captureNetwork.addEventListener('change', async () => {
            await persistCapturePref(exports.STORAGE_KEY_CAPTURE_NETWORK, els.captureNetwork.checked);
            // See above — flipping either capture toggle invalidates every
            // per-host disclosure-seen flag.
            await (0, disclosureSeenStore_1.resetAllDisclosureSeen)();
            flashStatus(els, 'Capture preferences saved.');
        });
    }
    await initAuthSection(doc);
}
// Bootstrap when loaded as a module in the options page.
if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            void initOptionsPage();
        });
    }
    else {
        void initOptionsPage();
    }
}
//# sourceMappingURL=options.js.map