/**
 * Service worker (background.ts) — extension lifecycle and message routing.
 * Manifest V3 background script.
 *
 * Auth-token storage lives in `lib/authTokenStore.ts` so the popup,
 * options page, content script, `lib/api.ts`, and the service worker all
 * read/write the same `pinpoint_auth_token` key from a single
 * source. Extension pages (popup/options) and the service worker use those
 * helpers directly. Content scripts do NOT read the token from storage (F8):
 * the relay below attaches the bearer (with sliding-window refresh and 401
 * cleanup) in the worker, and `lib/authBridge.ts` answers boolean auth-status
 * queries plus the collab-socket token handoff.
 *
 * NOTE: `chrome.storage.local` is intentionally left at its default access
 * level (TRUSTED_AND_UNTRUSTED_CONTEXTS). Restricting it to TRUSTED_CONTEXTS
 * would also lock content scripts out of the outbox, drafts, project mapping
 * and server-origin keys they legitimately use — see extension/README.md.
 */

import {
  RELAY_MESSAGE_TYPE,
  handleRelayRequest,
  type RelayRequest,
} from './lib/apiRelay';
import { API_BASE, resolveAuthTokenForRequest } from './lib/api';
import { clearStoredAuthToken } from './lib/authTokenStore';
import {
  AUTH_STATUS_MESSAGE_TYPE,
  COLLAB_TOKEN_MESSAGE_TYPE,
  handleAuthBridgeMessage,
} from './lib/authBridge';
import { resolveServerOrigin as resolveServerOriginAsync } from './lib/serverOrigin';
import {
  INSTALL_PAGE_CONSOLE_MESSAGE_TYPE,
  PAGE_CONSOLE_FLAG,
  installPageConsoleBridge,
} from './lib/pageConsoleBridge';

/**
 * Message the popup sends after a successful login (or a user "Open on
 * this page" gesture) so the service worker runs the same on-demand
 * injection + toggle path as an action click. The popup opening is the
 * `activeTab`-granting gesture, so injection into the active tab is
 * permitted even on a host the static `content_scripts` don't match.
 */
export const REQUEST_TOGGLE_MESSAGE_TYPE = 'PP_REQUEST_TOGGLE' as const;

// Listen for keyboard shortcuts declared in manifest.json's `commands` block
// (Req 40.1, task 31.2). Each named command (`toggle-sidebar`, `next-pin`,
// `prev-pin`) is forwarded to the active tab's content script as a
// `FL_COMMAND` message; the content script dispatches a window-scoped
// `pinpoint:command` CustomEvent that the toolbar/sidebar/popover
// components subscribe to.
//
// Note: `toggle-overlay` (Alt+Shift+F) is wired to the manifest's
// `_execute_action` command, so Chrome routes that shortcut through
// `chrome.action.onClicked` rather than `chrome.commands.onCommand`. The
// listener below only sees the other three.
if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    try {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!activeTab?.id) return;
      await chrome.tabs.sendMessage(activeTab.id, {
        type: 'FL_COMMAND',
        command,
      });
    } catch (error) {
      // Common case: the active tab is a chrome:// or about:// page where
      // the content script cannot run, so the message has no receiver.
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[pinpoint] failed to dispatch command "${command}": ${reason}`,
      );
    }
  });
}

// Listen for SPA navigations on the host page (Req 38.1, task 29.2). The
// content script's `historyPatch` only sees `pushState` / `replaceState` /
// `popstate` calls that originate from scripts running in its own frame.
// Some host pages mutate history before the content script is injected, or
// from frames where it never runs. `chrome.webNavigation.onHistoryStateUpdated`
// is the authoritative cross-frame signal: the service worker forwards the
// new URL to the active tab as `FL_LOCATION_CHANGE`, which the content
// script re-dispatches as `pinpoint:locationchange` so all subscribers
// (project resolution, overlay refresh) need only one event source.
if (chrome.webNavigation?.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    // Only react to the top frame; cross-frame nav is handled per-frame
    // by the content script's history patch.
    if (details.frameId !== 0) return;
    chrome.tabs
      .sendMessage(details.tabId, {
        type: 'FL_LOCATION_CHANGE',
        url: details.url,
      })
      .catch(() => {
        // chrome:// pages or no content script — ignore.
      });
  });
}

// Listen for extension icon click — toggle overlay via content script
// message, injecting the content script on demand when it isn't already
// present.
//
// The static `content_scripts` entry only matches localhost dev origins
// (least privilege — see manifest `optional_host_permissions`). On any
// other site the content script is NOT auto-injected; instead, clicking
// the action grants `activeTab` (temporary host access to the current tab),
// which permits `chrome.scripting.executeScript` into it. So the handler:
//   1. Tries to message the existing content script (`TOGGLE_OVERLAY`).
//   2. If there is no receiver, injects the built content-loader file for
//      the tab via `chrome.scripting.executeScript`, then re-sends
//      `TOGGLE_OVERLAY`.
//
// The built loader filename is discovered at runtime from
// `chrome.runtime.getManifest().content_scripts[0].js[0]` because CRXJS
// content-hashes it.
export async function handleActionClick(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_OVERLAY' });
    return;
  } catch {
    // No receiver — the content script isn't in this tab yet. Fall through
    // to on-demand injection below.
  }

  const loaderFile = resolveContentLoaderFile();
  if (!loaderFile) {
    console.warn(
      '[pinpoint] cannot resolve content-script loader file from manifest; ' +
        'on-demand injection skipped',
    );
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [loaderFile],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[pinpoint] on-demand content-script injection failed for tab ${tabId}: ${reason}`,
    );
    return;
  }

  // The freshly-injected content script registers its message listener
  // during module evaluation, but `executeScript` resolves once the file
  // starts executing — the listener may not be wired yet. Retry the toggle
  // a few times with a short backoff so the first click still opens the
  // overlay.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_OVERLAY' });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  console.warn(
    `[pinpoint] toggle-overlay never reached tab ${tabId} after injection`,
  );
}

