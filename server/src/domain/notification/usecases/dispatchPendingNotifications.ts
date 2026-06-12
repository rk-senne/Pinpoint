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
 * Produces inline-styled HTML emails with brand header, message, CTA, and
 * unsubscribe footer.
 */
export function renderTemplate(payload: NotificationPayload): {
  subject: string;
  body: string;
} {
  const appUrl = process.env.APP_URL || 'http://localhost:5173';

  switch (payload.kind) {
    case 'annotation_created': {
      const projectName = String(payload.projectName ?? 'Unknown');
      const projectId = String(payload.projectId ?? '');
      return {
        subject: `New annotation on project: ${projectName}`,
        body: emailLayout(
          `A new annotation was created on project "${projectName}".`,
          `${appUrl}/projects/${projectId}`,
          'View Project',
        ),
      };
    }
    case 'comment_created': {
      const annotationId = String(payload.annotationId ?? 'Unknown');
      const projectId = String(payload.projectId ?? '');
      return {
        subject: `New comment on annotation #${payload.pinNumber ?? annotationId}`,
        body: emailLayout(
          `A new comment was added to annotation #${payload.pinNumber ?? annotationId}.`,
          `${appUrl}/projects/${projectId}`,
          'View Annotation',
        ),
      };
    }
    case 'comment_on_own': {
      const name = String(payload.actorName ?? 'Someone');
      const pinNumber = String(payload.pinNumber ?? '?');
      const projectId = String(payload.projectId ?? '');
      return {
        subject: `${name} commented on your annotation #${pinNumber}`,
        body: emailLayout(
          `${name} commented on your annotation #${pinNumber}.`,
          `${appUrl}/projects/${projectId}`,
          'View Annotation',
        ),
      };
    }
    case 'mention': {
      const name = String(payload.actorName ?? 'Someone');
      const pinNumber = String(payload.pinNumber ?? '?');
      const projectId = String(payload.projectId ?? '');
      return {
        subject: `@${name} mentioned you in a comment`,
        body: emailLayout(
          `@${name} mentioned you in a comment on annotation #${pinNumber}.`,
          `${appUrl}/projects/${projectId}`,
          'View Comment',
        ),
      };
    }
    case 'status_change': {
      const name = String(payload.actorName ?? 'Someone');
      const pinNumber = String(payload.pinNumber ?? '?');
      const status = String(payload.newStatus ?? 'unknown');
      const projectId = String(payload.projectId ?? '');
      return {
        subject: `Annotation #${pinNumber} marked as ${status}`,
        body: emailLayout(
          `Annotation #${pinNumber} was marked as ${status} by ${name}.`,
          `${appUrl}/projects/${projectId}`,
          'View Annotation',
        ),
      };
    }
    case 'daily_digest': {
      const newAnnotations = Number(payload.newAnnotations ?? 0);
      const resolved = Number(payload.resolved ?? 0);
      const insight = String(payload.insight ?? '');
      const projectId = String(payload.projectId ?? '');
      const metricsHtml = `
        <div style="background:#f7f7fa;border-radius:6px;padding:12px 16px;margin:12px 0;">
          <div style="font-size:14px;margin-bottom:4px;"><strong>${newAnnotations}</strong> new annotations</div>
          <div style="font-size:14px;margin-bottom:4px;"><strong>${resolved}</strong> resolved</div>
          ${insight ? `<div style="font-size:13px;color:#555;margin-top:8px;font-style:italic;">${insight}</div>` : ''}
        </div>`;
      return {
        subject: `Daily digest: ${newAnnotations} new, ${resolved} resolved`,
        body: emailLayout(
          `Here's your daily activity summary.${metricsHtml}`,
          projectId ? `${appUrl}/projects/${projectId}` : appUrl,
          'Open Dashboard',
        ),
      };
    }
    case 'promoted_to_owner': {
      const projectName = String(payload.projectName ?? 'Unknown');
      const projectId = String(payload.projectId ?? '');
      return {
        subject: `You've been promoted to project owner`,
        body: emailLayout(
          `You have been promoted to owner of project "${projectName}".`,
          `${appUrl}/projects/${projectId}`,
          'View Project',
        ),
      };
    }
    case 'project_deleted': {
      const projectName = String(payload.projectName ?? 'Unknown');
      return {
        subject: `Project deleted: ${projectName}`,
        body: emailLayout(
          `The project "${projectName}" has been deleted.`,
          appUrl,
          'Open Dashboard',
        ),
      };
    }
    case 'verify_email': {
      const link = String(payload.link ?? '');
      return {
        subject: `Verify your email`,
        body: emailLayout(
          'Please verify your email address to complete your registration.',
          link || appUrl,
          'Verify Email',
        ),
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

/** Minimal inline-styled HTML email layout with brand header, message, CTA, and footer. */
function emailLayout(message: string, ctaUrl: string, ctaLabel: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:32px;max-width:560px;">
<tr><td style="padding-bottom:20px;border-bottom:1px solid #eee;">
  <span style="font-size:20px;font-weight:700;color:#4f46e5;">Pinpoint</span>
</td></tr>
<tr><td style="padding:20px 0;font-size:14px;color:#333;line-height:1.6;">
  ${message}
</td></tr>
<tr><td style="padding:12px 0;">
  <a href="${ctaUrl}" style="display:inline-block;padding:10px 24px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:4px;font-size:14px;font-weight:500;">${ctaLabel}</a>
</td></tr>
<tr><td style="padding-top:20px;border-top:1px solid #eee;font-size:11px;color:#999;line-height:1.5;">
  You're receiving this because of your Pinpoint notification settings.<br>
  To unsubscribe, visit your <a href="${ctaUrl.split('/projects')[0]}/settings" style="color:#4f46e5;">notification settings</a>.
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// Helper kept private to clarify renderTemplate's payload type is exported
// for use by the worker adapter and tests.
