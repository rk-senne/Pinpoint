// Slack auto-notify: post NEW annotations to the configured channel without a
// manual "Send to…".
//
// Pipeline (never on the request path, durable, failures logged not thrown):
//
//   annotation.created  ──►  SlackAnnotationNotifier   (decides: connected? notifyOnNew?
//   (EventBus.emit)           │                          severity >= minSeverity?)
//                             ▼  enqueue
//                        `notifications` table  (kind 'slack_annotation', durable)
//                             ▼  claimDue (existing notification worker)
//                        DispatchPendingNotifications ──► createSlackQueueDelivery
//                                                          └─ SlackProvider (safeFetch)
//
// The queue gives retry/backoff for free (429 `Retry-After` and 5xx are
// rescheduled; permanent errors such as `not_in_channel` are marked failed).

import type { Knex } from 'knex';
import type { DomainEvent, EventBus } from '../../domain/shared/ports/EventBus.js';
import type { Logger } from '../../domain/shared/ports/Logger.js';
import type { NotificationPayload } from '../../domain/notification/Notification.js';
import type { NotificationQueue } from '../../domain/notification/ports/NotificationQueue.js';
import type { IntegrationRepo } from '../../domain/integration/ports/IntegrationRepo.js';
import { type TaskProvider } from './TaskProvider.js';

export const SLACK_NOTIFICATION_KIND = 'slack_annotation' as const;

const SEVERITY_RANK: Record<string, number> = { critical: 3, major: 2, minor: 1, informational: 0 };
const DEFAULT_MIN_SEVERITY = 'major';

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
  informational: 'Informational',
};

/** Is `severity` at or above the configured minimum (unknown min → `major`)? */
export function meetsMinSeverity(severity: unknown, minSeverity: unknown): boolean {
  const s = typeof severity === 'string' ? SEVERITY_RANK[severity] : undefined;
  if (s === undefined) return false;
  const min = (typeof minSeverity === 'string' ? SEVERITY_RANK[minSeverity] : undefined) ?? SEVERITY_RANK[DEFAULT_MIN_SEVERITY]!;
  return s >= min;
}

export interface SlackNotifierDeps {
  db: Knex;
  integrationRepo: IntegrationRepo;
  notificationQueue: Pick<NotificationQueue, 'enqueue'>;
  logger: Logger;
  now?: () => Date;
}

export interface SlackAnnotationNotifier {
  /** Handle an `annotation.created` payload. Never throws. */
  onAnnotationCreated(payload: unknown): Promise<void>;
}

const MAX_QUEUED_BODY = 2500;

export function createSlackAnnotationNotifier(deps: SlackNotifierDeps): SlackAnnotationNotifier {
  const { db, integrationRepo, notificationQueue, logger } = deps;
  const now = deps.now ?? (() => new Date());

  async function resolveOrgId(p: Record<string, unknown>): Promise<string | undefined> {
    if (typeof p.orgId === 'string' && p.orgId) return p.orgId;
    if (typeof p.projectId !== 'string') return undefined;
    const row = (await db('projects').where({ id: p.projectId }).first('org_id')) as { org_id?: string } | undefined;
    return row?.org_id ?? undefined;
  }

  return {
    async onAnnotationCreated(payload: unknown): Promise<void> {
      try {
        if (!payload || typeof payload !== 'object') return;
        const p = payload as Record<string, unknown>;
        if (typeof p.id !== 'string' || typeof p.projectId !== 'string') return;
        // Cheap pre-filter before touching the DB: nothing below can pass otherwise.
        if (typeof p.severity !== 'string' || !(p.severity in SEVERITY_RANK)) return;

        const orgId = await resolveOrgId(p);
        if (!orgId) return;
        const integration = await integrationRepo.findByOrgAndProvider(orgId, 'slack');
        if (!integration || !integration.enabled || !integration.accessToken) return;
        const cfg = integration.config ?? {};
        if (cfg.notifyOnNew !== true) return;
        if (typeof cfg.channelId !== 'string' || !cfg.channelId) return;
        if (!meetsMinSeverity(p.severity, cfg.minSeverity)) return;

        const job: NotificationPayload = {
          kind: SLACK_NOTIFICATION_KIND,
          recipientUserId: '', // not an email; no recipient
          orgId,
          projectId: p.projectId,
          annotationId: p.id,
          pinNumber: typeof p.pinNumber === 'number' ? p.pinNumber : null,
          severity: p.severity,
          annotationType: typeof p.type === 'string' ? p.type : null,
          status: typeof p.status === 'string' ? p.status : null,
          body: typeof p.body === 'string' ? p.body.slice(0, MAX_QUEUED_BODY) : '',
          pageUrl: typeof p.pageUrl === 'string' ? p.pageUrl : null,
        };
        await notificationQueue.enqueue(job, now());
      } catch (err) {
        logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Slack auto-notify enqueue failed');
      }
    },
  };
}

