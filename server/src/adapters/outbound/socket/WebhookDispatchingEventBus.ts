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
 * Extracts the orgId from an event payload.
 * Use cases embed orgId in the payload for scoping.
 */
function extractOrgId(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object' && 'orgId' in payload) {
    return (payload as { orgId: string }).orgId;
  }
  return undefined;
}

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

    // If this event type is a webhook event, dispatch asynchronously
    if (WEBHOOK_EVENT_SET.has(event.type)) {
      const orgId = extractOrgId(event.payload);
      if (orgId) {
        this.dispatchWebhook
          .execute({
            orgId,
            eventType: event.type as WebhookEventType,
            payload: event.payload as Record<string, unknown>,
          })
          .catch((err) => {
            this.logger.error({ eventType: event.type, orgId, error: err }, 'Webhook dispatch failed');
          });
      }
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
}
