// Inbound HTTP adapter — AI feedback triage route.
//
// Mounted at `/api/v1/projects`, exposing:
//   POST /api/v1/projects/:id/annotations/triage
//
// Read-only and additive: given draft feedback text (and optionally its DOM
// target), it returns triage *suggestions* — a severity guess, topical tags,
// likely-duplicate open annotations, and a suggested assignee. It never
// creates or mutates an annotation, so it is safe to call speculatively from
// the extension popover or dashboard as the reporter types.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';

import { createTriageService } from '../../../services/triage.js';

const TriageRequestSchema = z.object({
  body: z.string().min(1).max(5000),
  target: z
    .object({ cssSelector: z.string().max(2000).optional() })
    .optional(),
  excludeId: z.string().uuid().optional(),
});

export interface TriageRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

export function createTriageRoutes(deps: TriageRouteDeps): Router {
  const { authMiddleware, db } = deps;
  const router = Router({ mergeParams: true });
  const service = createTriageService(db);

  // POST /api/v1/projects/:id/annotations/triage
  router.post('/:id/annotations/triage', authMiddleware, async (req: Request, res: Response) => {
    const parsed = TriageRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'Validation failed',
          details: { issues: parsed.error.flatten().fieldErrors },
        },
      });
    }

    const projectId = String(req.params.id);

    // Verify project belongs to the caller's org (prevent cross-tenant IDOR)
    const project = await db('projects').where({ id: projectId, org_id: req.user!.orgId }).first();
    if (!project) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found.', details: {} } });
    }

    const result = await service.triage(projectId, parsed.data);
    return res.json(result);
  });

  return router;
}
