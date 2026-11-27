import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';
import { sendError, sendZodFailure } from './errors.js';
import type { EventBus } from '../../../domain/shared/ports/EventBus.js';
import type { AnnotationRepo } from '../../../domain/annotation/ports/AnnotationRepo.js';
import { emitAnnotationStatusChanged, emitAnnotationUpdated } from './annotationEvents.js';
import { findAccessibleProject, isOrgMember, registerSessionDb, requireOrgAdmin } from './access.js';

const BulkActionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  action: z.enum(['resolve', 'activate', 'in_progress', 'delete', 'assign']),
  params: z.object({
    assigneeId: z.string().uuid().optional(),
  }).optional(),
});

const BULK_ACTION_STATUS = {
  resolve: 'resolved',
  activate: 'active',
  in_progress: 'in_progress',
} as const;

export interface BulkRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
  /** Used with `eventBus` to emit the per-annotation events after a bulk write. */
  annotationRepo?: AnnotationRepo;
  /** When set (with `annotationRepo`), bulk edits emit the same events as single edits. */
  eventBus?: EventBus;
}

export function createBulkRoutes(deps: BulkRouteDeps): Router {
  const { authMiddleware, db, annotationRepo, eventBus } = deps;
  const router = Router({ mergeParams: true });
  registerSessionDb(db);

  // Bulk mutations (including delete) are owner/admin only AND require access
  // to the project (org match + owner/team member).
  router.post('/:id/annotations/bulk', authMiddleware, requireOrgAdmin, async (req: Request, res: Response) => {
    const parsed = BulkActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendZodFailure(res, 'Validation failed', parsed.error.flatten());
    }
    const { ids, action, params } = parsed.data;
    const projectId = String(req.params.id);

    // Org match + owner/team-member access (after cheap body validation).
    if (!(await findAccessibleProject(db, req.user!, projectId))) {
      return sendError(res, 404, 'NOT_FOUND', 'Project not found.');
    }

    // Verify all annotations belong to this project (and org)
    const annotations = await db('annotations').whereIn('id', ids).andWhere({ project_id: projectId, org_id: req.user!.orgId });
    if (annotations.length !== ids.length) {
      return sendError(res, 400, 'INVALID_IDS', 'Some annotation IDs do not belong to this project');
    }

    // Pre-change status per id, so only real transitions emit status_changed.
    const previousStatus = new Map<string, string>(
      (annotations as Array<{ id: string; status: string }>).map((a) => [a.id, a.status]),
    );

    switch (action) {
      case 'resolve':
      case 'activate':
      case 'in_progress':
        // The action verbs are not the stored statuses: `resolve` must write
        // `resolved` (writing the raw verb stored an invalid 'resolve' status
        // that no list/kanban column or analytics bucket understands).
        await db('annotations').whereIn('id', ids).update({ status: BULK_ACTION_STATUS[action], updated_at: db.fn.now() });
        break;
      case 'delete':
        await db('annotations').whereIn('id', ids).delete();
        break;
      case 'assign':
        if (!params?.assigneeId) {
          return sendError(res, 400, 'VALIDATION', 'assigneeId required for assign action');
        }
        // The assignee must be a member of the caller's org.
        if (!(await isOrgMember(db, req.user!.orgId, params.assigneeId))) {
          return sendError(res, 400, 'VALIDATION', 'assigneeId must be a member of your organization');
        }
        await db('annotations').whereIn('id', ids).update({ assignee_id: params.assigneeId, updated_at: db.fn.now() });
        break;
    }


    // Same realtime/webhook events as the single-annotation routes (best-effort,
    // after the write). Deletes have no domain event yet.
    if (eventBus && annotationRepo && action !== 'delete') {
      try {
        const changedBy = req.user!.userId;
        await Promise.all(
          ids.map(async (id) => {
            const after = await annotationRepo.findById(id);
            if (!after) return;
            if (action === 'assign') {
              await emitAnnotationUpdated(eventBus, db, after);
            } else {
              await emitAnnotationStatusChanged(eventBus, db, after, previousStatus.get(id) ?? '', changedBy);
            }
          }),
        );
      } catch {
        // best-effort: the bulk write already succeeded
      }
    }
    res.json({ affected: ids.length, action });
  });

  return router;
}
