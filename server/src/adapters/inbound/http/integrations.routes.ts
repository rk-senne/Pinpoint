import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Integration, IntegrationRepo } from '../../../domain/integration/ports/IntegrationRepo.js';
import { requireOrgAdmin } from './access.js';

/** Lifetime of the OAuth state cookie, enforced server-side via the signed `exp`. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const PROVIDERS = ['slack', 'jira', 'linear', 'github'] as const;

/** Constant-time string comparison (prevents timing attacks on HMAC). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export interface IntegrationsRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  integrationRepo: IntegrationRepo;
  oauthStateSecret: string;
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
  const router = Router();

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

    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
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

    const integration = await integrationRepo.upsert(orgId, provider, {
      accessToken: `exchanged_${code}`,
      config: {},
    });
    res.json({ integration: { id: integration.id, provider, enabled: integration.enabled } });
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

    // Placeholder: in production, this would generate an OAuth redirect URL.
    // For now, if tokens are provided, store them directly.
    if (parsed.data.accessToken) {
      const integration = await integrationRepo.upsert(req.user!.orgId, provider, {
        accessToken: parsed.data.accessToken,
        refreshToken: parsed.data.refreshToken,
        config: parsed.data.config ?? {},
      });
      res.status(201).json({ integration: { id: integration.id, provider, enabled: integration.enabled } });
      return;
    }

    // Return placeholder redirect URL with cryptographically-bound state
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
      // Always Secure (PP-21): browsers accept it on http://localhost too.
      secure: true,
    });
    const redirectUrl = `https://${provider}.example.com/oauth/authorize?client_id=PLACEHOLDER&state=${state}`;
    res.json({ redirectUrl });
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
