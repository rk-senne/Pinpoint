// Inbound HTTP adapter — guideline routes (Phase 1.5 / task 4.9.1).
//
// Mounted at `/api/v1/guidelines`. Returns the heuristic catalogue
// (Nielsen's 10 defaults are seeded once at server boot by the
// composition root's `start()` via `GuidelineRepo.hasDefaults()` /
// `insertMany(DEFAULT_GUIDELINES)` — GAP 1) and lets authenticated users
// author additional custom guidelines.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { PaginationParamsSchema, paginationMeta } from '@pinpoint/shared';

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
  name: z.string().trim().min(1, 'Guideline name is required.').max(255),
  description: z.string().trim().min(1, 'Guideline description is required.').max(5000),
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

  router.get('/', async (req: Request, res: Response) => {
    const { page, pageSize } = PaginationParamsSchema.parse(req.query);
    const result = await listGuidelines.execute({ orgId: req.user!.orgId });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    // The catalogue is small and lives in memory, so paginate the
    // formatted array here to emit the shared `{ data, pagination }`
    // envelope (GAP 3) without a second data source.
    const all = result.value.map(format);
    const total = all.length;
    const start = (page - 1) * pageSize;
    const data = all.slice(start, start + pageSize);
    res.status(200).json({ data, pagination: paginationMeta(total, page, pageSize) });
  });

  router.post('/', async (req: Request, res: Response) => {
    const parsed = CreateGuidelineBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid guideline payload.', parsed.error.flatten());
      return;
    }
    const result = await createCustomGuideline.execute({
      userId: req.user!.userId,
      orgId: req.user!.orgId,
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
