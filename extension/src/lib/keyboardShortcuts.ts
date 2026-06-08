/**
 * KeyboardShortcuts — handles Chrome extension commands declared in
 * manifest.json and dispatches them to the active tab's content script.
 *
 * Call `registerShortcutListeners()` from the background service worker.
 */

type ShortcutCommand = 'toggle-sidebar' | 'next-pin' | 'prev-pin';

const CONTENT_SCRIPT_COMMANDS: ShortcutCommand[] = [
  'toggle-sidebar',
  'next-pin',
  'prev-pin',
];

/**
 * Register the `chrome.commands.onCommand` listener. Sends a message to
 * the active tab so the content script can respond (e.g., cycle pins,
 * toggle sidebar). `_execute_action` is handled automatically by Chrome
 * to trigger the popup/action.
 */
export function registerShortcutListeners(): void {
  chrome.commands.onCommand.addListener(async (command) => {
    if (!CONTENT_SCRIPT_COMMANDS.includes(command as ShortcutCommand)) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    chrome.tabs.sendMessage(tab.id, { type: 'pinpoint:command', command }).catch(() => {
      // Content script not injected on this page — ignore silently.
    });
  });
}

/**
 * Content-script side: listen for commands forwarded from the background.
 * Call this in content.ts.
 *
 * @param handlers Map of command name to handler function.
 */
export function onShortcut(handlers: Partial<Record<ShortcutCommand, () => void>>): void {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'pinpoint:command') return;
    const handler = handlers[msg.command as ShortcutCommand];
    if (handler) handler();
  });
}
