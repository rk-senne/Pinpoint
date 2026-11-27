// PP-15: session / CSRF cookie naming, attributes and CSRF-to-session binding.
//
// Cookie names: on a Secure deployment the cookies use the `__Host-` prefix
// (browser-enforced: Secure, Path=/, no Domain) so a sibling subdomain cannot
// "toss" a cookie over them. On a plain-HTTP loopback stack (COOKIE_INSECURE)
// the prefix is impossible, so the legacy names are kept. Readers accept both.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TokenIssuer } from '../domain/auth/ports/TokenIssuer.js';

export const SESSION_COOKIE = 'fl_session';
export const CSRF_COOKIE = 'fl_csrf';
export const HOST_PREFIX = '__Host-';

/** Cookie Max-Age (seconds): matches the 24 h access token; refresh slides it. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

export function sessionCookieName(insecure: boolean): string {
  return insecure ? SESSION_COOKIE : `${HOST_PREFIX}${SESSION_COOKIE}`;
}

export function csrfCookieName(insecure: boolean): string {
  return insecure ? CSRF_COOKIE : `${HOST_PREFIX}${CSRF_COOKIE}`;
}

export function buildSessionCookie(token: string, insecure: boolean): string {
  const parts = [
    `${sessionCookieName(insecure)}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (!insecure) parts.splice(2, 0, 'Secure');
  return parts.join('; ');
}

export function buildCsrfCookie(csrf: string, insecure: boolean): string {
  const parts = [
    `${csrfCookieName(insecure)}=${csrf}`,
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (!insecure) parts.splice(1, 0, 'Secure');
  return parts.join('; ');
}

/** Clear both generations of both cookies (name-prefix migration safe). */
export function buildClearCookies(insecure: boolean): string[] {
  const clear = [
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    `${CSRF_COOKIE}=; SameSite=Lax; Path=/; Max-Age=0`,
  ];
  if (!insecure) {
    clear.push(
      `${HOST_PREFIX}${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
      `${HOST_PREFIX}${CSRF_COOKIE}=; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    );
  }
  return clear;
}

type CookieJar = Record<string, unknown> | undefined;

function readFirst(cookies: CookieJar, names: string[]): string | null {
  for (const n of names) {
    const v = cookies?.[n];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** Session JWT from the cookie jar, accepting the `__Host-` and legacy names. */
export function readSessionCookie(cookies: CookieJar): string | null {
  return readFirst(cookies, [`${HOST_PREFIX}${SESSION_COOKIE}`, SESSION_COOKIE]);
}

export function readCsrfCookie(cookies: CookieJar): string | null {
  return readFirst(cookies, [`${HOST_PREFIX}${CSRF_COOKIE}`, CSRF_COOKIE]);
}

// --- CSRF token bound to the session ---------------------------------------

export interface CsrfBinder {
  /** Mint `<nonce>.<hmac(nonce, userId, sessionStart)>` for a freshly issued session JWT. */
  mintForToken(sessionJwt: string): string;
  /** True when `csrf` was minted for the session carried by `sessionJwt`. */
  isBoundTo(csrf: string, sessionJwt: string): boolean;
}

export function createCsrfBinder(deps: {
  secret: string;
  tokenIssuer: Pick<TokenIssuer, 'decodeIgnoreExpiration'>;
}): CsrfBinder {
  const key = createHmac('sha256', deps.secret).update('pinpoint:csrf-binding:v1').digest();

  const mac = (nonce: string, userId: string, sessionStart: number | undefined): string =>
    createHmac('sha256', key)
      .update(`${nonce}|${userId}|${sessionStart ?? 'legacy'}`)
      .digest('hex');

  return {
    mintForToken(sessionJwt) {
      const claims = deps.tokenIssuer.decodeIgnoreExpiration(sessionJwt);
      const nonce = randomBytes(24).toString('hex');
      return `${nonce}.${mac(nonce, claims.userId, claims.sessionStart)}`;
    },
    isBoundTo(csrf, sessionJwt) {
      const dot = csrf.indexOf('.');
      if (dot <= 0) return false;
      const nonce = csrf.slice(0, dot);
      const given = csrf.slice(dot + 1);
      let expected: string;
      try {
        // Signature still enforced; expiry is irrelevant to the binding
        // (the refresh route is itself CSRF-protected and may carry an expired JWT).
        const claims = deps.tokenIssuer.decodeIgnoreExpiration(sessionJwt);
        expected = mac(nonce, claims.userId, claims.sessionStart);
      } catch {
        return false;
      }
      const a = Buffer.from(given);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    },
  };
}
