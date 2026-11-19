import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Integration, IntegrationRepo } from '../../../domain/integration/ports/IntegrationRepo.js';
import { requireOrgAdmin } from './access.js';
import type { EgressGuardOptions, safeFetch as defaultSafeFetch } from '../../../services/egressGuard.js';
import {
  OAuthExchangeError,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  type IntegrationOAuthProvider,
} from '../../../services/integrations/oauthExchange.js';
import {
  TARGET_CONFIG_SCHEMAS,
  TargetsFetchError,
  isTargetProvider,
  listTargets,
  resolveSingleJiraSite,
} from '../../../services/integrations/targets.js';

/** Lifetime of the OAuth state cookie, enforced server-side via the signed `exp`. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const PROVIDERS = ['slack', 'jira', 'linear', 'github', 'clickup', 'asana'] as const;

/** Constant-time string comparison (prevents timing attacks on HMAC). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export interface IntegrationsRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  integrationRepo: IntegrationRepo;
  oauthStateSecret: string;
  /**
   * Providers with OAuth client credentials configured (PP-21). A provider that
   * is absent here cannot start or complete an OAuth connect (501), instead of
   * the former placeholder that stored `exchanged_<code>` as a token.
   */
  oauthProviders?: Partial<Record<string, IntegrationOAuthProvider>>;
  /** Public origin of the dashboard/API (`APP_URL`); the provider redirects back to it. */
  callbackBaseUrl?: string;
  /** Plain-HTTP loopback stacks only: drops `Secure` from the state cookie. */
  cookieInsecure?: boolean;
  /** Egress policy for the token exchange (tests inject a fake endpoint resolver). */
  egress?: EgressGuardOptions;
  /** Outbound fetch for target discovery / Jira site lookup (tests inject a fake). */
  safeFetch?: typeof defaultSafeFetch;
}

const ConnectSchema = z.object({
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

/** Config keys that look like credentials never leave the server. */
const SECRET_KEY_RE = /secret|token|password|passwd|credential|authorization|api[-_]?key|private|signing|cert|bearer/i;

/**
 * Whitelisted public view of an integration. Access/refresh tokens and any
 * credential-looking `config` entry (e.g. `clientSecret`) are removed; the
 * orgId is omitted too (the caller already knows it).
 */
export function toIntegrationDto(i: Integration): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(i.config ?? {})) {
    if (SECRET_KEY_RE.test(k)) continue;
    config[k] = v;
  }
  return {
    id: i.id,
    provider: i.provider,
    enabled: i.enabled,
    config,
    createdAt: i.createdAt,
  };
}

