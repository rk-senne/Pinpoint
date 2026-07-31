import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';

const BulkActionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(['resolve', 'activate', 'in_progress', 'delete', 'assign']),
  params: z.object({
    assigneeId: z.string().uuid().optional(),
  }).optional(),
});

export interface BulkRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

export function createBulkRoutes(deps: BulkRouteDeps): Router {
  const { authMiddleware, db } = deps;
  const router = Router({ mergeParams: true });

  router.post('/:id/annotations/bulk', authMiddleware, async (req: Request, res: Response) => {
    const parsed = BulkActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Validation failed', details: { issues: parsed.error.flatten().fieldErrors } } });
    }
    const { ids, action, params } = parsed.data;
    const projectId = req.params.id;

    // Verify project belongs to the caller's org (prevent cross-tenant IDOR)
    const project = await db('projects').where({ id: projectId, org_id: req.user!.orgId }).first();
    if (!project) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found.', details: {} } });
    }

    // Verify all annotations belong to this project
    const annotations = await db('annotations').whereIn('id', ids).andWhere({ project_id: projectId });
    if (annotations.length !== ids.length) {
      return res.status(400).json({ error: { code: 'INVALID_IDS', message: 'Some annotation IDs do not belong to this project', details: {} } });
    }

    switch (action) {
      case 'resolve':
      case 'activate':
      case 'in_progress':
        await db('annotations').whereIn('id', ids).update({ status: action === 'activate' ? 'active' : action, updated_at: db.fn.now() });
        break;
      case 'delete':
        await db('annotations').whereIn('id', ids).delete();
        break;
      case 'assign':
        if (!params?.assigneeId) {
          return res.status(400).json({ error: { code: 'VALIDATION', message: 'assigneeId required for assign action', details: {} } });
        }
        await db('annotations').whereIn('id', ids).update({ assignee_id: params.assigneeId, updated_at: db.fn.now() });
        break;
    }

    res.json({ affected: ids.length, action });
  });

  return router;
}
