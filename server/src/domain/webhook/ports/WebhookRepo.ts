import type { WebhookEndpoint, WebhookDelivery } from '../Webhook.js';

export interface NewWebhookEndpoint {
  orgId: string;
  url: string;
  secret: string;
  events: string[];
}

/**
 * A new durable delivery row enqueued BEFORE any HTTP attempt (Mission A5b).
 * The worker claims it, performs the fetch, and records the outcome.
 */
export interface NewWebhookDelivery {
  endpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
  /** Stable Standard-Webhooks `webhook-id`, reused across retries. */
  msgId: string;
  /** When the row first becomes eligible for a claim. */
  scheduledAt: Date;
}

export interface WebhookRepo {
  insert(endpoint: NewWebhookEndpoint): Promise<WebhookEndpoint>;
  listByOrg(orgId: string): Promise<WebhookEndpoint[]>;
  findById(id: string, orgId: string): Promise<WebhookEndpoint | null>;
  update(id: string, orgId: string, updates: Partial<Pick<WebhookEndpoint, 'url' | 'events' | 'active'>>): Promise<WebhookEndpoint | null>;
  delete(id: string, orgId: string): Promise<boolean>;
  findByOrgAndEvent(orgId: string, eventType: string): Promise<WebhookEndpoint[]>;

  // --- durable delivery queue (Mission A5b) ---

  /** Insert a `pending` delivery row scheduled for `scheduledAt`; returns its id. */
  enqueueDelivery(delivery: NewWebhookDelivery): Promise<string>;

  /**
   * Claim up to `limit` due `pending` rows for dispatch. Implementations
   * hold a `FOR UPDATE SKIP LOCKED` lock so multiple workers can poll
   * concurrently without double-sending.
   */
  claimDueDeliveries(limit: number, now: Date): Promise<WebhookDelivery[]>;

  /** Transition a delivery to `sent`, recording the final response. */
  markDeliverySent(id: string, attempts: number, statusCode: number | undefined, responseBody: string | undefined): Promise<void>;

  /** Bump attempts + reschedule a delivery for a later retry (stays `pending`). */
  markDeliveryPending(id: string, attempts: number, scheduledAt: Date, statusCode: number | undefined, responseBody: string | undefined, lastError: string): Promise<void>;

  /** Transition a delivery to `failed` after exhausting retries. */
  markDeliveryFailed(id: string, attempts: number, statusCode: number | undefined, responseBody: string | undefined, lastError: string): Promise<void>;

  /** Lookup an endpoint by delivery-time id (no org scoping — worker use). */
  findEndpointById(id: string): Promise<WebhookEndpoint | null>;

  listDeliveries(endpointId: string, limit: number, offset?: number): Promise<WebhookDelivery[]>;
  countDeliveries(endpointId: string): Promise<number>;
}
