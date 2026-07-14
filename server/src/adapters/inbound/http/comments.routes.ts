// Inbound HTTP adapter — comment routes (Phase 1.5 / task 4.9.1).
//
// Mounted at `/api/v1/annotations/:id/comments`. The two handlers
// invoke the corresponding domain Use_Cases and translate the result
// into the legacy response shape.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';

import { PaginationParamsSchema, paginationMeta } from '@pinpoint/shared';

import type { CreateComment } from '../../../domain/comment/usecases/createComment.js';
import type { ListComments } from '../../../domain/comment/usecases/listComments.js';
import type { CreateUserNotification } from '../../../domain/notification/usecases/userNotifications.js';
import type { Comment } from '../../../domain/comment/Comment.js';
import { sendDomainError, sendZodFailure, paramString } from './errors.js';

export interface CommentsRouteDeps {
  createComment: CreateComment;
  listComments: ListComments;
  createUserNotification?: CreateUserNotification;
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void;
  db: Knex;
}

const CommentBodySchema = z.object({
  body: z.string().min(1),
  mentions: z.array(z.string()).optional(),
  clientRequestId: z.string().uuid().optional(),
});

function formatComment(c: Comment): Record<string, unknown> {
  return {
    id: c.id,
    annotationId: c.annotationId,
    authorId: c.authorId,
    body: c.body,
    mentions: c.mentions ?? [],
    clientRequestId: c.clientRequestId,
    createdAt: c.createdAt,
  };
}

export function createCommentsRoutes(deps: CommentsRouteDeps): Router {
  const { createComment, listComments, createUserNotification, authMiddleware, db } = deps;

  const router = Router({ mergeParams: true });
  router.use(authMiddleware);

  router.post('/', async (req: Request, res: Response) => {
    const parsed = CommentBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodFailure(res, 'Invalid comment payload.', parsed.error.flatten());
      return;
    }
    const annotationId = paramString((req.params as { id?: string | string[] }).id);
    const result = await createComment.execute({
      authorUserId: req.user!.userId,
      annotationId,
      body: parsed.data.body,
      ...(parsed.data.mentions !== undefined ? { mentions: parsed.data.mentions } : {}),
      ...(parsed.data.clientRequestId !== undefined
        ? { clientRequestId: parsed.data.clientRequestId }
        : {}),
    });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }
    if (result.value.idempotentReplay) {
      res.setHeader('X-FL-Idempotent-Replay', 'true');
      res.status(200).json({ comment: formatComment(result.value.comment) });
      return;
    }
    res.status(201).json({ comment: formatComment(result.value.comment) });

    // Fire-and-forget: notify mentioned users + annotation author
    if (createUserNotification) {
      const comment = result.value.comment;
      const authorId = req.user!.userId;
      const orgId = req.user!.orgId;
      const recipients = new Set<string>(comment.mentions ?? []);
      // Notify annotation author if someone else commented
      if (result.value.annotationAuthorId !== authorId) {
        recipients.add(result.value.annotationAuthorId);
      }
      // Don't notify the comment author themselves
      recipients.delete(authorId);
      for (const userId of recipients) {
        const isMention = (comment.mentions ?? []).includes(userId);
        createUserNotification.execute({
          userId,
          orgId,
          type: isMention ? 'mention' : 'comment_on_own',
          title: isMention ? 'You were mentioned in a comment' : 'New comment on your annotation',
          body: comment.body.slice(0, 200),
          metadata: { annotationId: comment.annotationId, commentId: comment.id },
        }).catch(() => {}); // swallow — notifications are best-effort
      }
    }
  });

  router.get('/', async (req: Request, res: Response) => {
    const annotationId = paramString((req.params as { id?: string | string[] }).id);

    const parsed = PaginationParamsSchema.safeParse(req.query);
    const { page, pageSize } = parsed.success ? parsed.data : { page: 1, pageSize: 25 };
    const offset = (page - 1) * pageSize;

    // Verify annotation exists via the use case's validation
    const result = await listComments.execute({ annotationId });
    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }

    const [{ count: total }] = await db('comments')
      .where('annotation_id', annotationId)
      .count('* as count');

    const rows = await db('comments')
      .where('annotation_id', annotationId)
      .orderBy('created_at', 'asc')
      .limit(pageSize)
      .offset(offset);

    const comments: Comment[] = rows.map((r: any) => ({
      id: r.id,
      annotationId: r.annotation_id,
      authorId: r.author_id,
      body: r.body,
      mentions: r.mentions ?? [],
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      ...(r.client_request_id ? { clientRequestId: r.client_request_id } : {}),
    }));

    res.status(200).json({
      data: comments.map(formatComment),
      pagination: paginationMeta(Number(total), page, pageSize),
    });
  });

  return router;
}
