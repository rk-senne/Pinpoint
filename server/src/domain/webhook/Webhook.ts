export interface WebhookEndpoint {
  id: string;
  orgId: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Lifecycle of a durable webhook delivery row (Mission A5b). */
/** `processing` = claimed by a worker under a time-bounded lease. */
export type WebhookDeliveryStatus = 'pending' | 'processing' | 'sent' | 'failed';

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
  statusCode?: number;
  responseBody?: string;
  success: boolean;
  deliveredAt: string;
  /**
   * Durable-queue fields (Mission A5b). A delivery row is inserted `pending`
   * with a `scheduledAt` BEFORE the first attempt; the worker claims it with
   * `FOR UPDATE SKIP LOCKED`, retries with backoff, and marks it `sent` or
   * `failed`. `msgId` is the stable Standard-Webhooks `webhook-id` reused
   * across retries so consumers can dedupe.
   */
  status: WebhookDeliveryStatus;
  attempts: number;
  scheduledAt: string;
  msgId: string;
  lastError?: string;
}

export const WEBHOOK_EVENTS = [
  'annotation.created',
  'annotation.updated',
  'annotation.deleted',
  'annotation.status_changed',
  'comment.created',
  'project.created',
  'project.deleted',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];
