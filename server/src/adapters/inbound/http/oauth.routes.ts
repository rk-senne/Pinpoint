// Inbound HTTP adapter — OAuth routes (GET redirect + GET callback).
// PKCE S256 support for mobile deep-link callbacks (Task 1).

import { Router, type Request, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import type { OAuthLogin, OAuthProvider } from '../../../domain/auth/usecases/oauthLogin.js';

export interface OAuthRouteDeps {
  oauthLogin: OAuthLogin;
  providers: Record<string, OAuthProvider>;
  callbackBaseUrl: string;
  appUrl: string;
  cookieInsecure?: boolean;
}

function buildSessionCookie(token: string, insecure: boolean): string {
  const parts = [`fl_session=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (!insecure) parts.splice(2, 0, 'Secure');
  return parts.join('; ');
}

function buildCsrfCookie(csrf: string): string {
  return [`fl_csrf=${csrf}`, 'SameSite=Lax', 'Path=/'].join('; ');
}

/** PKCE S256: base64url(sha256(code_verifier)) === code_challenge */
function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const hash = createHash('sha256').update(codeVerifier).digest('base64url');
  return hash === codeChallenge;
}

interface OAuthStateCookie {
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

export function createOAuthRoutes(deps: OAuthRouteDeps): Router {
  const { oauthLogin, providers, callbackBaseUrl, appUrl, cookieInsecure = false } = deps;
  const router = Router();

  function handleRedirect(providerName: string, req: Request, res: Response): void {
    const provider = providers[providerName];
    if (!provider) { res.status(404).json({ error: `${providerName} OAuth not configured.` }); return; }

    const state = randomBytes(16).toString('hex');
    const redirectUri = `${callbackBaseUrl}/api/v1/auth/oauth/${providerName}/callback`;

    // PKCE: optional code_challenge params for mobile clients
    const { code_challenge, code_challenge_method } = req.query as {
      code_challenge?: string;
      code_challenge_method?: string;
    };

    const cookiePayload: OAuthStateCookie = { state };
    if (code_challenge) {
      cookiePayload.codeChallenge = code_challenge;
      cookiePayload.codeChallengeMethod = code_challenge_method || 'S256';
    }

    res.cookie('oauth_state', JSON.stringify(cookiePayload), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 600_000,
      secure: !cookieInsecure,
    });
    res.redirect(provider.getAuthorizationUrl(state, redirectUri));
  }

  async function handleCallback(providerName: string, req: Request, res: Response): Promise<void> {
    const provider = providers[providerName];
    if (!provider) { res.status(404).json({ error: `${providerName} OAuth not configured.` }); return; }

    const { code, state, code_verifier } = req.query as {
      code?: string;
      state?: string;
      code_verifier?: string;
    };

    // Parse state cookie (supports both legacy string and new JSON formats)
    const rawCookie = req.cookies?.oauth_state;
    res.clearCookie('oauth_state');

    let stateCookie: OAuthStateCookie | null = null;
    if (typeof rawCookie === 'string') {
      try {
        stateCookie = JSON.parse(rawCookie) as OAuthStateCookie;
      } catch {
        // Legacy format: plain state string
        stateCookie = { state: rawCookie };
      }
    }

    if (!code || !state || !stateCookie || state !== stateCookie.state) {
      res.redirect(`${appUrl}/auth?error=oauth_failed`);
      return;
    }

    const redirectUri = `${callbackBaseUrl}/api/v1/auth/oauth/${providerName}/callback`;
    const result = await oauthLogin.execute({ provider: providerName as 'google' | 'github', code, redirectUri });
    if (!result.ok) {
      res.redirect(`${appUrl}/auth?error=oauth_failed`);
      return;
    }

    // PKCE mobile flow: validate code_verifier and return JSON
    if (code_verifier && stateCookie.codeChallenge) {
      if (stateCookie.codeChallengeMethod !== 'S256') {
        res.status(400).json({ error: 'Unsupported code_challenge_method. Only S256 is supported.' });
        return;
      }
      if (!verifyPkceS256(code_verifier, stateCookie.codeChallenge)) {
        res.status(403).json({ error: 'PKCE verification failed.' });
        return;
      }
      // Mobile clients get JSON response (can't use cookies)
      const { token, user } = result.value;
      res.status(200).json({ token, user });
      return;
    }

    // Web flow: redirect with cookies
    const { token, csrfToken } = result.value;
    res.setHeader('Set-Cookie', [buildSessionCookie(token, cookieInsecure), buildCsrfCookie(csrfToken)]);
    res.redirect(appUrl);
  }

  // --- Google ---
  router.get('/google', (req, res) => handleRedirect('google', req, res));
  router.get('/google/callback', (req, res) => handleCallback('google', req, res));

  // --- GitHub ---
  router.get('/github', (req, res) => handleRedirect('github', req, res));
  router.get('/github/callback', (req, res) => handleCallback('github', req, res));

  return router;
}
