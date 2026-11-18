import { readFileSync } from 'node:fs';
import { SESSION_META, STORAGE_STATE } from '../global-setup.js';
/**
 * Authenticated-API helpers.
 *
 * Encapsulates the cookie + CSRF flow described in design.md §"Auth:
 * cookie+CSRF for Dashboard, bearer JWT for Extension." (Req 18.1–18.5):
 *
 *   1. `POST /api/v1/auth/login` returns `{ user, csrfToken, token }` and
 *      sets `Set-Cookie: fl_session=<jwt>; HttpOnly; SameSite=Lax` plus
 *      `Set-Cookie: fl_csrf=<rand>; SameSite=Lax`. Playwright's request
 *      context preserves cookies across calls automatically, so we just
 *      capture the `csrfToken` body field.
 *   2. Every state-changing call (`POST` / `PUT` / `PATCH` / `DELETE`) MUST
 *      attach `X-CSRF-Token: <csrfToken>` so the server-side
 *      `csrfMiddleware` sees `header == cookie`.
 *   3. The Dashboard MUST NOT read tokens from `localStorage`. Tests
 *      mirror that: nothing is persisted to storage; the cookie carries
 *      the session and the in-memory CSRF token authenticates mutations.
 *
 * The full registration → email-verify → login round trip requires
 * inspecting the verification email, which the test stack doesn't deliver
 * (no SMTP wired in dev). The "happy path" spec instead uses a seed
 * account whose email/password are passed via `FL_E2E_EMAIL` /
 * `FL_E2E_PASSWORD`; specs that need the unverified-login branch hit
 * `register` + `login` and assert the 401 `EMAIL_NOT_VERIFIED` response
 * (Req 20.4).
 */
import type { APIRequestContext } from '@playwright/test';

import { API_BASE_URL } from './stack.js';

export interface LoginResult {
  /** Random string echoed in `X-CSRF-Token` for every mutating request. */
  csrfToken: string;
  /** Bearer JWT (Extension flow only — Dashboard tests do not use it). */
  token: string;
  user: { id: string; email: string; name: string; createdAt: string };
}

export interface AuthSession {
  csrfToken: string;
  /** Build the headers to attach to a state-changing request. */
  mutatingHeaders(extra?: Record<string, string>): Record<string, string>;
}

/**
 * `POST /api/v1/auth/register` — creates an unverified account. Returns
 * the response so the caller can assert on the status (201 on success,
 * 409 on conflict, 400 on weak password).
 */
export async function register(
  request: APIRequestContext,
  email: string,
  password: string,
  name: string,
) {
  return request.post(`${API_BASE_URL}/api/v1/auth/register`, {
    data: { email, password, name },
  });
}

/**
 * Log in an account that's already registered + verified. Returns a
 * session object whose `mutatingHeaders()` produces the headers every
 * state-changing request must carry.
 */
export async function loginExisting(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<{ session: AuthSession; user: LoginResult['user']; token: string }> {
  // The seeded account's session is created ONCE by global-setup.ts and
  // loaded into every request context via `storageState`, so the per-spec
  // login doesn't trip the API's 5-per-minute auth rate limit (Req 19.1).
  const seeded = await seedSession(request, email);
  if (seeded) return seeded;

  const loginRes = await request.post(`${API_BASE_URL}/api/v1/auth/login`, {
    data: { email, password },
  });
  if (!loginRes.ok()) {
    throw new Error(`login failed: ${loginRes.status()} ${await loginRes.text()}`);
  }
  const body = (await loginRes.json()) as LoginResult;

  // Sanity-check that the server actually issued the cookies the
  // dashboard relies on (Req 18.1, 18.3). Playwright's APIRequestContext
  // tracks them in its jar so subsequent calls send them automatically.
  const setCookie = setCookieHeader(loginRes.headers()['set-cookie']);
  if (!setCookie.includes('fl_session=')) {
    throw new Error('login response missing fl_session cookie — Req 18.1 violated?');
  }
  if (!setCookie.includes('fl_csrf=')) {
    throw new Error('login response missing fl_csrf cookie — Req 18.3 violated?');
  }
  if (!body.csrfToken) {
    throw new Error('login response body missing csrfToken — Req 18.3 violated?');
  }

  const session: AuthSession = {
    csrfToken: body.csrfToken,
    mutatingHeaders(extra: Record<string, string> = {}): Record<string, string> {
      return {
        'Content-Type': 'application/json',
        'X-CSRF-Token': body.csrfToken,
        ...extra,
      };
    },
  };

  return { session, user: body.user, token: body.token };
}

/**
 * Session for the seed account written by global-setup.ts, if any. The
 * cached cookies are added ONLY to the request context that asked to be
 * logged in — specs that model anonymous visitors keep an empty jar.
 *
 * Playwright's APIRequestContext has no public addCookies(), so the cookies
 * are attached per call via a scoped Cookie header on this context only.
 */
async function seedSession(
  request: APIRequestContext,
  email: string,
): Promise<{ session: AuthSession; user: LoginResult['user']; token: string } | null> {
  let meta: { email: string; body: LoginResult } | null = null;
  let state: { cookies: Array<{ name: string; value: string }> } | null = null;
  try {
    meta = JSON.parse(readFileSync(SESSION_META, 'utf8'));
    state = JSON.parse(readFileSync(STORAGE_STATE, 'utf8'));
  } catch {
    return null;
  }
  if (!meta || !state || meta.email !== email.toLowerCase()) return null;
  const cookieHeader = state.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  attachCookies(request, cookieHeader);
  const { body } = meta;
  const session: AuthSession = {
    csrfToken: body.csrfToken,
    mutatingHeaders(extra: Record<string, string> = {}): Record<string, string> {
      return { 'Content-Type': 'application/json', 'X-CSRF-Token': body.csrfToken, ...extra };
    },
  };
  return { session, user: body.user, token: body.token };
}

function attachCookies(request: APIRequestContext, cookieHeader: string): void {
  const ctx = request as APIRequestContext & { __ppSeedCookies?: boolean };
  if (ctx.__ppSeedCookies) return;
  for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch'] as const) {
    const original = (ctx as any)[verb].bind(ctx);
    (ctx as any)[verb] = (url: string, options: Record<string, any> = {}) => {
      const headers = { ...(options.headers ?? {}) };
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) headers.Cookie = cookieHeader;
      return original(url, { ...options, headers });
    };
  }
  ctx.__ppSeedCookies = true;
}

/**
 * Normalise the `set-cookie` response header. Playwright concatenates
 * multi-cookie responses with `\n`; we collapse to a single string so
 * `.includes(…)` works regardless of representation.
 */
function setCookieHeader(raw: string | string[] | undefined): string {
  if (!raw) return '';
  return Array.isArray(raw) ? raw.join('\n') : raw;
}
