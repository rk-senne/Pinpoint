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

import { apiFetch } from '../src/lib/api';
import { setStoredAuthToken } from '../src/lib/authTokenStore';

/** Runtime message type the rest of the extension listens for. */
export const LOGIN_COMPLETE_MESSAGE = { type: 'login-complete' } as const;

interface LoginResponse {
  user: { id: string; email: string; name: string; createdAt: string };
  token: string;
  /** Dashboard CSRF token; the extension ignores it but the field exists. */
  csrfToken?: string;
}

interface PopupElements {
  form: HTMLFormElement;
  email: HTMLInputElement;
  password: HTMLInputElement;
  submit: HTMLButtonElement;
  error: HTMLElement;
}

function getElements(doc: Document): PopupElements {
  const form = doc.getElementById('popup-login-form');
  const email = doc.getElementById('popup-email');
  const password = doc.getElementById('popup-password');
  const submit = doc.getElementById('popup-submit');
  const error = doc.getElementById('popup-error');
  if (
    !(form instanceof HTMLFormElement) ||
    !(email instanceof HTMLInputElement) ||
    !(password instanceof HTMLInputElement) ||
    !(submit instanceof HTMLButtonElement) ||
    !(error instanceof HTMLElement)
  ) {
    throw new Error('popup: required elements missing');
  }
  return { form, email, password, submit, error };
}

function showError(els: PopupElements, message: string): void {
  els.error.textContent = message;
  els.error.hidden = false;
}

function clearError(els: PopupElements): void {
  els.error.textContent = '';
  els.error.hidden = true;
}

function setLoading(els: PopupElements, loading: boolean): void {
  els.submit.disabled = loading;
  els.submit.textContent = loading ? 'Signing in…' : 'Sign in';
}

/**
 * Persist the bearer token via the canonical helper so all extension
 * surfaces (content script, options, service worker, lib/api.ts) read
 * the same `pinpoint_auth_token` key.
 */
const storeAuthToken = setStoredAuthToken;

/**
 * Notify the rest of the extension that a fresh token is available, and
 * reload the active tab so its content script re-bootstraps against the
 * new token. Failures are swallowed — the user is already signed in even
 * if the broadcast or reload misbehaves.
 */
async function broadcastLoginAndRefreshActiveTab(): Promise<void> {
  if (typeof chrome === 'undefined') return;
  try {
    chrome.runtime?.sendMessage?.(LOGIN_COMPLETE_MESSAGE);
  } catch {
    // No receivers / disconnected port — non-fatal.
  }
  try {
    if (chrome.tabs?.query && chrome.tabs?.reload) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      for (const tab of tabs) {
        if (typeof tab.id === 'number') {
          await chrome.tabs.reload(tab.id);
        }
      }
    }
  } catch {
    // Permissions / no-active-tab — non-fatal.
  }
}

/**
 * Wire the popup form. Exposed for jsdom-based unit tests; the page itself
 * calls this on `DOMContentLoaded` (see bottom of file).
 */
export async function initPopup(doc: Document = document): Promise<void> {
  const els = getElements(doc);
  clearError(els);

  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError(els);

    const email = els.email.value.trim();
    const password = els.password.value;
    if (!email || !password) {
      showError(els, 'Please enter your email and password.');
      return;
    }

    setLoading(els, true);
    try {
      const data = await apiFetch<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      if (!data?.token) {
        showError(els, 'Login response was missing a token.');
        return;
      }
      await storeAuthToken(data.token);
      await broadcastLoginAndRefreshActiveTab();
      // Close the popup so the user lands back on the host page; the
      // active tab is already reloading against the new token. We swallow
      // failures because some host environments forbid programmatic close
      // (and jsdom in tests stubs this out).
      try {
        if (typeof window !== 'undefined' && typeof window.close === 'function') {
          window.close();
        }
      } catch {
        // non-fatal
      }
    } catch (err) {
      showError(
        els,
        err instanceof Error && err.message ? err.message : 'Sign in failed.',
      );
    } finally {
      setLoading(els, false);
    }
  });
}

// Bootstrap when loaded as the popup page.
if (typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      void initPopup();
    });
  } else {
    void initPopup();
  }
}
