// Postgres adapter for CommentRepo (Phase 1.5 / task 4.8.1).

import type { Knex } from 'knex';
import type { Comment, NewComment } from '../../../domain/comment/Comment.js';
import type { CommentRepo } from '../../../domain/comment/ports/CommentRepo.js';

interface CommentRow {
  id: string;
  annotation_id: string;
  author_id: string;
  body: string;
  mentions: string[] | null;
  client_request_id: string | null;
  created_at: Date | string;
}

export class PgCommentRepo implements CommentRepo {
  constructor(private readonly db: Knex) {}

  async insert(input: NewComment): Promise<Comment> {
    const row: Record<string, unknown> = {
      annotation_id: input.annotationId,
      author_id: input.authorId,
      body: input.body,
      mentions: input.mentions,
    };
    if (input.clientRequestId !== undefined) row.client_request_id = input.clientRequestId;

    const [created] = await this.db<CommentRow>('comments').insert(row).returning('*');
    return this.mapRow(created);
  }

  async listByAnnotation(annotationId: string): Promise<Comment[]> {
    const rows = await this.db<CommentRow>('comments')
      .where({ annotation_id: annotationId })
      .orderBy('created_at', 'asc');
    return rows.map((r) => this.mapRow(r));
  }

  async findByClientRequestId(
    annotationId: string,
    clientRequestId: string,
  ): Promise<Comment | null> {
    const row = await this.db<CommentRow>('comments')
      .where({ annotation_id: annotationId, client_request_id: clientRequestId })
      .first();
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: CommentRow): Comment {
    const comment: Comment = {
      id: row.id,
      annotationId: row.annotation_id,
      authorId: row.author_id,
      body: row.body,
      mentions: row.mentions ?? [],
      createdAt: toIso(row.created_at),
    };
    if (row.client_request_id) comment.clientRequestId = row.client_request_id;
    return comment;
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
