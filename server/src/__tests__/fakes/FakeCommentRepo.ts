// FakeCommentRepo — in-memory CommentRepo fake (Phase 1.5 / task 4.11.1).

import { randomUUID } from 'node:crypto';

import type { Comment, NewComment } from '../../domain/comment/Comment.js';
import type { CommentRepo } from '../../domain/comment/ports/CommentRepo.js';
import type { Clock } from '../../domain/shared/ports/Clock.js';

export class FakeCommentRepo implements CommentRepo {
  /** Public for direct inspection in tests. */
  readonly comments = new Map<string, Comment>();

  constructor(private readonly clock: Clock) {}

  async insert(input: NewComment): Promise<Comment> {
    const id = randomUUID();
    const comment: Comment = {
      id,
      annotationId: input.annotationId,
      authorId: input.authorId,
      body: input.body,
      mentions: [...input.mentions],
      createdAt: this.clock.now().toISOString(),
    };
    if (input.clientRequestId !== undefined) {
      comment.clientRequestId = input.clientRequestId;
    }
    this.comments.set(id, comment);
    return clone(comment);
  }

  async listByAnnotation(annotationId: string): Promise<Comment[]> {
    const matches: Comment[] = [];
    for (const row of this.comments.values()) {
      if (row.annotationId === annotationId) matches.push(clone(row));
    }
    matches.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    return matches;
  }

  async findByClientRequestId(
    annotationId: string,
    clientRequestId: string,
  ): Promise<Comment | null> {
    for (const row of this.comments.values()) {
      if (row.annotationId !== annotationId) continue;
      if (row.clientRequestId !== clientRequestId) continue;
      return clone(row);
    }
    return null;
  }
}

function clone(c: Comment): Comment {
  const copy: Comment = { ...c, mentions: [...c.mentions] };
  return copy;
}
