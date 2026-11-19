// PP-21: real OAuth 2.0 authorization-code flow for integration providers.
//
// A provider is "configured" only when its client id AND secret are present in
// the environment (`INTEGRATION_<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET`);
// unconfigured providers cannot start or complete the OAuth flow. All outbound
// calls go through `safeFetch` (https-only, DNS-pinned, private ranges blocked,
// bounded redirects) and the response body is size-capped.

import { readBodyCapped, safeFetch, type EgressGuardOptions } from '../egressGuard.js';

export type IntegrationOAuthProviderName = 'slack' | 'jira' | 'linear' | 'github' | 'clickup' | 'asana';

export interface IntegrationOAuthProvider {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  scopeSeparator: string;
  /** Extra static query params on the authorize redirect. */
  authorizeParams?: Record<string, string>;
  /** How the token request body is encoded. */
  tokenRequest: 'form' | 'json';
}

const DEFAULTS: Record<IntegrationOAuthProviderName, Omit<IntegrationOAuthProvider, 'clientId' | 'clientSecret'>> = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo'],
    scopeSeparator: ' ',
    tokenRequest: 'form',
  },
  slack: {
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['chat:write', 'incoming-webhook'],
    scopeSeparator: ',',
    tokenRequest: 'form',
  },
  jira: {
    authorizeUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    scopes: ['read:jira-work', 'write:jira-work', 'offline_access'],
    scopeSeparator: ' ',
    authorizeParams: { audience: 'api.atlassian.com', prompt: 'consent' },
    tokenRequest: 'json',
  },
  linear: {
    authorizeUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    scopes: ['read', 'write'],
    scopeSeparator: ',',
    tokenRequest: 'form',
  },
  // ClickUp has no OAuth scopes; the authorize page is `app.clickup.com/api`
  // and the token endpoint takes the client credentials + code. Tokens do not expire.
  clickup: {
    authorizeUrl: 'https://app.clickup.com/api',
    tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
    scopes: [],
    scopeSeparator: ' ',
    tokenRequest: 'json',
  },
  // Asana: access tokens last 1 h and come with a refresh token. Scopes are
  // optional for apps created with full-access permissions; override with
  // INTEGRATION_ASANA_SCOPES (e.g. `tasks:write projects:read`) if needed.
  asana: {
    authorizeUrl: 'https://app.asana.com/-/oauth_authorize',
    tokenUrl: 'https://app.asana.com/-/oauth_token',
    scopes: [],
    scopeSeparator: ' ',
    tokenRequest: 'form',
  },
};

export const INTEGRATION_OAUTH_PROVIDERS = Object.keys(DEFAULTS) as IntegrationOAuthProviderName[];

/** Providers whose credentials are present in `env`; others are absent from the map. */
export function loadIntegrationOAuthProviders(
  env: Record<string, string | undefined>,
): Partial<Record<IntegrationOAuthProviderName, IntegrationOAuthProvider>> {
  const out: Partial<Record<IntegrationOAuthProviderName, IntegrationOAuthProvider>> = {};
  for (const name of INTEGRATION_OAUTH_PROVIDERS) {
    const up = name.toUpperCase();
    const clientId = env[`INTEGRATION_${up}_CLIENT_ID`]?.trim();
    const clientSecret = env[`INTEGRATION_${up}_CLIENT_SECRET`]?.trim();
    if (!clientId || !clientSecret) continue;
    const scopesEnv = env[`INTEGRATION_${up}_SCOPES`]?.trim();
    const base = DEFAULTS[name];
    out[name] = {
      ...base,
      clientId,
      clientSecret,
      scopes: scopesEnv ? scopesEnv.split(/[\s,]+/).filter(Boolean) : base.scopes,
    };
  }
  return out;
}

export function buildAuthorizeUrl(
  p: IntegrationOAuthProvider,
  args: { state: string; redirectUri: string },
): string {
  const url = new URL(p.authorizeUrl);
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', args.state);
  if (p.scopes.length > 0) url.searchParams.set('scope', p.scopes.join(p.scopeSeparator));
  for (const [k, v] of Object.entries(p.authorizeParams ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken?: string;
  /** ISO timestamp, when the provider reported `expires_in`. */
  tokenExpiresAt?: string;
  /** Non-secret facts safe to show in the UI (scope, workspace name). */
  config: Record<string, unknown>;
}

export class OAuthExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthExchangeError';
  }
}

const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const EXCHANGE_TIMEOUT_MS = 10_000;

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Trade an authorization code for tokens. Throws `OAuthExchangeError` with a
 * provider-agnostic message (the provider's body is never echoed to callers).
 */
export async function exchangeAuthorizationCode(
  p: IntegrationOAuthProvider,
  args: { code: string; redirectUri: string; egress?: EgressGuardOptions; now?: () => number },
): Promise<ExchangedTokens> {
  const fields: Record<string, string> = {
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: p.clientId,
    client_secret: p.clientSecret,
  };
  const body = p.tokenRequest === 'json' ? JSON.stringify(fields) : new URLSearchParams(fields).toString();

  let res;
  try {
    res = await safeFetch(
      p.tokenUrl,
      {
        method: 'POST',
        headers: {
          'content-type': p.tokenRequest === 'json' ? 'application/json' : 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      },
      args.egress ?? {},
    );
  } catch {
    throw new OAuthExchangeError('Could not reach the provider token endpoint.');
  }

  const { text, truncated } = await readBodyCapped(res as never, MAX_TOKEN_RESPONSE_BYTES);
  if (truncated) throw new OAuthExchangeError('Provider token response was too large.');
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    json = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new OAuthExchangeError('Provider token response was not valid JSON.');
  }

  // Slack answers 200 with `{ ok: false, error }`; GitHub answers 200 with `{ error }`.
  if (!res.ok || json.ok === false || typeof json.error === 'string') {
    throw new OAuthExchangeError('The provider rejected the authorization code.');
  }
  const accessToken = asString(json.access_token);
  if (!accessToken) throw new OAuthExchangeError('The provider did not return an access token.');

  const expiresIn = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : undefined;
  const now = args.now ?? Date.now;
  const team = json.team && typeof json.team === 'object' ? (json.team as Record<string, unknown>) : undefined;
  const refreshToken = asString(json.refresh_token);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn ? { tokenExpiresAt: new Date(now() + expiresIn * 1000).toISOString() } : {}),
    config: {
      ...(asString(json.scope) ? { scope: asString(json.scope) } : {}),
      ...(asString(json.token_type) ? { tokenType: asString(json.token_type) } : {}),
      ...(team && asString(team.name) ? { workspace: asString(team.name) } : {}),
    },
  };
}
