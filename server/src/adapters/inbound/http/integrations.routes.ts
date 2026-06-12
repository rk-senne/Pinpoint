import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { IntegrationRepo } from '../../../domain/integration/ports/IntegrationRepo.js';

const PROVIDERS = ['slack', 'jira', 'linear', 'github'] as const;

export interface IntegrationsRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  integrationRepo: IntegrationRepo;
}

const ConnectSchema = z.object({
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  config: z.record(z.unknown()).optional(),
});

export function createIntegrationsRoutes(deps: IntegrationsRouteDeps): Router {
  const { authMiddleware, integrationRepo } = deps;
  const router = Router();
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
    const provider = req.params.provider;
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

    // Return placeholder redirect URL
    const redirectUrl = `https://${provider}.example.com/oauth/authorize?client_id=PLACEHOLDER&state=${req.user!.orgId}`;
    res.json({ redirectUrl });
  });

  // GET /api/v1/integrations/:provider/callback — handle OAuth callback
  router.get('/:provider/callback', async (req: Request, res: Response) => {
    const provider = req.params.provider;
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      res.status(400).json({ error: { code: 'VALIDATION', message: `Invalid provider: ${provider}` } });
      return;
    }

    // Placeholder: in production, exchange code for tokens
    const code = req.query.code as string | undefined;
    if (!code) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'Missing code parameter' } });
      return;
    }

    const integration = await integrationRepo.upsert(req.user!.orgId, provider, {
      accessToken: `exchanged_${code}`,
      config: {},
    });
    res.json({ integration: { id: integration.id, provider, enabled: integration.enabled } });
  });

  // DELETE /api/v1/integrations/:provider — disconnect
  router.delete('/:provider', async (req: Request, res: Response) => {
    const provider = req.params.provider;
    const deleted = await integrationRepo.delete(req.user!.orgId, provider);
    if (!deleted) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Integration not found' } });
      return;
    }
    res.status(204).end();
  });

  // POST /api/v1/integrations/:provider/test — test connection
  router.post('/:provider/test', async (req: Request, res: Response) => {
    const provider = req.params.provider;
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
