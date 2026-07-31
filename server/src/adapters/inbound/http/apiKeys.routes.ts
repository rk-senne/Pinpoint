import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import type { ApiKeyRepo } from '../../../domain/org/ports/ApiKeyRepo.js';
import { validateUuidParam } from './errors.js';
import { recordAudit } from './auditLog.routes.js';

export interface ApiKeyRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  apiKeyRepo: ApiKeyRepo;
  db: Knex;
}

export function createApiKeyRoutes(deps: ApiKeyRouteDeps): Router {
  const router = Router();
  const { authMiddleware, apiKeyRepo, db } = deps;

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

    await recordAudit(db, {
      orgId: req.user!.orgId,
      actorId: req.user!.userId,
      action: 'api_key.created',
      resourceType: 'api_key',
      resourceId: apiKey.id,
      metadata: { name, keyPrefix },
    });

    // Return raw key ONLY on creation — never stored or shown again
    res.status(201).json({ ...apiKey, rawKey });
  });

  // GET /api/v1/api-keys — list org's API keys
  router.get('/', authMiddleware, async (req: Request, res: Response) => {
    const keys = await apiKeyRepo.listByOrg(req.user!.orgId);
    res.json({
      data: keys,
      pagination: { page: 1, pageSize: keys.length, total: keys.length, totalPages: 1 },
    });
  });

  // DELETE /api/v1/api-keys/:id — revoke key (owner/admin only)
  router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
    if (req.user!.role !== 'owner' && req.user!.role !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions.' } });
    }
    if (!validateUuidParam(res, 'id', req.params.id as string)) return;
    await apiKeyRepo.revoke(req.params.id as string);
    await recordAudit(db, {
      orgId: req.user!.orgId,
      actorId: req.user!.userId,
      action: 'api_key.revoked',
      resourceType: 'api_key',
      resourceId: req.params.id as string,
    });
    res.status(204).end();
  });

  return router;
}
