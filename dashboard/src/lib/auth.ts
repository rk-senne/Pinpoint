/**
 * Dashboard authentication state — Task 7.4 / Requirements 18.1, 18.2, 18.4.
 *
 * Per Req 18.1, the API server issues Dashboard sessions exclusively via the
 * HttpOnly `fl_session` cookie; the cookie is not readable from JavaScript.
 * Per Req 18.2, this module MUST NOT persist authentication tokens to
 * `window.localStorage` or `window.sessionStorage`. The double-submit
 * `fl_csrf` cookie's value is mirrored in the login response body, captured
 * here as a module-level variable, and read by `lib/api.ts` to attach the
 * `X-CSRF-Token` header on every state-changing request (Req 18.4).
 *
 * The legacy bearer-token slot is retained as an in-memory variable (NOT in
 * `localStorage`) for backwards compatibility with the existing Socket.IO
 * client in `lib/socket.ts`, which authenticates its handshake with a JWT.
 * The token is volatile by design — a hard refresh discards it; the
 * HttpOnly session cookie continues to authenticate REST calls and the
 * Extension is unaffected because it uses `chrome.storage.local` (Req 18.6).
 *
 * Public surface:
 *   - {@link setCsrfToken} / {@link getCsrfToken}
 *   - {@link setToken} / {@link getToken}
 *   - {@link clearAuth} — drops every in-memory token at once (logout)
 *   - {@link getIsAuthed} — synchronous router/auth-guard helper
 *   - {@link probeIsAuthed} — async fallback that consults the server
 *
 * Requirements: 18.1, 18.2, 18.4
 */

// --- Module-level token state ------------------------------------------------

let csrfToken: string | null = null;
let bearerToken: string | null = null;

// --- CSRF token --------------------------------------------------------------

/**
 * Capture the CSRF token returned in the login (or refresh) response body.
 * Pass `null` on logout to clear the slot.
 */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Read the CSRF token currently in memory, or `null` if not signed in. */
export function getCsrfToken(): string | null {
  return csrfToken;
}

// --- Bearer JWT (Socket.IO compatibility, in-memory only) -------------------

/**
 * Stash the bearer JWT used by the Socket.IO client. Stored in memory only;
 * a hard page refresh discards it. The Dashboard does not need this for
 * REST calls — the HttpOnly session cookie covers those — but Socket.IO
 * authenticates its handshake via `auth: { token }` and reads it from here.
 */
export function setToken(token: string): void {
  bearerToken = token;
}

/** Read the in-memory bearer JWT (used by `lib/socket.ts`). */
export function getToken(): string | null {
  return bearerToken;
}

// --- One-shot logout helper --------------------------------------------------

/**
 * Drop every in-memory auth token. Called by the logout flow alongside
 * `POST /api/v1/auth/logout`, which clears the server-side cookies.
 */
export function clearAuth(): void {
  csrfToken = null;
  bearerToken = null;
}

// --- Auth-guard helpers ------------------------------------------------------

/**
 * Synchronous auth check used by the router/auth guard.
 *
 * The HttpOnly session cookie is not readable from JavaScript, so the
 * presence of a CSRF token in memory stands in for "session is established"
 * — login captures it, logout clears it. A hard refresh wipes both even
 * though the session cookie may still be valid; in that case the caller
 * should fall back to {@link probeIsAuthed}, which consults the server.
 */
export function getIsAuthed(): boolean {
  return csrfToken !== null;
}

/**
 * Async auth check that probes the server when the in-memory CSRF token is
 * empty (e.g., after a hard refresh). A successful `GET /api/v1/users/me`
 * proves the HttpOnly session cookie is still valid.
 *
 * Note: this does NOT re-populate the CSRF token. A subsequent state-
 * changing request will need a fresh CSRF token; the caller should re-issue
 * one (e.g., by re-logging-in or hitting an endpoint that returns it). The
 * router's auth guard only needs a yes/no answer to decide whether to
 * redirect to `/auth`, so a probe is sufficient here.
 */
export async function probeIsAuthed(): Promise<boolean> {
  if (csrfToken !== null) return true;
  try {
    const res = await fetch('/api/v1/users/me', {
      credentials: 'include',
    });
    return res.ok;
  } catch {
    return false;
  }
}
