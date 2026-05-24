// listComments use case (Phase 1.5 / task 4.7.4).
//
// Implements `GET /api/v1/annotations/:id/comments`. Returns every
// comment attached to the annotation in created_at ascending order (the
// order is owned by `CommentRepo`).

import type { Comment } from '../Comment.js';
import type { CommentRepo } from '../ports/CommentRepo.js';
import type { AnnotationRepo } from '../../annotation/ports/AnnotationRepo.js';
import {
  NotFound,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

export interface ListCommentsInput {
  annotationId: string;
}

export interface ListCommentsOutput {
  comments: Comment[];
}

export interface ListCommentsDeps {
  commentRepo: CommentRepo;
  annotationRepo: AnnotationRepo;
}

export class ListComments {
  constructor(private readonly deps: ListCommentsDeps) {}

  async execute(
    input: ListCommentsInput,
  ): Promise<Result<ListCommentsOutput, DomainError>> {
    const { commentRepo, annotationRepo } = this.deps;

    const annotation = await annotationRepo.findById(input.annotationId);
    if (!annotation) {
      return err(new NotFound('Annotation not found.'));
    }

    const comments = await commentRepo.listByAnnotation(input.annotationId);
    return ok({ comments });
  }
}
