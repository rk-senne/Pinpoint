import { setCurrentOrg } from '../infrastructure/tenantContext.js';
import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { ApiKeyRepo } from '../domain/org/ports/ApiKeyRepo.js';

export interface ApiKeyMiddlewareDeps {
  apiKeyRepo: ApiKeyRepo;
}

/**
 * Middleware that authenticates via API key (Bearer pk_...).
 * Falls through to next middleware if not an API key format,
 * allowing JWT auth to handle it instead.
 */
export function createApiKeyMiddleware(deps: ApiKeyMiddlewareDeps) {
  const { apiKeyRepo } = deps;

  return async function apiKeyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer pk_')) {
      // Not an API key — let JWT middleware handle it
      next();
      return;
    }

    const rawKey = header.slice(7).trim();

    // Widget keys (`pk_widget_...`) are project-scoped submission keys for the
    // public /api/v1/widget/* surface only. They are never valid as a Bearer
    // credential for the authenticated API — reject before any DB lookup so a
    // leaked widget key can't be escalated into a dashboard session (A1).
    if (rawKey.startsWith('pk_widget_')) {
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Widget keys cannot be used as Bearer credentials.',
        },
      });
      return;
    }

    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    const apiKey = await apiKeyRepo.findByHash(keyHash);
    if (!apiKey || apiKey.keyType === 'widget') {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key.' } });
      return;
    }

    // Set req.user from API key context
    req.user = {
      userId: apiKey.createdBy,
      email: '',
      orgId: apiKey.orgId,
      role: 'api_key',
    };
    (req as any).apiKey = apiKey;
    // PP-08: RLS tenant context follows the verified key's org.
    setCurrentOrg(apiKey.orgId);

    // Fire-and-forget last_used_at update
    apiKeyRepo.updateLastUsed(apiKey.id).catch(() => {});

    next();
  };
}
