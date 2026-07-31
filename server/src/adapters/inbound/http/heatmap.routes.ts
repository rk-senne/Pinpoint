import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';

import { bucketIntoHeatmapCells, type HeatmapInput } from './heatmap.utils.js';

const HeatmapQuerySchema = z.object({
  pageUrl: z.string().url().optional(),
});

export interface HeatmapRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

export function createHeatmapRoutes(deps: HeatmapRouteDeps): Router {
  const { authMiddleware, db } = deps;
  const router = Router();
  router.use(authMiddleware);

  // GET /api/v1/projects/:id/heatmap — feedback density by page coordinates
  router.get('/:projectId/heatmap', async (req: Request, res: Response) => {
    const { projectId } = req.params;
    const queryParsed = HeatmapQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'pageUrl must be a valid URL' } });
      return;
    }
    const { pageUrl } = queryParsed.data;

    const query = db('annotations')
      .where({ project_id: projectId, org_id: req.user!.orgId })
      .whereNotNull('target');

    // BUG 2 FIX: filter by page_id via the pages table (sub-query)
    // instead of the broken environment->>'url' which never existed.
    if (pageUrl) {
      query.whereIn('page_id',
        db('pages').select('id').where({ project_id: projectId, url: pageUrl })
      );
    }

    // AC-7: only select the columns we need (target for coords, severity for breakdown)
    const annotations = await query.select('target', 'severity');

    // Aggregate pin positions into grid cells (50x50px buckets)
    const CELL_SIZE = 50;

    // Parse rows into HeatmapInput[], skipping those with missing/non-numeric coords
    const inputs: HeatmapInput[] = [];
    for (const a of annotations) {
      const target = typeof a.target === 'string' ? JSON.parse(a.target) : a.target;
      // BUG 1 FIX: read pageX/pageY (the actual DOMTarget fields)
      // instead of the non-existent coordinates.x / target.x
      const x = target?.pageX;
      const y = target?.pageY;
      if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) continue;
      inputs.push({ pageX: x, pageY: y, severity: a.severity });
    }

    // TODO(perf): Postgres-pending SQL aggregate — validate against real DB.
    // A GROUP BY on floor((target->>'pageX')::numeric / cellSize) would avoid
    // transferring full JSONB rows to Node. Keep the pure bucketIntoHeatmapCells
    // function as the tested source of truth until the SQL is verified.
    const cells = bucketIntoHeatmapCells(inputs, CELL_SIZE);

    res.json({
      cellSize: CELL_SIZE,
      totalAnnotations: inputs.length,
      cells,
    });
  });

  return router;
}
