import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';

import {
  buildHeatmapAggregateSql,
  mapAggregateRows,
  type HeatmapAggregateRow,
} from './heatmap.utils.js';
import { registerSessionDb, requireProjectAccess } from './access.js';

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
  registerSessionDb(db);

  // GET /api/v1/projects/:id/heatmap — feedback density by page coordinates
  router.get('/:projectId/heatmap', requireProjectAccess(db, 'projectId'), async (req: Request, res: Response) => {
    const projectId = String(req.params.projectId);
    const queryParsed = HeatmapQuerySchema.safeParse(req.query);
    if (!queryParsed.success) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'pageUrl must be a valid URL' } });
      return;
    }
    const { pageUrl } = queryParsed.data;

    // Aggregate pin positions into grid cells (50x50px buckets).
    const CELL_SIZE = 50;

    // Resolve the pageUrl (if any) to the page ids for this project. Keeping
    // this resolution in the route preserves the existing sub-query shape;
    // `null` means "no pageUrl filter", `[]` means "resolved to zero pages".
    let pageIds: string[] | null = null;
    if (pageUrl) {
      const pages = await db('pages')
        .select('id')
        .where({ project_id: projectId, url: pageUrl });
      pageIds = pages.map((p: { id: string }) => p.id);
    }

    // GAP 6: density is computed by Postgres via
    // `GROUP BY floor((target->>'pageX')::numeric / :cell), floor(...pageY...)`
    // instead of streaming every JSONB row into Node. Rows with missing or
    // non-numeric coordinates are excluded by the same finite-numeric guard
    // the pure `bucketIntoHeatmapCells` oracle applies. The builder is unit-
    // and parity-tested in heatmap.utils.test.ts, and run against a real DB in
    // heatmap.sqlAggregate.integration.test.ts.
    const { sql, bindings } = buildHeatmapAggregateSql({
      projectId: projectId!,
      orgId: req.user!.orgId,
      cellSize: CELL_SIZE,
      pageIds,
    });

    // nosemgrep: javascript.lang.security.audit.sqli.node-knex-sqli.node-knex-sqli -- `sql` comes from buildHeatmapAggregateSql(): every value is a positional `?` binding; only placeholder counts are interpolated (see heatmap.utils.test.ts)
    const result = await db.raw(sql, bindings);
    const rows: HeatmapAggregateRow[] = result.rows ?? [];
    const cells = mapAggregateRows(rows);
    const totalAnnotations = cells.reduce((sum, c) => sum + c.count, 0);

    res.json({
      cellSize: CELL_SIZE,
      totalAnnotations,
      cells,
    });
  });

  return router;
}
