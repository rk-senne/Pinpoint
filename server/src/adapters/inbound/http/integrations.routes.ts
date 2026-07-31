import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { IntegrationRepo } from '../../../domain/integration/ports/IntegrationRepo.js';

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
  config: z.record(z.unknown()).optional(),
});

export function createIntegrationsRoutes(deps: IntegrationsRouteDeps): Router {
  const { authMiddleware, integrationRepo, oauthStateSecret } = deps;
  const router = Router();

  // GET /api/v1/integrations/:provider/callback — handle OAuth callback
  // This route is NOT behind authMiddleware because OAuth providers redirect
  // unauthenticated users here. The orgId is derived from a cryptographically-
  // bound state cookie set during the connect flow (NOT from the query param).
  router.get('/:provider/callback', async (req: Request, res: Response) => {
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

    let stateCookie: { state: string; orgId: string; provider: string; sig?: string } | null = null;
    if (typeof raw === 'string') {
      try { stateCookie = JSON.parse(raw); } catch { stateCookie = null; }
    }

    // Validate: cookie exists, random state matches, provider matches
    if (!stateCookie || state !== stateCookie.state || provider !== stateCookie.provider) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid or expired OAuth state' } });
      return;
    }

    // Verify HMAC integrity of the cookie payload
    const expectedPayload = `${stateCookie.state}.${stateCookie.orgId}.${stateCookie.provider}`;
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

  // GET /api/v1/integrations — list org integrations
  router.get('/', async (req: Request, res: Response) => {
    const integrations = await integrationRepo.listByOrg(req.user!.orgId);
    // Strip access tokens from listing
    res.json({
      integrations: integrations.map(({ accessToken, refreshToken, ...rest }) => rest),
    });
  });

  // POST /api/v1/integrations/:provider/connect — start OAuth / store tokens
  router.post('/:provider/connect', async (req: Request, res: Response) => {
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
    const sigPayload = `${state}.${req.user!.orgId}.${provider}`;
    const sig = createHmac('sha256', oauthStateSecret)
      .update(sigPayload)
      .digest('hex');
    res.cookie('integration_oauth_state', JSON.stringify({ state, orgId: req.user!.orgId, provider, sig }), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 600_000, // 10 minutes
      secure: process.env.NODE_ENV === 'production',
    });
    const redirectUrl = `https://${provider}.example.com/oauth/authorize?client_id=PLACEHOLDER&state=${state}`;
    res.json({ redirectUrl });
  });

  // DELETE /api/v1/integrations/:provider — disconnect
  router.delete('/:provider', async (req: Request, res: Response) => {
    const provider = req.params.provider as string;
    const deleted = await integrationRepo.delete(req.user!.orgId, provider);
    if (!deleted) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Integration not found' } });
      return;
    }
    res.status(204).end();
  });

  // POST /api/v1/integrations/:provider/test — test connection
  router.post('/:provider/test', async (req: Request, res: Response) => {
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
