import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import type { ApiKeyRepo } from '../../../domain/org/ports/ApiKeyRepo.js';

export interface ApiKeyRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  apiKeyRepo: ApiKeyRepo;
}

export function createApiKeyRoutes(deps: ApiKeyRouteDeps): Router {
  const router = Router();
  const { authMiddleware, apiKeyRepo } = deps;

  // POST /api/v1/api-keys — create new API key (owner/admin only)
  router.post('/', authMiddleware, async (req: Request, res: Response) => {
    if (req.user!.role !== 'owner' && req.user!.role !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions.' } });
    }

    const { name, scopes } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'name is required.' } });
    }

    const rawKey = `pk_${randomBytes(32).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 11); // "pk_" + 8 hex chars

    const apiKey = await apiKeyRepo.insert({
      orgId: req.user!.orgId,
      name,
      keyHash,
      keyPrefix,
      scopes: scopes ?? ['feedback:read', 'feedback:write'],
      createdBy: req.user!.userId,
    });

    // Return raw key ONLY on creation — never stored or shown again
    res.status(201).json({ ...apiKey, rawKey });
  });

  // GET /api/v1/api-keys — list org's API keys
  router.get('/', authMiddleware, async (req: Request, res: Response) => {
    const keys = await apiKeyRepo.listByOrg(req.user!.orgId);
    res.json({ keys });
  });

  // DELETE /api/v1/api-keys/:id — revoke key (owner/admin only)
  router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
    if (req.user!.role !== 'owner' && req.user!.role !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions.' } });
    }
    await apiKeyRepo.revoke(req.params.id);
    res.status(204).end();
  });

  return router;
}
