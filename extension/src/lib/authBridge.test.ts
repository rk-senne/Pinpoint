import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUTH_STATUS_MESSAGE_TYPE,
  COLLAB_TOKEN_MESSAGE_TYPE,
  handleAuthBridgeMessage,
  queryAuthStatus,
  requestCollabToken,
} from './authBridge';

const EXT = 'ext-id';
const deps = (token: string | null) => ({
  extensionId: EXT,
  getToken: vi.fn(async () => token),
});

afterEach(() => vi.unstubAllGlobals());

describe('handleAuthBridgeMessage (service-worker side)', () => {
  it('ignores unrelated messages (returns undefined, never reads the token)', async () => {
    const d = deps('tok');
    expect(await handleAuthBridgeMessage({ type: 'OTHER' }, { id: EXT, tab: {} }, d)).toBeUndefined();
    expect(await handleAuthBridgeMessage(null, { id: EXT }, d)).toBeUndefined();
    expect(d.getToken).not.toHaveBeenCalled();
  });

  it('PP_AUTH_STATUS answers a boolean only — never the token', async () => {
    const res = await handleAuthBridgeMessage(
      { type: AUTH_STATUS_MESSAGE_TYPE },
      { id: EXT, tab: {} },
      deps('secret-token'),
    );
    expect(res).toEqual({ authenticated: true });
    expect(JSON.stringify(res)).not.toContain('secret-token');
    expect(
      await handleAuthBridgeMessage({ type: AUTH_STATUS_MESSAGE_TYPE }, { id: EXT, tab: {} }, deps(null)),
    ).toEqual({ authenticated: false });
  });

  it('PP_COLLAB_TOKEN returns the token only to a content-script sender of this extension', async () => {
    const msg = { type: COLLAB_TOKEN_MESSAGE_TYPE };
    expect(await handleAuthBridgeMessage(msg, { id: EXT, tab: {} }, deps('tok'))).toEqual({ token: 'tok' });
    // Extension page without a tab (popup/options) is not a content script.
    expect(await handleAuthBridgeMessage(msg, { id: EXT }, deps('tok'))).toEqual({ token: null });
  });

  it('rejects senders from another extension / unknown id without reading the token', async () => {
    const d = deps('tok');
    expect(await handleAuthBridgeMessage({ type: COLLAB_TOKEN_MESSAGE_TYPE }, { id: 'other', tab: {} }, d)).toEqual({
      token: null,
    });
    expect(await handleAuthBridgeMessage({ type: AUTH_STATUS_MESSAGE_TYPE }, { tab: {} }, d)).toEqual({
      authenticated: false,
    });
    expect(d.getToken).not.toHaveBeenCalled();
  });
});

describe('content-script helpers', () => {
  function stubSend(response: unknown, lastError?: { message: string }) {
    const sendMessage = vi.fn((_m: unknown, cb: (r: unknown) => void) => cb(response));
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError } });
    return sendMessage;
  }

  it('queryAuthStatus sends PP_AUTH_STATUS and returns the boolean', async () => {
    const send = stubSend({ authenticated: true });
    expect(await queryAuthStatus()).toBe(true);
    expect(send.mock.calls[0]![0]).toEqual({ type: 'PP_AUTH_STATUS' });
  });

  it('queryAuthStatus is false on runtime errors / no chrome', async () => {
    stubSend(undefined, { message: 'no receiver' });
    expect(await queryAuthStatus()).toBe(false);
    vi.unstubAllGlobals();
    expect(await queryAuthStatus()).toBe(false);
  });

  it('requestCollabToken returns the token or null', async () => {
    stubSend({ token: 'abc' });
    expect(await requestCollabToken()).toBe('abc');
    stubSend({ token: null });
    expect(await requestCollabToken()).toBeNull();
    stubSend({ token: '' });
    expect(await requestCollabToken()).toBeNull();
  });
});
