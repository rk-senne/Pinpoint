// Inbound HTTP adapter — activity feed routes.
//
// Mounted at `/api/v1/projects/:id/activity`. Returns paginated
// activity events for a project with actor information.

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Knex } from 'knex';
import { PaginationParamsSchema, paginationMeta } from '@pinpoint/shared';

export interface ActivityRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

export function createActivityRoutes(deps: ActivityRouteDeps): Router {
  const { authMiddleware, db } = deps;
  const router = Router({ mergeParams: true });

  // GET /api/v1/projects/:id/activity?page=1&pageSize=25
  router.get('/', authMiddleware, async (req: Request, res: Response) => {
    const projectId = req.params.id;
    const parsed = PaginationParamsSchema.safeParse(req.query);
    const { page, pageSize } = parsed.success ? parsed.data : { page: 1, pageSize: 25 };

    // Verify project belongs to the caller's org (prevent cross-tenant IDOR)
    const project = await db('projects').where({ id: projectId, org_id: req.user!.orgId }).first();
    if (!project) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found.', details: {} } });
    }

    const offset = (page - 1) * pageSize;

    const [{ count: total }] = await db('activity_events')
      .where('project_id', projectId)
      .count('* as count');

    const rows = await db('activity_events')
      .leftJoin('users', 'activity_events.actor_id', 'users.id')
      .where('activity_events.project_id', projectId)
      .select(
        'activity_events.id',
        'activity_events.project_id',
        'activity_events.actor_id',
        'users.name as actor_name',
        'activity_events.action',
        'activity_events.resource_type',
        'activity_events.resource_id',
        'activity_events.metadata',
        'activity_events.created_at',
      )
      .orderBy('activity_events.created_at', 'desc')
      .limit(pageSize)
      .offset(offset);

    const events = rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      actorId: r.actor_id,
      actorName: r.actor_name ?? undefined,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id ?? undefined,
      metadata: r.metadata ?? {},
      createdAt: r.created_at,
    }));

    res.json({
      data: events,
      pagination: paginationMeta(Number(total), page, pageSize),
    });
  });

  return router;
}
