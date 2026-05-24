// Inbound HTTP adapter — guideline routes (Phase 1.5 / task 4.9.1).
//
// Mounted at `/api/v1/guidelines`. Returns the heuristic catalogue
// (defaults seeded by the composition root before mounting) and lets
// authenticated users author additional custom guidelines.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { ListGuidelines } from '../../../domain/guideline/usecases/listGuidelines.js';
import type { CreateCustomGuideline } from '../../../domain/guideline/usecases/createCustomGuideline.js';
import type { Guideline } from '../../../domain/guideline/Guideline.js';
import { sendDomainError, sendZodFailure } from './errors.js';

export interface GuidelinesRouteDeps {
  listGuidelines: ListGuidelines;
  createCustomGuideline: CreateCustomGuideline;
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
}

const CreateGuidelineBodySchema = z.object({
  name: z.string().trim().min(1, 'Guideline name is required.'),
  description: z.string().trim().min(1, 'Guideline description is required.'),
});

function format(g: Guideline): Record<string, unknown> {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    isDefault: g.isDefault,
    createdByUserId: g.createdByUserId ?? null,
  };
}

export function createGuidelinesRoutes(deps: GuidelinesRouteDeps): Router {
  const { listGuidelines, createCustomGuideline, authMiddleware } = deps;

  const router = Router();
  router.use(authMiddleware);

  router.get('/', async (_req: Request, res: Response) => {
    const result = await listGuidelines.execute();
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(200).json({ guidelines: result.value.map(format) });
  });

  router.post('/', async (req: Request, res: Response) => {
    const parsed = CreateGuidelineBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid guideline payload.', parsed.error.flatten());
      return;
    }
    const result = await createCustomGuideline.execute({
      userId: req.user!.userId,
      name: parsed.data.name,
      description: parsed.data.description,
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    res.status(201).json({ guideline: format(result.value) });
  });

  return router;
}
