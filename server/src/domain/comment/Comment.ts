// Comment entity (Phase 1.5 / task 4.6.1).

export interface Comment {
  id: string;
  annotationId: string;
  authorId: string;
  body: string;
  /** User ids referenced in the comment body via @uuid syntax. */
  mentions: string[];
  createdAt: string;
  /** Client-supplied UUID for offline-replay idempotency (Req 44.3). */
  clientRequestId?: string;
}

export interface NewComment {
  annotationId: string;
  authorId: string;
  body: string;
  mentions: string[];
  clientRequestId?: string;
}