export function createIntegrationsRoutes(deps: IntegrationsRouteDeps): Router {
  const { authMiddleware, integrationRepo, oauthStateSecret } = deps;
  const redirectUriFor = (provider: string): string =>
    `${(deps.callbackBaseUrl ?? '').replace(/\/+$/, '')}/api/v1/integrations/${provider}/callback`;
  const router = Router();
  /** Where the browser lands after the provider round-trip: the dashboard page. */
  const dashboardUrl = (query: Record<string, string>): string =>
    `${(deps.callbackBaseUrl ?? '').replace(/\/+$/, '')}/integrations?${new URLSearchParams(query).toString()}`;
  const targetFetchOpts = () => ({
    ...(deps.safeFetch ? { safeFetch: deps.safeFetch } : {}),
    ...(deps.egress ? { egress: deps.egress } : {}),
  });

  // GET /api/v1/integrations/:provider/callback — handle OAuth callback
  // This route is NOT behind authMiddleware because OAuth providers redirect
  // unauthenticated users here. The orgId is derived from a cryptographically-
  // bound state cookie set during the connect flow (NOT from the query param).
  // PP-21: the state cookie is bound to the admin who started the flow (`uid`), carries
  // a signed expiry (`exp`, not just a client-enforced maxAge) and the callback requires
  // that same admin's session (same-origin navigation, so the session cookie is sent).
  router.get('/:provider/callback', authMiddleware, requireOrgAdmin, async (req: Request, res: Response) => {
    const provider = req.params.provider as string;
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      res.status(400).json({ error: { code: 'VALIDATION', message: `Invalid provider: ${provider}` } });
      return;
    }

    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    if (typeof req.query.error === 'string') {
      // The user denied consent (or the provider failed); nothing to exchange.
      res.clearCookie('integration_oauth_state');
      res.redirect(302, dashboardUrl({ error: 'OAUTH_DENIED' }));
      return;
    }
    if (!code) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'Missing code parameter' } });
      return;
    }
    if (!state) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'Missing state parameter' } });
      return;
    }

    // Parse and immediately clear the state cookie
    const raw = req.cookies?.integration_oauth_state;
    res.clearCookie('integration_oauth_state');

    let stateCookie: { state: string; orgId: string; provider: string; uid?: string; exp?: number; sig?: string } | null = null;
    if (typeof raw === 'string') {
      try { stateCookie = JSON.parse(raw); } catch { stateCookie = null; }
    }

    // Validate: cookie exists, random state matches, provider matches
    if (!stateCookie || state !== stateCookie.state || provider !== stateCookie.provider) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid or expired OAuth state' } });
      return;
    }

    // Verify HMAC integrity of the cookie payload
    const expectedPayload = `${stateCookie.state}.${stateCookie.orgId}.${stateCookie.provider}.${stateCookie.uid ?? ''}.${stateCookie.exp ?? ''}`;
    const expectedSig = createHmac('sha256', oauthStateSecret)
      .update(expectedPayload)
      .digest('hex');

    if (
      !stateCookie.sig ||
      !constantTimeEqual(expectedSig, stateCookie.sig)
    ) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'OAuth state signature invalid' } });
      return;
    }

    // Signed expiry + binding to the user (and org) that started the flow.
    if (typeof stateCookie.exp !== 'number' || stateCookie.exp <= Date.now()) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid or expired OAuth state' } });
      return;
    }
    if (stateCookie.uid !== req.user!.userId || stateCookie.orgId !== req.user!.orgId) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid or expired OAuth state' } });
      return;
    }

    // Derive orgId from the COOKIE (never from the query param)
    const orgId = stateCookie.orgId;

    const providerCfg = deps.oauthProviders?.[provider];
    if (!providerCfg) {
      res.redirect(302, dashboardUrl({ error: 'INTEGRATION_NOT_CONFIGURED', provider }));
      return;
    }
    let tokens;
    try {
      tokens = await exchangeAuthorizationCode(providerCfg, {
        code,
        redirectUri: redirectUriFor(provider),
        ...(deps.egress ? { egress: deps.egress } : {}),
      });
    } catch {
      // The provider's body is never echoed; the API log has no token either.
      res.redirect(302, dashboardUrl({ error: 'OAUTH_EXCHANGE_FAILED', provider }));
      return;
    }

    // Keep an earlier "Finish setup" choice (repo/project/team) across a reconnect.
    const existing = await integrationRepo.findByOrgAndProvider(orgId, provider);
    const config: Record<string, unknown> = { ...(existing?.config ?? {}), ...tokens.config };
    // Jira: with exactly one accessible site the cloudId needs no human choice.
    if (provider === 'jira' && !config.cloudId) {
      const site = await resolveSingleJiraSite(tokens.accessToken, targetFetchOpts());
      if (site) {
        config.cloudId = site.cloudId;
        if (site.siteUrl) config.siteUrl = site.siteUrl;
      }
    }
    // Everything the refresh worker needs to renew an expiring token. The
    // secret is encrypted at rest by the repository and never leaves the server.
    if (tokens.refreshToken) {
      config.tokenEndpoint = providerCfg.tokenUrl;
      config.clientId = providerCfg.clientId;
      config.clientSecret = providerCfg.clientSecret;
    }
    // The repository encrypts access/refresh tokens with SecretBox before persisting.
    await integrationRepo.upsert(orgId, provider, {
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.tokenExpiresAt ? { tokenExpiresAt: tokens.tokenExpiresAt } : {}),
      config,
    });
    res.redirect(302, dashboardUrl({ connected: provider }));
  });

  // All routes below require authentication
  router.use(authMiddleware);

  // GET /api/v1/integrations — list org integrations (owner/admin only)
  router.get('/', requireOrgAdmin, async (req: Request, res: Response) => {
    const integrations = await integrationRepo.listByOrg(req.user!.orgId);
    res.json({ integrations: integrations.map(toIntegrationDto) });
  });

  // POST /api/v1/integrations/:provider/connect — start OAuth / store tokens
  router.post('/:provider/connect', requireOrgAdmin, async (req: Request, res: Response) => {
    const provider = req.params.provider as string;
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      res.status(400).json({ error: { code: 'VALIDATION', message: `Invalid provider: ${provider}` } });
      return;
    }
    const parsed = ConnectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid body' } });
      return;
    }

    // Admins may also store a token they already hold (e.g. a Slack bot token).
    if (parsed.data.accessToken) {
      const integration = await integrationRepo.upsert(req.user!.orgId, provider, {
        accessToken: parsed.data.accessToken,
        refreshToken: parsed.data.refreshToken,
        config: parsed.data.config ?? {},
      });
      res.status(201).json({ integration: { id: integration.id, provider, enabled: integration.enabled } });
      return;
    }

    const providerCfg = deps.oauthProviders?.[provider];
    if (!providerCfg) {
      res.status(501).json({ error: { code: 'INTEGRATION_NOT_CONFIGURED', message: `OAuth for ${provider} is not configured on this server. Set INTEGRATION_${provider.toUpperCase()}_CLIENT_ID/_CLIENT_SECRET (see docs/INTEGRATIONS_SETUP.md).` } });
      return;
    }

    // State bound to this admin + org + provider with a signed expiry.
    const state = randomBytes(16).toString('hex');
    const exp = Date.now() + OAUTH_STATE_TTL_MS;
    const uid = req.user!.userId;
    const sigPayload = `${state}.${req.user!.orgId}.${provider}.${uid}.${exp}`;
    const sig = createHmac('sha256', oauthStateSecret)
      .update(sigPayload)
      .digest('hex');
    res.cookie('integration_oauth_state', JSON.stringify({ state, orgId: req.user!.orgId, provider, uid, exp, sig }), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: OAUTH_STATE_TTL_MS,
      // Secure unless this is the plain-HTTP loopback stack (COOKIE_INSECURE).
      secure: !deps.cookieInsecure,
    });
    res.json({ redirectUrl: buildAuthorizeUrl(providerCfg, { state, redirectUri: redirectUriFor(provider) }) });
  });

  // GET /api/v1/integrations/:provider/targets — what the stored token can deliver to
  router.get('/:provider/targets', requireOrgAdmin, async (req: Request, res: Response) => {
    const provider = req.params.provider as string;
    if (!isTargetProvider(provider)) {
      res.status(400).json({ error: { code: 'VALIDATION', message: `${provider} has no delivery targets` } });
      return;
    }
    const integration = await integrationRepo.findByOrgAndProvider(req.user!.orgId, provider);
    if (!integration) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Integration not found' } });
      return;
    }
    if (!integration.enabled || !integration.accessToken) {
      res.status(409).json({ error: { code: 'INTEGRATION_NOT_CONNECTED', message: `${provider} is not connected` } });
      return;
    }
    try {
      const targets = await listTargets(provider, integration.accessToken, targetFetchOpts());
      res.json({ targets });
    } catch (e) {
      const message = e instanceof TargetsFetchError ? e.message : 'Could not load targets from the provider.';
      res.status(502).json({ error: { code: 'PROVIDER_ERROR', message } });
    }
  });

  // PATCH /api/v1/integrations/:provider — save the delivery target (merged into config)
  router.patch('/:provider', requireOrgAdmin, async (req: Request, res: Response) => {
    const provider = req.params.provider as string;
    if (!isTargetProvider(provider)) {
      res.status(400).json({ error: { code: 'VALIDATION', message: `${provider} has no delivery targets` } });
      return;
    }
    const body = z.object({ config: z.unknown() }).safeParse(req.body ?? {});
    const parsed = body.success ? TARGET_CONFIG_SCHEMAS[provider].safeParse(body.data.config) : null;
    if (!parsed || !parsed.success) {
      res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'Invalid config',
          details: parsed && !parsed.success ? parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) : undefined,
        },
      });
      return;
    }
    const existing = await integrationRepo.findByOrgAndProvider(req.user!.orgId, provider);
    if (!existing) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Integration not found' } });
      return;
    }
    // upsert() rewrites every column, so carry the (decrypted) credentials through.
    const updated = await integrationRepo.upsert(req.user!.orgId, provider, {
      accessToken: existing.accessToken,
      ...(existing.refreshToken ? { refreshToken: existing.refreshToken } : {}),
      ...(existing.tokenExpiresAt ? { tokenExpiresAt: existing.tokenExpiresAt } : {}),
      enabled: existing.enabled,
      config: { ...existing.config, ...parsed.data },
    });
    res.json({ integration: toIntegrationDto(updated) });
  });

  // DELETE /api/v1/integrations/:provider — disconnect
  router.delete('/:provider', requireOrgAdmin, async (req: Request, res: Response) => {
    const provider = req.params.provider as string;
    const deleted = await integrationRepo.delete(req.user!.orgId, provider);
    if (!deleted) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Integration not found' } });
      return;
    }
    res.status(204).end();
  });

  // POST /api/v1/integrations/:provider/test — test connection
  router.post('/:provider/test', requireOrgAdmin, async (req: Request, res: Response) => {
    const provider = req.params.provider as string;
    const integration = await integrationRepo.findByOrgAndProvider(req.user!.orgId, provider);
    if (!integration) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Integration not found' } });
      return;
    }
    // Placeholder: in production, make a test API call to the provider
    res.json({ status: 'ok', provider, enabled: integration.enabled });
  });

  return router;
}