/**
 * Resolve the built content-script entry file from the running manifest.
 * CRXJS content-hashes the emitted filename (e.g.
 * `assets/content-loader-ab12cd34.js`), so we read it at runtime rather
 * than hard-coding it. Returns `null` when the manifest has no content
 * script declared (shouldn't happen in a real build).
 */
export function resolveContentLoaderFile(): string | null {
  try {
    const manifest = chrome.runtime.getManifest();
    const scripts = manifest.content_scripts;
    const first = scripts?.[0]?.js?.[0];
    return typeof first === 'string' && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (typeof tab.id !== 'number') return;
  void handleActionClick(tab.id);
});

// Listen for messages from content scripts. Two handlers live here:
//   1. `PP_API_FETCH` — the content-script → service-worker API relay
//      (lib/apiRelay.ts). Content scripts run in the host page's origin, so
//      a direct `fetch` to the API is blocked by the host page's CORS
//      policy. The content script serialises the request and sends it here;
//      the service worker performs the fetch under the extension's host
//      permissions (not subject to the page's CORS), attaches the stored
//      bearer when the caller didn't, and returns a serialised response.
//   2. `CAPTURE_VISIBLE_TAB` (Req 34.1) — screenshot capture.
// Auth-token reads/writes otherwise happen directly against
// `chrome.storage.local` via `lib/authTokenStore.ts`.
// Returning `true` keeps the message channel open while the async work
// resolves.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === RELAY_MESSAGE_TYPE) {
    const relayReq = message as RelayRequest;
    handleRelayRequest(relayReq, {
      resolveOrigin: resolveServerOriginAsync,
      apiBase: API_BASE,
      // Refresh-aware: content scripts no longer do this themselves.
      authTokenProvider: resolveAuthTokenForRequest,
    })
      .then(async (response) => {
        // Req 33.5 (moved from the content script): a 401 on a real endpoint
        // drops the stored bearer. The refresh call handles its own failure.
        if (response.status === 401 && relayReq.path !== '/auth/refresh') {
          await clearStoredAuthToken().catch(() => undefined);
        }
        sendResponse(response);
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        sendResponse({
          ok: false,
          status: 0,
          statusText: '',
          headers: {},
          bodyText: '',
          networkError: reason,
        });
      });
    return true;
  }

  if (message?.type === AUTH_STATUS_MESSAGE_TYPE || message?.type === COLLAB_TOKEN_MESSAGE_TYPE) {
    handleAuthBridgeMessage(message, _sender, {
      extensionId: chrome.runtime.id,
      getToken: resolveAuthTokenForRequest,
    })
      .then((response) => sendResponse(response))
      .catch(() =>
        sendResponse(message.type === AUTH_STATUS_MESSAGE_TYPE ? { authenticated: false } : { token: null }),
      );
    return true;
  }

  // Host-page diagnostics bridge: inject the self-contained console/error
  // forwarder into the SENDER frame's MAIN world (lib/pageConsoleBridge.ts).
  // Uses the same host grant that let the content script run there.
  if (message?.type === INSTALL_PAGE_CONSOLE_MESSAGE_TYPE) {
    const tabId = _sender.tab?.id;
    if (typeof tabId !== 'number' || !chrome.scripting?.executeScript) {
      sendResponse({ ok: false });
      return false;
    }
    chrome.scripting
      .executeScript({
        target: { tabId, frameIds: [_sender.frameId ?? 0] },
        world: 'MAIN',
        func: installPageConsoleBridge,
        args: [PAGE_CONSOLE_FLAG],
      })
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        sendResponse({ ok: false, error: reason });
      });
    return true;
  }

  if (message?.type === 'CAPTURE_VISIBLE_TAB') {
    chrome.tabs
      .captureVisibleTab({ format: 'png' })
      .then((dataUrl) => sendResponse({ dataUrl }))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        sendResponse({ dataUrl: null, error: reason });
      });
    return true;
  }

  // Popup-driven toggle (post-login or "Open on this page"). The popup
  // resolves the active tab and forwards its id so the SW injects on
  // demand and toggles the overlay. Carries the `activeTab` grant from the
  // popup's action gesture.
  if (message?.type === REQUEST_TOGGLE_MESSAGE_TYPE) {
    const tabId = (message as { tabId?: unknown }).tabId;
    if (typeof tabId === 'number') {
      handleActionClick(tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => {
          const reason =
            error instanceof Error ? error.message : String(error);
          sendResponse({ ok: false, error: reason });
        });
      return true;
    }
    sendResponse({ ok: false, error: 'missing tabId' });
    return false;
  }
});