/**
 * Decorate an EventBus so `annotation.created` also feeds the Slack notifier.
 * The notifier runs detached (`void`) so it can never block or fail `emit`.
 */
export function withSlackAutoNotify(bus: EventBus, notifier: SlackAnnotationNotifier): EventBus {
  return {
    emit(event: DomainEvent): void {
      bus.emit(event);
      if (event.type === 'annotation.created') void notifier.onAnnotationCreated(event.payload);
    },
  };
}

export interface SlackQueueDeliveryDeps {
  db: Knex;
  integrationRepo: IntegrationRepo;
  provider: TaskProvider;
  /** `APP_URL`, for the link back to the dashboard project page. */
  appUrl?: string;
  logger?: Logger;
}

/**
 * The `ChannelDeliverer` for `slack_annotation` queue rows. Throws the
 * provider's `TaskDeliveryError` on failure (the dispatcher reads its
 * `transient` / `retryAfterSeconds` to reschedule or fail the row).
 */
export function createSlackQueueDelivery(deps: SlackQueueDeliveryDeps) {
  const { db, integrationRepo, provider } = deps;
  const appUrl = (deps.appUrl ?? '').replace(/\/+$/, '');

  return async function deliverSlackJob(payload: NotificationPayload): Promise<void> {
    const orgId = String(payload.orgId ?? '');
    const annotationId = String(payload.annotationId ?? '');
    const projectId = String(payload.projectId ?? '');
    if (!orgId || !annotationId || !projectId) return; // malformed row: nothing to retry

    const integration = await integrationRepo.findByOrgAndProvider(orgId, 'slack');
    const channelId = integration?.config?.channelId;
    // Disconnected / re-targeted since enqueue: drop the job (it is not an error).
    if (!integration || !integration.enabled || !integration.accessToken || typeof channelId !== 'string' || !channelId) return;

    // Already posted (manual "Send to…" or an earlier attempt): never double-post.
    const existing = (await db('annotation_external_links')
      .where({ annotation_id: annotationId, provider: 'slack', status: 'delivered' })
      .first('id')) as { id: string } | undefined;
    if (existing) return;

    const severity = String(payload.severity ?? 'informational');
    const body = String(payload.body ?? '');
    const result = await provider.createTask(
      { accessToken: integration.accessToken, config: integration.config },
      {
        title: `[Pinpoint #${payload.pinNumber ?? '?'}] ${body.slice(0, 80)}`.trim(),
        body,
        url: `${appUrl}/projects/${projectId}`,
        projectUrl: `${appUrl}/projects/${projectId}`,
        severity: SEVERITY_LABEL[severity] ?? severity,
        labels: ['pinpoint', severity],
        ...(typeof payload.annotationType === 'string' ? { annotationType: payload.annotationType } : {}),
        ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
        pageUrl: typeof payload.pageUrl === 'string' ? payload.pageUrl : null,
        pinNumber: typeof payload.pinNumber === 'number' ? payload.pinNumber : null,
      },
    );

    // Record the link like a manual delivery. The message IS posted, so a
    // failure here (e.g. annotation deleted meanwhile) must not fail the job.
    try {
      await db('annotation_external_links')
        .insert({
          annotation_id: annotationId,
          provider: 'slack',
          external_id: result.externalId,
          external_url: result.externalUrl,
          status: 'delivered',
          last_error: null,
          updated_at: db.fn.now(),
        })
        .onConflict(['annotation_id', 'provider'])
        .merge({
          external_id: result.externalId,
          external_url: result.externalUrl,
          status: 'delivered',
          last_error: null,
          updated_at: db.fn.now(),
        });
    } catch (err) {
      deps.logger?.warn({ annotationId, error: err instanceof Error ? err.message : String(err) }, 'Could not record Slack link');
    }
  };
}
