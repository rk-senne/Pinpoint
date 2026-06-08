import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Knex } from 'knex';

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
    const { pageUrl } = req.query;

    const query = db('annotations')
      .where({ project_id: projectId, org_id: req.user!.orgId })
      .whereNotNull('target');

    if (pageUrl) {
      query.whereRaw("environment->>'url' = ?", [pageUrl]);
    }

    const annotations = await query.select('target', 'severity', 'status');

    // Aggregate pin positions into grid cells (50x50px buckets)
    const CELL_SIZE = 50;
    const grid = new Map<string, { count: number; severities: Record<string, number> }>();

    for (const a of annotations) {
      const target = typeof a.target === 'string' ? JSON.parse(a.target) : a.target;
      const x = target?.coordinates?.x ?? target?.x;
      const y = target?.coordinates?.y ?? target?.y;
      if (x == null || y == null) continue;

      const cellX = Math.floor(x / CELL_SIZE);
      const cellY = Math.floor(y / CELL_SIZE);
      const key = `${cellX}:${cellY}`;

      if (!grid.has(key)) grid.set(key, { count: 0, severities: {} });
      const cell = grid.get(key)!;
      cell.count++;
      cell.severities[a.severity] = (cell.severities[a.severity] ?? 0) + 1;
    }

    const heatmapData = Array.from(grid.entries()).map(([key, data]) => {
      const [cx, cy] = key.split(':').map(Number);
      return { x: cx! * CELL_SIZE, y: cy! * CELL_SIZE, ...data };
    });

    res.json({
      cellSize: CELL_SIZE,
      totalAnnotations: annotations.length,
      cells: heatmapData.sort((a, b) => b.count - a.count),
    });
  });

  return router;
}
