/**
 * Unit tests for the background service worker (background.ts).
 *
 * Focuses on the message handlers registered with
 * `chrome.runtime.onMessage`. The service worker module registers its
 * listeners as a side-effect of being imported, so each test resets the
 * module cache and rebuilds a fresh `chrome` stub before importing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | void;

type WebNavigationListener = (details: {
  frameId: number;
  tabId: number;
  url: string;
}) => void;

type ActionClickListener = (tab: { id?: number }) => void | Promise<void>;

interface ChromeStub {
  runtime: { onMessage: { addListener: (listener: MessageListener) => void } };
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (entries: Record<string, unknown>) => Promise<void>;
      remove: (key: string) => Promise<void>;
    };
  };
  tabs: {
    sendMessage: ReturnType<typeof vi.fn>;
    captureVisibleTab: ReturnType<typeof vi.fn>;
  };
  action: { onClicked: { addListener: (listener: ActionClickListener) => void } };
  webNavigation: {
    onHistoryStateUpdated: {
      addListener: (listener: WebNavigationListener) => void;
    };
  };
  commands?: { onCommand: { addListener: (cb: unknown) => void } };
}

let messageListener: MessageListener | null = null;
let webNavigationListener: WebNavigationListener | null = null;
let actionClickListener: ActionClickListener | null = null;
let chromeStub: ChromeStub;

function buildChromeStub(
  captureVisibleTab: ReturnType<typeof vi.fn>,
  tabsSendMessage: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
): ChromeStub {
  return {
    runtime: {
      onMessage: {
        addListener: (listener) => {
          messageListener = listener;
        },
      },
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      sendMessage: tabsSendMessage,
      captureVisibleTab,
    },
    action: {
      onClicked: {
        addListener: (listener) => {
          actionClickListener = listener;
        },
      },
    },
    webNavigation: {
      onHistoryStateUpdated: {
        addListener: (listener) => {
          webNavigationListener = listener;
        },
      },
    },
  };
}

async function loadBackgroundWith(
  captureVisibleTab: ReturnType<typeof vi.fn>,
  tabsSendMessage?: ReturnType<typeof vi.fn>,
): Promise<void> {
  messageListener = null;
  webNavigationListener = null;
  actionClickListener = null;
  chromeStub = buildChromeStub(captureVisibleTab, tabsSendMessage);
  vi.stubGlobal('chrome', chromeStub);
  vi.resetModules();
  await import('./background.js');
}

describe('background service worker — CAPTURE_VISIBLE_TAB handler', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    messageListener = null;
    webNavigationListener = null;
    actionClickListener = null;
  });

  it('returns true to keep the response channel open for the async capture', async () => {
    const capture = vi.fn().mockResolvedValue('data:image/png;base64,AAAA');
    await loadBackgroundWith(capture);

    expect(messageListener).not.toBeNull();
    const sendResponse = vi.fn();
    const result = messageListener!(
      { type: 'CAPTURE_VISIBLE_TAB' },
      {},
      sendResponse,
    );
    expect(result).toBe(true);
  });

  it('calls chrome.tabs.captureVisibleTab with format png and replies with the dataURL', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    const capture = vi.fn().mockResolvedValue(dataUrl);
    await loadBackgroundWith(capture);

    const sendResponse = vi.fn();
    messageListener!({ type: 'CAPTURE_VISIBLE_TAB' }, {}, sendResponse);

    // Wait for the captureVisibleTab promise chain to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith({ format: 'png' });
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ dataUrl });
  });

  it('reports a null dataUrl with an error message when capture rejects', async () => {
    const capture = vi.fn().mockRejectedValue(new Error('no active tab'));
    await loadBackgroundWith(capture);

    const sendResponse = vi.fn();
    messageListener!({ type: 'CAPTURE_VISIBLE_TAB' }, {}, sendResponse);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({
      dataUrl: null,
      error: 'no active tab',
    });
  });

  it('ignores unrelated message types so other handlers can take over', async () => {
    const capture = vi.fn();
    await loadBackgroundWith(capture);

    const sendResponse = vi.fn();
    const result = messageListener!(
      { type: 'SOME_OTHER_TYPE' },
      {},
      sendResponse,
    );

    // The handler returns nothing for unknown types, leaving room for
    // other listeners to respond synchronously.
    expect(result).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('background service worker — webNavigation.onHistoryStateUpdated', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    messageListener = null;
    webNavigationListener = null;
    actionClickListener = null;
  });

  it('forwards a top-frame navigation to the active tab as FL_LOCATION_CHANGE', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await loadBackgroundWith(vi.fn(), sendMessage);

    expect(webNavigationListener).not.toBeNull();
    webNavigationListener!({
      frameId: 0,
      tabId: 42,
      url: 'https://example.com/spa/route',
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(42, {
      type: 'FL_LOCATION_CHANGE',
      url: 'https://example.com/spa/route',
    });
  });

  it('skips sub-frame navigations (frameId !== 0)', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await loadBackgroundWith(vi.fn(), sendMessage);

    expect(webNavigationListener).not.toBeNull();
    webNavigationListener!({
      frameId: 7,
      tabId: 42,
      url: 'https://example.com/iframe/route',
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('swallows sendMessage rejections (chrome:// pages or no content script)', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValue(new Error('Could not establish connection'));
    await loadBackgroundWith(vi.fn(), sendMessage);

    expect(webNavigationListener).not.toBeNull();
    expect(() =>
      webNavigationListener!({
        frameId: 0,
        tabId: 9,
        url: 'chrome://newtab/',
      }),
    ).not.toThrow();

    // Allow the rejected promise's `.catch()` to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('background service worker — action.onClicked handler', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    messageListener = null;
    webNavigationListener = null;
    actionClickListener = null;
  });

  it('forwards a TOGGLE_OVERLAY message to the clicked tab', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await loadBackgroundWith(vi.fn(), sendMessage);

    expect(actionClickListener).not.toBeNull();
    await actionClickListener!({ id: 17 });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(17, { type: 'TOGGLE_OVERLAY' });
  });

  it('skips message dispatch when the tab id is missing', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await loadBackgroundWith(vi.fn(), sendMessage);

    await actionClickListener!({});

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('logs and swallows sendMessage failures (no scripting fallback)', async () => {
    // Regression test for task 8: the previous fallback called
    // `chrome.scripting.executeScript({ files: ['dist/content.js'] })`
    // which failed because vite hashes the bundled name. The fallback
    // is gone — the manifest's `content_scripts.matches` already
    // auto-injects the content script. On send failure we just log and
    // return.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sendMessage = vi
      .fn()
      .mockRejectedValue(new Error('Could not establish connection'));
    await loadBackgroundWith(vi.fn(), sendMessage);

    await expect(actionClickListener!({ id: 23 })).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('background service worker — chrome.commands.onCommand', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    messageListener = null;
    webNavigationListener = null;
    actionClickListener = null;
  });

  it('does not throw when the chrome.commands API is missing', async () => {
    // The service worker only registers the listener when
    // `chrome.commands?.onCommand` is present, so a stub omitting
    // `commands` must still load cleanly.
    await expect(loadBackgroundWith(vi.fn())).resolves.toBeUndefined();
  });
});
