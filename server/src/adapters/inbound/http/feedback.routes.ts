import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Knex } from 'knex';
import type { AnnotationRepo, ListAnnotationsFilter } from '../../../domain/annotation/ports/AnnotationRepo.js';
import type { AnnotationStatus, NewAnnotation } from '../../../domain/annotation/Annotation.js';

export interface FeedbackRouteDeps {
  /** Combined middleware: tries API key first, falls back to JWT */
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  annotationRepo: AnnotationRepo;
  db: Knex;
}

export function createFeedbackRoutes(deps: FeedbackRouteDeps): Router {
  const router = Router();
  const { authMiddleware, annotationRepo, db } = deps;

  // GET /api/v1/feedback — paginated, filterable list
  router.get('/', authMiddleware, async (req: Request, res: Response) => {
    const projectId = req.query.projectId as string | undefined;
    if (!projectId) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'projectId query param required.' } });
    }

    // Verify project belongs to the caller's org (prevent cross-tenant IDOR)
    const project = await db('projects').where({ id: projectId, org_id: req.user!.orgId }).first();
    if (!project) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found.', details: {} } });
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const filter: ListAnnotationsFilter = {};
    if (req.query.status) filter.status = req.query.status as AnnotationStatus;
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

  // POST /api/v1/feedback — create feedback
  router.post('/', authMiddleware, async (req: Request, res: Response) => {
    const { projectId, pageId, type, severity, body, target, environment } = req.body;

    if (!projectId || !body || !target || !environment) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'projectId, body, target, environment are required.' } });
    }

    // Verify project belongs to the caller's org (prevent cross-tenant IDOR)
    const project = await db('projects').where({ id: projectId, org_id: req.user!.orgId }).first();
    if (!project) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found.', details: {} } });
    }

    const annotation = await annotationRepo.insert({
      projectId,
      pageId: pageId ?? projectId,
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

    res.status(201).json({ data: annotation });
  });

  // PATCH /api/v1/feedback/:id — update feedback
  router.patch('/:id', authMiddleware, async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const existing = await annotationRepo.findById(id);
    if (!existing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Feedback not found.' } });
    }

    // Verify annotation belongs to the caller's org (prevent cross-tenant IDOR)
    const annotationRow = await db('annotations').where({ id, org_id: req.user!.orgId }).first();
    if (!annotationRow) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Feedback not found.' } });
    }

    const { body, severity, status, assigneeId, dueDate } = req.body;
    const annotation = await annotationRepo.update(id, {
      body, severity, status, assigneeId, dueDate,
    });

    res.json({ data: annotation });
  });

  // DELETE /api/v1/feedback/:id — delete feedback
  router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const existing = await annotationRepo.findById(id);
    if (!existing) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Feedback not found.' } });
    }

    // Verify annotation belongs to the caller's org (prevent cross-tenant IDOR)
    const annotationRow = await db('annotations').where({ id, org_id: req.user!.orgId }).first();
    if (!annotationRow) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Feedback not found.' } });
    }

    await annotationRepo.delete(id);
    res.status(204).end();
  });

  return router;
}
