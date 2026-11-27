// Inbound HTTP adapter — OAuth routes (GET redirect + GET callback).
// PKCE S256 support for mobile deep-link callbacks (Task 1).

import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { buildCsrfCookie, buildSessionCookie, type CsrfBinder } from '../../../middleware/sessionCookies.js';
import type { OAuthLogin, OAuthProvider } from '../../../domain/auth/usecases/oauthLogin.js';

export interface OAuthRouteDeps {
  oauthLogin: OAuthLogin;
  providers: Record<string, OAuthProvider>;
  callbackBaseUrl: string;
  appUrl: string;
  cookieInsecure?: boolean;
  csrfBinder?: CsrfBinder;
  /**
   * HMAC key (OAUTH_STATE_SECRET) signing the `oauth_state` cookie. Required:
   * an unsigned state cookie lets an attacker who can plant a cookie (sibling
   * subdomain, XSS on a neighbour) complete a login-CSRF.
   */
  stateSecret: string;
  /** State cookie lifetime in ms (default 10 minutes). */
  stateTtlMs?: number;
  /** Test seam: clock. */
  now?: () => number;
  /**
   * IGNORED. OAuth login initiation must work for a visitor with no session
   * (that is the whole point of "log in with …"); gating `/google` and
   * `/github` behind auth made them unusable. Kept optional only so callers
   * that still pass it keep type-checking.
   */
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void;
}

/** PKCE S256: base64url(sha256(code_verifier)) === code_challenge */
function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const hash = createHash('sha256').update(codeVerifier).digest('base64url');
  return hash === codeChallenge;
}

interface OAuthStatePayload {
  /** Random state echoed by the provider on the callback. */
  s: string;
  /** Provider this state was issued for — a state minted for google can't complete github. */
  p: string;
  /** Expiry, epoch ms. */
  e: number;
  /** PKCE challenge (mobile flow). */
  cc?: string;
  ccm?: string;
}

const STATE_COOKIE = 'oauth_state';
const STATE_COOKIE_PATH = '/api/v1/auth/oauth';

function b64u(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(secret: string, payloadB64: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** `<payload>.<hmac>` — tamper-evident, provider-bound, expiring. */
export function signOAuthState(secret: string, payload: OAuthStatePayload): string {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${sign(secret, body)}`;
}

/** Returns the payload only if the MAC verifies (constant time) AND it hasn't expired. */
export function verifyOAuthState(
  secret: string,
  raw: unknown,
  nowMs: number,
): OAuthStatePayload | null {
  if (typeof raw !== 'string') return null;
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const body = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  if (!safeEqual(mac, sign(secret, body))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStatePayload;
    if (typeof p.s !== 'string' || typeof p.p !== 'string' || typeof p.e !== 'number') return null;
    if (p.e <= nowMs) return null;
    return p;
  } catch {
    return null;
  }
}

export function createOAuthRoutes(deps: OAuthRouteDeps): Router {
  const { oauthLogin, providers, callbackBaseUrl, appUrl, cookieInsecure = false, stateSecret, csrfBinder } = deps;
  if (typeof stateSecret !== 'string' || stateSecret.length === 0) {
    throw new Error('createOAuthRoutes: stateSecret (OAUTH_STATE_SECRET) is required');
  }
  const stateTtlMs = deps.stateTtlMs ?? 600_000;
  const now = deps.now ?? Date.now;
  const router = Router();

  function handleRedirect(providerName: string, req: Request, res: Response): void {
    const provider = providers[providerName];
    if (!provider) { res.status(404).json({ error: { code: 'NOT_FOUND', message: `${providerName} OAuth not configured.` } }); return; }

    const state = randomBytes(16).toString('hex');
    const redirectUri = `${callbackBaseUrl}/api/v1/auth/oauth/${providerName}/callback`;

    // PKCE: optional code_challenge params for mobile clients
    const { code_challenge, code_challenge_method } = req.query as {
      code_challenge?: string;
      code_challenge_method?: string;
    };

    const payload: OAuthStatePayload = { s: state, p: providerName, e: now() + stateTtlMs };
    if (code_challenge) {
      payload.cc = code_challenge;
      payload.ccm = code_challenge_method || 'S256';
    }

    res.cookie(STATE_COOKIE, signOAuthState(stateSecret, payload), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: stateTtlMs,
      secure: !cookieInsecure,
      path: STATE_COOKIE_PATH,
    });
    res.redirect(provider.getAuthorizationUrl(state, redirectUri));
  }

  async function handleCallback(providerName: string, req: Request, res: Response): Promise<void> {
    const provider = providers[providerName];
    if (!provider) { res.status(404).json({ error: { code: 'NOT_FOUND', message: `${providerName} OAuth not configured.` } }); return; }

    const { code, state, code_verifier } = req.query as {
      code?: string;
      state?: string;
      code_verifier?: string;
    };

    // Single-use: always drop the state cookie (same path it was set with).
    const rawCookie = req.cookies?.[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, { path: STATE_COOKIE_PATH });

    const stateCookie = verifyOAuthState(stateSecret, rawCookie, now());
    if (
      !code ||
      !state ||
      !stateCookie ||
      stateCookie.p !== providerName ||
      !safeEqual(state, stateCookie.s)
    ) {
      res.redirect(`${appUrl}/auth?error=oauth_failed`);
      return;
    }

    // PKCE mobile flow: validate BEFORE exchanging the code / creating anything.
    const pkce = Boolean(code_verifier && stateCookie.cc);
    if (pkce) {
      if (stateCookie.ccm !== 'S256') {
        res.status(400).json({ error: { code: 'VALIDATION', message: 'Unsupported code_challenge_method. Only S256 is supported.' } });
        return;
      }
      if (!verifyPkceS256(code_verifier!, stateCookie.cc!)) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'PKCE verification failed.' } });
        return;
      }
    }

    const redirectUri = `${callbackBaseUrl}/api/v1/auth/oauth/${providerName}/callback`;
    const result = await oauthLogin.execute({ provider: providerName as 'google' | 'github', code, redirectUri });
    if (!result.ok) {
      res.redirect(`${appUrl}/auth?error=oauth_failed`);
      return;
    }

    if (pkce) {
      // Mobile clients get JSON response (can't use cookies)
      const { token, user } = result.value;
      res.status(200).json({ token, user });
      return;
    }

    // Web flow: redirect with cookies
    const { token, csrfToken } = result.value;
    // append (not set): keep the state-cookie clearing header queued above.
    res.append('Set-Cookie', [buildSessionCookie(token, cookieInsecure), buildCsrfCookie(csrfBinder ? csrfBinder.mintForToken(token) : csrfToken, cookieInsecure)]);
    res.redirect(appUrl);
  }

  // Login initiation + callback are PUBLIC: the visitor has no session yet.
  // CSRF protection is the signed, provider-bound, expiring state cookie.
  for (const name of ['google', 'github'] as const) {
    router.get(`/${name}`, (req, res) => handleRedirect(name, req, res));
    router.get(`/${name}/callback`, (req, res) => {
      handleCallback(name, req, res).catch(() => {
        if (!res.headersSent) res.redirect(`${appUrl}/auth?error=oauth_failed`);
      });
    });
  }

  return router;
}
