// createComment use case (Phase 1.5 / task 4.7.4).
//
// Implements `POST /api/v1/annotations/:id/comments`. Owns:
//   1. Annotation existence check.
//   2. Offline-replay idempotency by `(annotationId, clientRequestId)`
//      (Req 44.3) — a hit returns the cached row untouched.
//   3. Mention extraction from the body (`@<uuid>` syntax) merged with
//      explicit caller-supplied mentions, deduplicated.
//   4. Persist the comment via `CommentRepo.insert`.
//   5. Emit a `comment.created` event so the inbound adapter can hand off
//      thread + mention notifications and the realtime adapter can
//      broadcast to the annotation's collaboration room (Req 6).

import type { Comment, NewComment } from '../Comment.js';
import type { CommentRepo } from '../ports/CommentRepo.js';
import type { AnnotationRepo } from '../../annotation/ports/AnnotationRepo.js';
import type { EventBus } from '../../shared/ports/EventBus.js';
import type { NotificationTriggers } from '../../notification/usecases/notificationTriggers.js';
import {
  NotFound,
  Validation,
  type DomainError,
  type Result,
  err,
  ok,
} from '../../shared/DomainError.js';

const UUID_RE =
  /@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

const UUID_VALIDATOR_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateCommentInput {
  authorUserId: string;
  annotationId: string;
  body: string;
  orgId?: string;
  /** Optional explicit mentions (merged with mentions parsed from the body). */
  mentions?: string[];
  /** UUID for offline-replay idempotency (Req 44.3). */
  clientRequestId?: string;
}

export interface CreateCommentOutput {
  comment: Comment;
  /** True when the row already existed and the call was treated as a replay. */
  idempotentReplay: boolean;
  /**
   * Author of the parent annotation (if any) so the inbound adapter can
   * gate the `newComment` notification on user preferences. Surfaced
   * through the result instead of dispatched here so the use case stays
   * free of the notification port.
   */
  annotationAuthorId: string;
}

export interface CreateCommentDeps {
  commentRepo: CommentRepo;
  annotationRepo: AnnotationRepo;
  eventBus: EventBus;
  notificationTriggers?: NotificationTriggers;
}

export class CreateComment {
  constructor(private readonly deps: CreateCommentDeps) {}

  async execute(
    input: CreateCommentInput,
  ): Promise<Result<CreateCommentOutput, DomainError>> {
    const { commentRepo, annotationRepo, eventBus } = this.deps;

    const annotation = await annotationRepo.findById(input.annotationId);
    if (!annotation) {
      return err(new NotFound('Annotation not found.'));
    }

    const trimmed = input.body.trim();
    if (trimmed.length === 0) {
      return err(
        new Validation(
          'Comment body is required and must be a non-empty string.',
        ),
      );
    }

    if (input.clientRequestId !== undefined) {
      if (!UUID_VALIDATOR_RE.test(input.clientRequestId)) {
        return err(new Validation('clientRequestId must be a UUID string.'));
      }
      const existing = await commentRepo.findByClientRequestId(
        input.annotationId,
        input.clientRequestId,
      );
      if (existing) {
        return ok({
          comment: existing,
          idempotentReplay: true,
          annotationAuthorId: annotation.authorId,
        });
      }
    }

    const fromBody = extractMentions(trimmed);
    const explicit = input.mentions ?? [];
    const allMentions = Array.from(new Set([...fromBody, ...explicit]));

    const newComment: NewComment = {
      annotationId: input.annotationId,
      authorId: input.authorUserId,
      body: trimmed,
      mentions: allMentions,
      orgId: input.orgId,
    };
    if (input.clientRequestId !== undefined) {
      newComment.clientRequestId = input.clientRequestId;
    }

    const comment = await commentRepo.insert(newComment);

    eventBus.emit({
      type: 'comment.created',
      room: `annotation:${comment.annotationId}`,
      payload: {
        comment,
        annotationId: comment.annotationId,
        projectId: annotation.projectId,
      },
    });

    // Fire-and-forget: trigger mention notifications for @mentioned users
    if (this.deps.notificationTriggers && input.orgId && allMentions.length > 0) {
      for (const mentionedUserId of allMentions) {
        if (mentionedUserId !== input.authorUserId) {
          this.deps.notificationTriggers
            .triggerMentionNotification(mentionedUserId, input.authorUserId, input.annotationId, input.orgId)
            .catch(() => {}); // best-effort
        }
      }
    }

    return ok({
      comment,
      idempotentReplay: false,
      annotationAuthorId: annotation.authorId,
    });
  }
}

/**
 * Extract `@<uuid>` mentions from a comment body. Matches the same regex
 * used by the legacy route handler so the wire-level behaviour is
 * preserved during the extraction.
 */
function extractMentions(body: string): string[] {
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  // Reset is unnecessary since `UUID_RE` is read-only here and we never
  // share the lastIndex across calls — instantiating per call would be
  // safer but keeps the same allocations as the legacy code.
  const re = new RegExp(UUID_RE.source, UUID_RE.flags);
  while ((match = re.exec(body)) !== null) {
    matches.push(match[1]!);
  }
  return Array.from(new Set(matches));
}
