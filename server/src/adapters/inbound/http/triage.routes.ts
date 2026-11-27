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
import { sendZodFailure } from './errors.js';
import { registerSessionDb, requireProjectAccess } from './access.js';

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
  registerSessionDb(db);

  // POST /api/v1/projects/:id/annotations/triage
  router.post('/:id/annotations/triage', authMiddleware, requireProjectAccess(db), async (req: Request, res: Response) => {
    const parsed = TriageRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendZodFailure(res, 'Validation failed', parsed.error.flatten());
    }

    const projectId = String(req.params.id);

    const result = await service.triage(projectId, parsed.data);
    return res.json(result);
  });

  return router;
}
