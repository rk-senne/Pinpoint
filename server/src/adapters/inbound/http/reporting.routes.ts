import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Knex } from 'knex';

export interface ReportingRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

export function createReportingRoutes(deps: ReportingRouteDeps): Router {
  const { authMiddleware, db } = deps;
  const router = Router();
  router.use(authMiddleware);

  // GET /api/v1/reports/overview — key metrics for the org
  router.get('/overview', async (req: Request, res: Response) => {
    const orgId = req.user!.orgId;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [volume, resolved, avgResolution, teamActivity] = await Promise.all([
      // Feedback volume (last 30 days, grouped by day)
      db('annotations')
        .select(db.raw("DATE(created_at) as date, COUNT(*) as count"))
        .where('org_id', orgId)
        .where('created_at', '>=', thirtyDaysAgo)
        .groupByRaw('DATE(created_at)')
        .orderBy('date'),

      // Resolution rate
      db('annotations')
        .where('org_id', orgId)
        .where('created_at', '>=', thirtyDaysAgo)
        .select(
          db.raw("COUNT(*) as total"),
          db.raw("COUNT(*) FILTER (WHERE status = 'resolved') as resolved"),
        )
        .first(),

      // Average resolution time (hours)
      db('annotations')
        .where('org_id', orgId)
        .where('status', 'resolved')
        .whereNotNull('updated_at')
        .where('created_at', '>=', thirtyDaysAgo)
        .select(
          db.raw("AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600) as avg_hours"),
        )
        .first(),

      // Team activity (comments + annotations per member, last 30 days)
      db.raw(`
        SELECT u.id as user_id, u.email,
          COALESCE(a.annotation_count, 0) as annotations,
          COALESCE(c.comment_count, 0) as comments
        FROM users u
        JOIN memberships m ON m.user_id = u.id AND m.org_id = ?
        LEFT JOIN (
          SELECT author_id, COUNT(*) as annotation_count
          FROM annotations WHERE org_id = ? AND created_at >= ?
          GROUP BY author_id
        ) a ON a.author_id = u.id
        LEFT JOIN (
          SELECT author_id, COUNT(*) as comment_count
          FROM comments WHERE org_id = ? AND created_at >= ?
          GROUP BY author_id
        ) c ON c.author_id = u.id
        ORDER BY (COALESCE(a.annotation_count, 0) + COALESCE(c.comment_count, 0)) DESC
        LIMIT 20
      `, [orgId, orgId, thirtyDaysAgo, orgId, thirtyDaysAgo]),
    ]);

    res.json({
      volume: volume ?? [],
      resolution: {
        total: resolved?.total ?? 0,
        resolved: resolved?.resolved ?? 0,
        rate: resolved?.total ? Math.round((resolved.resolved / resolved.total) * 100) : 0,
        avgHours: avgResolution?.avg_hours ? Math.round(avgResolution.avg_hours * 10) / 10 : null,
      },
      teamActivity: teamActivity?.rows ?? [],
    });
  });

  return router;
}
