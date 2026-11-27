import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';
import {
  AnnotationStatusSchema,
  AnnotationTypeSchema,
  DOMTargetSchema,
  EnvironmentMetadataSchema,
  SeveritySchema,
} from '@pinpoint/shared';
import type { AnnotationRepo, ListAnnotationsFilter } from '../../../domain/annotation/ports/AnnotationRepo.js';
import type { AnnotationPatch, AnnotationStatus } from '../../../domain/annotation/Annotation.js';
import type { EventBus } from '../../../domain/shared/ports/EventBus.js';
import { createPlanLimitsMiddleware } from '../../../middleware/planLimits.js';
import { sendError, sendZodFailure } from './errors.js';
import {
  findAccessibleAnnotation,
  findAccessibleProject,
  isOrgMember,
  registerSessionDb,
  requireWriteAccess,
} from './access.js';
import { emitAnnotationCreated, emitAnnotationStatusChanged, emitAnnotationUpdated } from './annotationEvents.js';

const CreateFeedbackSchema = z.object({
  projectId: z.string().uuid(),
  pageId: z.string().uuid().optional(),
  type: AnnotationTypeSchema.optional(),
  severity: SeveritySchema.optional(),
  body: z.string().trim().min(1).max(10_000),
  target: DOMTargetSchema,
  environment: EnvironmentMetadataSchema,
});

const UpdateFeedbackSchema = z
  .object({
    body: z.string().trim().min(1).max(10_000).optional(),
    severity: SeveritySchema.optional(),
    status: AnnotationStatusSchema.optional(),
    assigneeId: z.string().uuid().nullable().optional(),
    dueDate: z
      .string()
      .nullable()
      .optional()
      .refine((v) => v === undefined || v === null || !Number.isNaN(Date.parse(v)), {
        message: 'dueDate must be a valid ISO 8601 date string or null.',
      }),
  })
  .strict();

export interface FeedbackRouteDeps {
  /** Combined middleware: tries API key first, falls back to JWT */
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  annotationRepo: AnnotationRepo;
  db: Knex;
  /** When set, writes emit the same realtime/webhook events as the annotation use cases. */
  eventBus?: EventBus;
}

export function createFeedbackRoutes(deps: FeedbackRouteDeps): Router {
  const router = Router();
  const { authMiddleware, annotationRepo, db, eventBus } = deps;
  registerSessionDb(db);

  // GET /api/v1/feedback — paginated, filterable list
  router.get('/', authMiddleware, async (req: Request, res: Response) => {
    const projectId = req.query.projectId as string | undefined;
    if (!projectId) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'projectId query param required.' } });
    }

    // Org match + owner/team-member access (same rule as the use cases).
    if (!(await findAccessibleProject(db, req.user!, projectId))) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found.', details: {} } });
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const filter: ListAnnotationsFilter = {};
    if (req.query.status) {
      const status = AnnotationStatusSchema.safeParse(req.query.status);
      if (!status.success) {
        return sendZodFailure(res, 'Invalid status filter.', status.error.flatten());
      }
      filter.status = status.data as AnnotationStatus;
    }
    filter.limit = limit;
    filter.offset = offset;

    const [annotations, total] = await Promise.all([
      annotationRepo.listByProject(projectId, filter),
      annotationRepo.countByProject(projectId, { status: filter.status }),
    ]);

    res.json({
      data: annotations,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  });

  // GET /api/v1/feedback/:id — single item
  router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!(await findAccessibleAnnotation(db, req.user!, id))) {
      return sendError(res, 404, 'NOT_FOUND', 'Feedback not found.');
    }
    const annotation = await annotationRepo.findById(id);
    if (!annotation) return sendError(res, 404, 'NOT_FOUND', 'Feedback not found.');
    res.json({ data: annotation });
  });

  // POST /api/v1/feedback — create feedback
  router.post(
    '/',
    authMiddleware,
    requireWriteAccess,
    // Same monthly plan quota as `POST /projects/:id/annotations`.
    createPlanLimitsMiddleware(db, 'annotations'),
    async (req: Request, res: Response) => {
      const parsed = CreateFeedbackSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return sendZodFailure(res, 'Invalid feedback payload.', parsed.error.flatten());
      }
      const { projectId, pageId, type, severity, body, target, environment } = parsed.data;

      // Org match + owner/team-member access (prevents cross-tenant IDOR).
      if (!(await findAccessibleProject(db, req.user!, projectId))) {
        return sendError(res, 404, 'NOT_FOUND', 'Project not found.');
      }

      // The page must belong to THIS project; default to the project's first page.
      const pageRow = pageId
        ? await db('pages').where({ id: pageId, project_id: projectId }).first('id')
        : await db('pages').where({ project_id: projectId }).orderBy('created_at', 'asc').first('id');
      if (!pageRow) {
        return sendError(res, 400, 'VALIDATION', pageId ? 'pageId does not belong to this project.' : 'Project has no pages.');
      }

      const annotation = await annotationRepo.insert({
        projectId,
        pageId: pageRow.id,
        type: type ?? 'note',
        severity: severity ?? 'informational',
        status: 'active',
        body,
        authorId: req.user!.userId,
        target,
        environment,
        pinNumber: 0, // Auto-assigned in full flow; API sets 0 as placeholder
        orgId: req.user!.orgId,
      });

      await emitAnnotationCreated(eventBus, db, annotation);
      res.status(201).json({ data: annotation });
    },
  );

  // PATCH /api/v1/feedback/:id — update feedback
  router.patch('/:id', authMiddleware, requireWriteAccess, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!(await findAccessibleAnnotation(db, req.user!, id))) {
      return sendError(res, 404, 'NOT_FOUND', 'Feedback not found.');
    }
    const existing = await annotationRepo.findById(id);
    if (!existing) {
      return sendError(res, 404, 'NOT_FOUND', 'Feedback not found.');
    }
    const parsed = UpdateFeedbackSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendZodFailure(res, 'Invalid feedback update.', parsed.error.flatten());
    }
    const { body, severity, status, assigneeId, dueDate } = parsed.data;
    if (assigneeId && !(await isOrgMember(db, req.user!.orgId, assigneeId))) {
      return sendError(res, 400, 'VALIDATION', 'assigneeId must be a member of your organization.');
    }
    const patch: AnnotationPatch = {};
    if (body !== undefined) patch.body = body;
    if (severity !== undefined) patch.severity = severity;
    if (status !== undefined) patch.status = status;
    if (assigneeId !== undefined) patch.assigneeId = assigneeId;
    if (dueDate !== undefined) patch.dueDate = dueDate;
    const annotation = await annotationRepo.update(id, patch);
    // Same events the use cases emit: a status change is `status_changed`,
    // any other field edit is `updated` (both when a request does both).
    const { status: _status, ...fieldPatch } = patch;
    if (Object.keys(fieldPatch).length > 0) await emitAnnotationUpdated(eventBus, db, annotation);
    if (status !== undefined) {
      await emitAnnotationStatusChanged(eventBus, db, annotation, existing.status, req.user!.userId);
    }
    res.json({ data: annotation });
  });

  // DELETE /api/v1/feedback/:id — delete feedback
  router.delete('/:id', authMiddleware, requireWriteAccess, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!(await findAccessibleAnnotation(db, req.user!, id))) {
      return sendError(res, 404, 'NOT_FOUND', 'Feedback not found.');
    }
    if (!(await annotationRepo.findById(id))) {
      return sendError(res, 404, 'NOT_FOUND', 'Feedback not found.');
    }
    await annotationRepo.delete(id);
    res.status(204).end();
  });

  return router;
}
