import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import type { ApiKeyRepo } from '../../../domain/org/ports/ApiKeyRepo.js';
import { validateUuidParam } from './errors.js';
import { z } from 'zod';
import { recordAudit, auditApiKeyContext } from './auditLog.routes.js';
import { registerSessionDb, requireOrgAdmin } from './access.js';

/** The only scopes a standard key may carry; anything else is rejected. */
export const API_KEY_SCOPES = ['feedback:read', 'feedback:write'] as const;
const ScopesSchema = z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length);

export interface ApiKeyRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  apiKeyRepo: ApiKeyRepo;
  db: Knex;
}

export function createApiKeyRoutes(deps: ApiKeyRouteDeps): Router {
  const router = Router();
  const { authMiddleware, apiKeyRepo, db } = deps;
  registerSessionDb(db);

  // POST /api/v1/api-keys — create new API key (owner/admin only)
  router.post('/', authMiddleware, async (req: Request, res: Response) => {
    if (req.user!.role !== 'owner' && req.user!.role !== 'admin') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions.' } });
    }

    const { name, scopes, keyType, projectId, allowedOrigins, dailyQuota } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'name is required.' } });
    }

    const isWidget = keyType === 'widget';

    // Validate requested scopes (standard keys only). Unknown scopes are an
    // error, never silently stored.
    let standardScopes: string[] = [...API_KEY_SCOPES];
    if (!isWidget && scopes !== undefined) {
      const parsedScopes = ScopesSchema.safeParse(scopes);
      if (!parsedScopes.success) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION',
            message: `scopes must be a non-empty subset of: ${API_KEY_SCOPES.join(', ')}.`,
          },
        });
      }
      standardScopes = Array.from(new Set(parsedScopes.data));
    }

    // Widget keys are project-bound submission credentials (Mission A1).
    // They require a project_id that belongs to the caller's org, always
    // carry the 'widget' scope, and are prefixed `pk_widget_` so they can be
    // rejected if ever presented as a Bearer credential.
    if (isWidget) {
      if (!projectId || typeof projectId !== 'string') {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'projectId is required for widget keys.' } });
      }
      const project = await db('projects').where({ id: projectId, org_id: req.user!.orgId }).first();
      if (!project) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found.' } });
      }
      if (allowedOrigins !== undefined && !Array.isArray(allowedOrigins)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'allowedOrigins must be an array of origins.' } });
      }
      if (dailyQuota !== undefined && (typeof dailyQuota !== 'number' || dailyQuota <= 0)) {
        return res.status(400).json({ error: { code: 'VALIDATION', message: 'dailyQuota must be a positive number.' } });
      }
    }

    const rawKey = isWidget
      ? `pk_widget_${randomBytes(32).toString('hex')}`
      : `pk_${randomBytes(32).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    // Identifying prefix shown in the UI: type marker + first 8 hex chars
    // (`pk_widget_1a2b3c4d` / `pk_1a2b3c4d`). Never enough to reconstruct the key.
    const keyPrefix = rawKey.slice(0, (isWidget ? 'pk_widget_' : 'pk_').length + 8);

    const apiKey = await apiKeyRepo.insert({
      orgId: req.user!.orgId,
      name,
      keyHash,
      keyPrefix,
      scopes: isWidget ? ['widget'] : standardScopes,
      createdBy: req.user!.userId,
      keyType: isWidget ? 'widget' : 'standard',
      projectId: isWidget ? projectId : null,
      allowedOrigins: isWidget ? (allowedOrigins ?? []) : [],
      dailyQuota: isWidget ? (dailyQuota ?? null) : null,
    });

    await recordAudit(db, {
      orgId: req.user!.orgId,
      actorId: req.user!.userId,
      action: 'api_key.created',
      resourceType: 'api_key',
      resourceId: apiKey.id,
      metadata: { name, keyPrefix, keyType: isWidget ? 'widget' : 'standard', ...(isWidget ? {} : { scopes: standardScopes }) },
      ...auditApiKeyContext(req),
    });

    // Return raw key ONLY on creation — never stored or shown again
    res.status(201).json({ ...apiKey, rawKey });
  });

  // GET /api/v1/api-keys — list org's API keys
  router.get('/', authMiddleware, requireOrgAdmin, async (req: Request, res: Response) => {
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

    // Verify the API key belongs to the caller's org (cross-tenant IDOR fix)
    const key = await db('api_keys').where({ id: req.params.id, org_id: req.user!.orgId }).first();
    if (!key) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API key not found.' } });
    }

    await apiKeyRepo.revoke(req.params.id as string);
    await recordAudit(db, {
      orgId: req.user!.orgId,
      actorId: req.user!.userId,
      action: 'api_key.revoked',
      resourceType: 'api_key',
      resourceId: req.params.id as string,
      ...auditApiKeyContext(req),
    });
    res.status(204).end();
  });

  return router;
}
