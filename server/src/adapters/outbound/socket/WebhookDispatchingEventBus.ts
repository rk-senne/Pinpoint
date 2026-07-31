// WebhookDispatchingEventBus — composite EventBus that emits to both
// Socket.IO (real-time) and the webhook dispatch pipeline (async HTTP).
//
// This adapter wraps the primary EventBus and, for events that match a
// webhook event type, fires the DispatchWebhook use case asynchronously.
// Webhook dispatch failures are logged but never propagate back to the
// caller (fire-and-forget semantics per the EventBus port contract).
//
// Additionally, for activity-relevant events, it records an entry into
// the `activity_events` table for the project timeline feed.

import type { Knex } from 'knex';
import type { DomainEvent, EventBus } from '../../../domain/shared/ports/EventBus.js';
import type { DispatchWebhook } from '../../../domain/webhook/usecases/webhooks.js';
import { WEBHOOK_EVENTS, type WebhookEventType } from '../../../domain/webhook/Webhook.js';
import type { Logger } from '../../../domain/shared/ports/Logger.js';

const WEBHOOK_EVENT_SET = new Set<string>(WEBHOOK_EVENTS);

/** Event types that generate an activity feed entry. */
const ACTIVITY_EVENT_TYPES = new Set<string>([
  'annotation.created',
  'comment.created',
  'project.deleted',
]);

/**
 * Extracts fields required for recording an activity event from a
 * DomainEvent's payload.
 */
function extractActivityFields(event: DomainEvent): {
  projectId: string | undefined;
  actorId: string | undefined;
  resourceType: string;
  resourceId: string | undefined;
} {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload) {
    return { projectId: undefined, actorId: undefined, resourceType: 'unknown', resourceId: undefined };
  }

  let projectId: string | undefined;
  let actorId: string | undefined;
  let resourceType = 'unknown';
  let resourceId: string | undefined;

  switch (event.type) {
    case 'annotation.created': {
      projectId = payload.projectId as string | undefined;
      actorId = payload.createdBy as string | undefined;
      resourceType = 'annotation';
      resourceId = payload.id as string | undefined;
      break;
    }
    case 'comment.created': {
      const comment = payload.comment as Record<string, unknown> | undefined;
      projectId = payload.projectId as string | undefined;
      actorId = comment?.authorId as string | undefined;
      resourceType = 'comment';
      resourceId = comment?.id as string | undefined;
      break;
    }
    case 'project.deleted': {
      projectId = payload.projectId as string | undefined;
      actorId = payload.triggeredBy as string | undefined;
      resourceType = 'project';
      resourceId = payload.projectId as string | undefined;
      break;
    }
  }

  return { projectId, actorId, resourceType, resourceId };
}

export class WebhookDispatchingEventBus implements EventBus {
  constructor(
    private readonly primary: EventBus,
    private readonly dispatchWebhook: DispatchWebhook,
    private readonly logger: Logger,
    private readonly db: Knex,
  ) {}

  emit(event: DomainEvent): void {
    // Always forward to the primary (Socket.IO) bus
    this.primary.emit(event);

    // If this event type is a webhook event, dispatch asynchronously. Most
    // domain events are project-scoped and do NOT embed orgId, so resolution
    // falls back to a projects.org_id lookup (see resolveOrgId). Previously
    // this read payload.orgId directly and silently skipped every event that
    // lacked it — which was every annotation/comment event — so webhooks
    // never fired (INCONSISTENCIES.md #5).
    if (WEBHOOK_EVENT_SET.has(event.type)) {
      this.dispatchWebhookEvent(event).catch((err) => {
        this.logger.error({ eventType: event.type, error: err }, 'Webhook dispatch failed');
      });
    }

    // Record activity for relevant event types
    if (ACTIVITY_EVENT_TYPES.has(event.type)) {
      this.recordActivity(event).catch((err) => {
        this.logger.error({ eventType: event.type, error: err }, 'Activity recording failed');
      });
    }
  }

  private async recordActivity(event: DomainEvent): Promise<void> {
    const { projectId, actorId, resourceType, resourceId } = extractActivityFields(event);

    // Cannot record without project and actor context
    if (!projectId || !actorId) return;

    await this.db('activity_events').insert({
      project_id: projectId,
      actor_id: actorId,
      action: event.type,
      resource_type: resourceType,
      resource_id: resourceId ?? null,
      metadata: JSON.stringify(event.payload ?? {}),
    });
  }

  /**
   * Resolve the owning orgId for a webhook event, then dispatch. orgId is
   * used directly when the payload carries it; otherwise it is resolved from
   * the payload's projectId via a projects.org_id lookup (most domain events
   * are project-scoped and do not embed orgId). Skips with a warning when no
   * org can be determined, so a missing scope is observable, not silent.
   */
  private async dispatchWebhookEvent(event: DomainEvent): Promise<void> {
    const orgId = await this.resolveOrgId(event.payload);
    if (!orgId) {
      this.logger.warn(
        { eventType: event.type },
        'Webhook dispatch skipped: could not resolve orgId for event',
      );
      return;
    }
    await this.dispatchWebhook.execute({
      orgId,
      eventType: event.type as WebhookEventType,
      payload: event.payload as Record<string, unknown>,
    });
  }

  private async resolveOrgId(payload: unknown): Promise<string | undefined> {
    if (!payload || typeof payload !== 'object') return undefined;
    const p = payload as Record<string, unknown>;
    if (typeof p.orgId === 'string') return p.orgId;
    if (typeof p.projectId === 'string') {
      const row = (await this.db('projects').where({ id: p.projectId }).first('org_id')) as
        | { org_id?: string }
        | undefined;
      return row?.org_id ?? undefined;
    }
    return undefined;
  }
}
