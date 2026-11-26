import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onShortcut, registerShortcutListeners } from './keyboardShortcuts';

type CommandListener = (command: string) => Promise<void>;
type MessageListener = (msg: unknown) => void;

let commandListener: CommandListener;
let messageListener: MessageListener;
const sendMessage = vi.fn();
const query = vi.fn();

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue(undefined);
  query.mockReset().mockResolvedValue([{ id: 42 }]);
  vi.stubGlobal('chrome', {
    commands: { onCommand: { addListener: (l: CommandListener) => { commandListener = l; } } },
    tabs: { query, sendMessage },
    runtime: { onMessage: { addListener: (l: MessageListener) => { messageListener = l; } } },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('registerShortcutListeners (background)', () => {
  it.each(['toggle-sidebar', 'next-pin', 'prev-pin'])('forwards %s to the active tab', async (command) => {
    registerShortcutListeners();
    await commandListener(command);
    expect(query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(sendMessage).toHaveBeenCalledWith(42, { type: 'pinpoint:command', command });
  });

  it('ignores commands handled by Chrome itself (_execute_action) and unknown ones', async () => {
    registerShortcutListeners();
    await commandListener('_execute_action');
    await commandListener('nonsense');
    expect(query).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does nothing without an active tab id and swallows a missing content script', async () => {
    registerShortcutListeners();
    query.mockResolvedValueOnce([{}]);
    await commandListener('next-pin');
    expect(sendMessage).not.toHaveBeenCalled();
    sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist'));
    await expect(commandListener('next-pin')).resolves.toBeUndefined();
  });
});

describe('onShortcut (content script)', () => {
  it('invokes only the handler matching a pinpoint:command message', () => {
    const next = vi.fn(); const toggle = vi.fn();
    onShortcut({ 'next-pin': next, 'toggle-sidebar': toggle });
    messageListener({ type: 'pinpoint:command', command: 'next-pin' });
    messageListener({ type: 'other', command: 'toggle-sidebar' });
    messageListener({ type: 'pinpoint:command', command: 'prev-pin' });
    messageListener(undefined);
    expect(next).toHaveBeenCalledTimes(1);
    expect(toggle).not.toHaveBeenCalled();
  });
});
