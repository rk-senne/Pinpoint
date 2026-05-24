// dispatchPendingNotifications use case (Phase 1.5 / task 4.7.6).
//
// Consumer side of the durable notification queue (Reqs 28.3 / 28.4 /
// 28.6). The infra worker calls this on its polling tick. The use case:
//
//   1. Claims a batch of due rows via `NotificationQueue.claimDue`.
//      The Postgres adapter implements that with `SELECT … FOR UPDATE
//      SKIP LOCKED` so multiple worker replicas can run side-by-side
//      without double-sending.
//   2. For each row: resolves the recipient's email through
//      `UserRepo.findById`, renders the subject/body template, and
//      sends via the `Mailer` port.
//   3. Marks the row `sent` on success or `failed` on error. The
//      simple two-state outcome matches the use case's contract; the
//      richer exponential-backoff scheduling lives in the worker
//      adapter wave.
//
// Templates are owned by the domain layer (per the `Mailer` port
// comment) so the SMTP adapter only knows how to deliver pre-rendered
// `(to, subject, body)` triples — it never imports a template engine.

import type { NotificationPayload } from '../Notification.js';
import type { Mailer } from '../ports/Mailer.js';
import type { NotificationQueue } from '../ports/NotificationQueue.js';
import type { UserRepo } from '../../user/ports/UserRepo.js';
import type { Clock } from '../../shared/ports/Clock.js';
import type { Logger } from '../../shared/ports/Logger.js';
import {
  type DomainError,
  type Result,
  ok,
} from '../../shared/DomainError.js';

export interface DispatchPendingNotificationsInput {
  /** Maximum number of rows to claim this tick. Defaults to 10. */
  batchSize?: number;
}

export interface DispatchedNotification {
  id: string;
  outcome: 'sent' | 'failed';
  error?: string;
}

export interface DispatchPendingNotificationsOutput {
  dispatched: DispatchedNotification[];
}

export interface DispatchPendingNotificationsDeps {
  notificationQueue: NotificationQueue;
  userRepo: UserRepo;
  mailer: Mailer;
  clock: Clock;
  logger: Logger;
}

const DEFAULT_BATCH_SIZE = 10;

export class DispatchPendingNotifications {
  constructor(private readonly deps: DispatchPendingNotificationsDeps) {}

  async execute(
    input: DispatchPendingNotificationsInput = {},
  ): Promise<Result<DispatchPendingNotificationsOutput, DomainError>> {
    const { notificationQueue, userRepo, mailer, clock, logger } = this.deps;

    const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
    const now = clock.now();
    const rows = await notificationQueue.claimDue(batchSize, now);

    const dispatched: DispatchedNotification[] = [];

    for (const row of rows) {
      try {
        const recipient = row.payload?.recipientUserId;
        if (typeof recipient !== 'string' || recipient.length === 0) {
          throw new Error('payload.recipientUserId missing');
        }
        const user = await userRepo.findById(recipient);
        if (!user) {
          throw new Error(`recipient ${recipient} not found`);
        }

        const { subject, body } = renderTemplate(row.payload);
        await mailer.send({ to: user.email, subject, body });

        await notificationQueue.markSent(row.id);
        dispatched.push({ id: row.id, outcome: 'sent' });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const attempts = (row.attempts ?? 0) + 1;
        await notificationQueue.markFailed(row.id, attempts, message);
        logger.warn(
          { notificationId: row.id, attempts, error: message },
          'notification dispatch failed',
        );
        dispatched.push({ id: row.id, outcome: 'failed', error: message });
      }
    }

    return ok({ dispatched });
  }
}

/**
 * Pure: pick the email subject + body for a payload kind.
 */
export function renderTemplate(payload: NotificationPayload): {
  subject: string;
  body: string;
} {
  switch (payload.kind) {
    case 'annotation_created': {
      const projectName = String(payload.projectName ?? 'Unknown');
      return {
        subject: `New annotation on project: ${projectName}`,
        body: `A new annotation was created on project "${projectName}".`,
      };
    }
    case 'comment_created': {
      const annotationId = String(payload.annotationId ?? 'Unknown');
      return {
        subject: `New comment on annotation: ${annotationId}`,
        body: `A new comment was added to annotation "${annotationId}".`,
      };
    }
    case 'mention': {
      const annotationId = String(payload.annotationId ?? 'Unknown');
      return {
        subject: `You were mentioned in a comment`,
        body: `You were mentioned in a comment on annotation "${annotationId}".`,
      };
    }
    case 'promoted_to_owner': {
      const projectName = String(payload.projectName ?? 'Unknown');
      return {
        subject: `You've been promoted to project owner`,
        body: `You have been promoted to owner of project "${projectName}".`,
      };
    }
    case 'project_deleted': {
      const projectName = String(payload.projectName ?? 'Unknown');
      return {
        subject: `Project deleted: ${projectName}`,
        body: `The project "${projectName}" has been deleted.`,
      };
    }
    case 'verify_email': {
      const link = String(payload.link ?? '');
      return {
        subject: `Verify your email`,
        body: link
          ? `Please verify your email by visiting: ${link}`
          : `Please verify your email.`,
      };
    }
    default: {
      const _exhaustive: never = payload.kind;
      throw new Error(
        `dispatchPendingNotifications: unknown kind ${String(_exhaustive)}`,
      );
    }
  }
}

// Helper kept private to clarify renderTemplate's payload type is exported
// for use by the worker adapter and tests.
