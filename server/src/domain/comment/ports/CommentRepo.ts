// CommentRepo outbound port (Phase 1.5 / task 4.6.2).

import type { Comment, NewComment } from '../Comment.js';

export interface CommentRepo {
  insert(input: NewComment): Promise<Comment>;
  /** Listed in created_at ascending order — drives the comment thread UI. */
  listByAnnotation(annotationId: string): Promise<Comment[]>;
  /** Idempotency lookup scoped by annotation (Req 44.3). */
  findByClientRequestId(
    annotationId: string,
    clientRequestId: string,
  ): Promise<Comment | null>;
}
