import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';
import { sendZodFailure } from './errors.js';

export interface TagRouteDeps {
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

const CreateTagSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a valid hex color'),
});

const SetAnnotationTagsSchema = z.object({
  tagIds: z.array(z.string().uuid()),
});

export function createTagRoutes(deps: TagRouteDeps): Router {
  const { authMiddleware, db } = deps;
  const router = Router({ mergeParams: true });

  // GET /api/v1/projects/:id/tags — list all tags for a project
  router.get('/projects/:id/tags', authMiddleware, async (req: Request, res: Response) => {
    const tags = await db('tags')
      .where('project_id', req.params.id)
      .orderBy('name', 'asc');

    res.json({
      tags: tags.map((t) => ({
        id: t.id,
        projectId: t.project_id,
        name: t.name,
        color: t.color,
        createdAt: t.created_at,
      })),
    });
  });

  // POST /api/v1/projects/:id/tags — create a tag
  router.post('/projects/:id/tags', authMiddleware, async (req: Request, res: Response) => {
    const parsed = CreateTagSchema.safeParse(req.body);
    if (!parsed.success) {
      sendZodFailure(res, 'Validation failed', parsed.error.flatten());
      return;
    }

    const { name, color } = parsed.data;

    try {
      const [tag] = await db('tags')
        .insert({ project_id: req.params.id, name, color })
        .returning('*');

      res.status(201).json({
        tag: {
          id: tag.id,
          projectId: tag.project_id,
          name: tag.name,
          color: tag.color,
          createdAt: tag.created_at,
        },
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        res.status(409).json({
          error: { code: 'DUPLICATE', message: 'A tag with that name already exists in this project.', details: {} },
        });
        return;
      }
      throw err;
    }
  });

  // DELETE /api/v1/projects/:id/tags/:tagId — delete a tag
  router.delete('/projects/:id/tags/:tagId', authMiddleware, async (req: Request, res: Response) => {
    const deleted = await db('tags')
      .where({ id: req.params.tagId, project_id: req.params.id })
      .del();

    if (!deleted) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Tag not found.', details: {} },
      });
      return;
    }

    res.status(204).end();
  });

  // PUT /api/v1/annotations/:annotationId/tags — set tags on an annotation
  router.put('/annotations/:annotationId/tags', authMiddleware, async (req: Request, res: Response) => {
    const parsed = SetAnnotationTagsSchema.safeParse(req.body);
    if (!parsed.success) {
      sendZodFailure(res, 'Validation failed', parsed.error.flatten());
      return;
    }

    const { tagIds } = parsed.data;
    const { annotationId } = req.params;

    await db.transaction(async (trx) => {
      // Remove existing tags
      await trx('annotation_tags').where('annotation_id', annotationId).del();

      // Insert new tags (if any)
      if (tagIds.length > 0) {
        await trx('annotation_tags').insert(
          tagIds.map((tagId) => ({ annotation_id: annotationId, tag_id: tagId })),
        );
      }
    });

    // Return updated tags
    const tags = await db('tags')
      .join('annotation_tags', 'tags.id', 'annotation_tags.tag_id')
      .where('annotation_tags.annotation_id', annotationId)
      .select('tags.*');

    res.json({
      tags: tags.map((t) => ({
        id: t.id,
        projectId: t.project_id,
        name: t.name,
        color: t.color,
        createdAt: t.created_at,
      })),
    });
  });

  // GET /api/v1/annotations/:annotationId/tags — get tags for an annotation
  router.get('/annotations/:annotationId/tags', authMiddleware, async (req: Request, res: Response) => {
    const tags = await db('tags')
      .join('annotation_tags', 'tags.id', 'annotation_tags.tag_id')
      .where('annotation_tags.annotation_id', req.params.annotationId)
      .select('tags.*');

    res.json({
      tags: tags.map((t) => ({
        id: t.id,
        projectId: t.project_id,
        name: t.name,
        color: t.color,
        createdAt: t.created_at,
      })),
    });
  });

  return router;
}
