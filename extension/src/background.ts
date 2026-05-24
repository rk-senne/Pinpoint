/**
 * Service worker (background.ts) — extension lifecycle and message routing.
 * Manifest V3 background script.
 *
 * Auth-token storage lives in `lib/authTokenStore.ts` so the popup,
 * options page, content script, `lib/api.ts`, and the service worker all
 * read/write the same `pinpoint_auth_token` key from a single
 * source. The service worker no longer mediates token reads/writes via
 * runtime messages — every surface goes through `chrome.storage.local`
 * directly via the helpers in `authTokenStore`.
 */

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

// Listen for extension icon click — toggle overlay via content script message.
// The fallback that re-injected `dist/content.js` via `chrome.scripting`
// was deleted: the manifest already declares `content_scripts.matches`,
// so the script auto-injects on every allow-listed page. Pages outside
// the allow-list (chrome://, about://, etc.) never had a content script
// to message in the first place — we just log and move on.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_OVERLAY' });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[pinpoint] toggle-overlay failed for tab ${tab.id}: ${reason}`,
    );
  }
});

// Listen for messages from content scripts. The Capture_Visible_Tab
// handler (Req 34.1) is the only message routed through the service
// worker today — auth-token reads/writes happen directly against
// `chrome.storage.local` via `lib/authTokenStore.ts` so the legacy
// `GET_AUTH_TOKEN` / `SET_AUTH_TOKEN` / `CLEAR_AUTH_TOKEN` handlers were
// removed. Returning `true` keeps the message channel open while the
// async capture resolves.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'CAPTURE_VISIBLE_TAB') {
    chrome.tabs
      .captureVisibleTab(undefined, { format: 'png' })
      .then((dataUrl) => sendResponse({ dataUrl }))
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        sendResponse({ dataUrl: null, error: reason });
      });
    return true;
  }
});
