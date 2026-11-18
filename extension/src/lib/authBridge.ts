/**
 * Content-script ↔ service-worker auth bridge (F8).
 *
 * Content scripts run next to untrusted host pages, so they must not read the
 * bearer straight out of `chrome.storage.local`. Instead:
 *
 *   - REST calls are relayed (`lib/apiRelay.ts`); the service worker attaches
 *     `Authorization` (and does the sliding-window refresh + 401 cleanup).
 *   - "Am I signed in?" checks use `PP_AUTH_STATUS`, which answers with a
 *     boolean only.
 *   - The collab Socket.IO handshake (which runs in the page's origin and
 *     cannot be relayed) obtains the token on demand via `PP_COLLAB_TOKEN`,
 *     held in memory only. This is the single, explicit token egress.
 *
 * The worker only answers messages whose `sender.id` is this extension and
 * that come from a tab (a content script), never from web pages.
 */

export const AUTH_STATUS_MESSAGE_TYPE = 'PP_AUTH_STATUS' as const;
export const COLLAB_TOKEN_MESSAGE_TYPE = 'PP_COLLAB_TOKEN' as const;

export interface AuthStatusResponse {
  authenticated: boolean;
}
export interface CollabTokenResponse {
  token: string | null;
}

export interface AuthBridgeDeps {
  /** This extension's id (`chrome.runtime.id`). */
  extensionId: string | undefined;
  /** Resolve the (refreshed-if-needed) bearer, or null when signed out. */
  getToken: () => Promise<string | null>;
}

/** Minimal view of `chrome.runtime.MessageSender`. */
export interface BridgeSender {
  id?: string;
  tab?: unknown;
}

/**
 * Service-worker side. Returns the response, or `undefined` when the message
 * is not an auth-bridge message / the sender is not trusted (the caller must
 * then not claim the message).
 */
export async function handleAuthBridgeMessage(
  message: unknown,
  sender: BridgeSender,
  deps: AuthBridgeDeps,
): Promise<AuthStatusResponse | CollabTokenResponse | undefined> {
  const type = (message as { type?: unknown } | null)?.type;
  if (type !== AUTH_STATUS_MESSAGE_TYPE && type !== COLLAB_TOKEN_MESSAGE_TYPE) {
    return undefined;
  }
  if (!deps.extensionId || sender.id !== deps.extensionId) {
    return type === AUTH_STATUS_MESSAGE_TYPE ? { authenticated: false } : { token: null };
  }
  const token = await deps.getToken();
  if (type === AUTH_STATUS_MESSAGE_TYPE) return { authenticated: token !== null };
  // Tokens leave the worker only to content scripts (a sender with a tab).
  return { token: sender.tab ? token : null };
}

function send<T>(message: { type: string }, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      resolve(fallback);
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response: T | undefined) => {
        if (chrome.runtime.lastError || response === undefined) {
          resolve(fallback);
          return;
        }
        resolve(response);
      });
    } catch {
      resolve(fallback);
    }
  });
}

/** Content-script side: boolean only. */
export async function queryAuthStatus(): Promise<boolean> {
  const res = await send<AuthStatusResponse>(
    { type: AUTH_STATUS_MESSAGE_TYPE },
    { authenticated: false },
  );
  return res.authenticated === true;
}

/** Content-script side: in-memory token for the collab socket handshake. */
export async function requestCollabToken(): Promise<string | null> {
  const res = await send<CollabTokenResponse>(
    { type: COLLAB_TOKEN_MESSAGE_TYPE },
    { token: null },
  );
  return typeof res.token === 'string' && res.token.length > 0 ? res.token : null;
}
