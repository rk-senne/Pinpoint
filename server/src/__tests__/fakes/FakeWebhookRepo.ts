// FakeWebhookRepo — in-memory WebhookRepo double (Mission A5b).
//
// Models both webhook endpoints and the durable delivery queue so the
// DispatchWebhook (enqueue) and DispatchWebhookDeliveries (worker) use cases
// can be exercised without Postgres. `claimDueDeliveries` returns a snapshot
// of due `pending` rows (the SKIP LOCKED concurrency guarantee is a Postgres
// concern verified in DB-backed tests).

import crypto from 'node:crypto';
import type { WebhookEndpoint, WebhookDelivery } from '../../domain/webhook/Webhook.js';
import type { WebhookRepo, NewWebhookEndpoint, NewWebhookDelivery } from '../../domain/webhook/ports/WebhookRepo.js';

export class FakeWebhookRepo implements WebhookRepo {
  readonly endpoints: WebhookEndpoint[] = [];
  readonly deliveries: WebhookDelivery[] = [];

  constructor(seedEndpoints: WebhookEndpoint[] = []) {
    this.endpoints.push(...seedEndpoints);
  }

  async insert(endpoint: NewWebhookEndpoint): Promise<WebhookEndpoint> {
    const now = new Date().toISOString();
    const created: WebhookEndpoint = {
      id: `ep_${crypto.randomUUID()}`,
      orgId: endpoint.orgId,
      url: endpoint.url,
      secret: endpoint.secret,
      events: endpoint.events,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.endpoints.push(created);
    return created;
  }

  async listByOrg(orgId: string): Promise<WebhookEndpoint[]> {
    return this.endpoints.filter((e) => e.orgId === orgId);
  }

  async findById(id: string, orgId: string): Promise<WebhookEndpoint | null> {
    return this.endpoints.find((e) => e.id === id && e.orgId === orgId) ?? null;
  }

  async findEndpointById(id: string): Promise<WebhookEndpoint | null> {
    return this.endpoints.find((e) => e.id === id) ?? null;
  }

  async update(
    id: string,
    orgId: string,
    updates: Partial<Pick<WebhookEndpoint, 'url' | 'events' | 'active'>>,
  ): Promise<WebhookEndpoint | null> {
    const ep = this.endpoints.find((e) => e.id === id && e.orgId === orgId);
    if (!ep) return null;
    if (updates.url !== undefined) ep.url = updates.url;
    if (updates.events !== undefined) ep.events = updates.events;
    if (updates.active !== undefined) ep.active = updates.active;
    ep.updatedAt = new Date().toISOString();
    return ep;
  }

  async delete(id: string, orgId: string): Promise<boolean> {
    const idx = this.endpoints.findIndex((e) => e.id === id && e.orgId === orgId);
    if (idx === -1) return false;
    this.endpoints.splice(idx, 1);
    return true;
  }

  async findByOrgAndEvent(orgId: string, eventType: string): Promise<WebhookEndpoint[]> {
    return this.endpoints.filter(
      (e) => e.orgId === orgId && e.active && e.events.includes(eventType),
    );
  }

  async enqueueDelivery(delivery: NewWebhookDelivery): Promise<string> {
    const id = `del_${crypto.randomUUID()}`;
    this.deliveries.push({
      id,
      endpointId: delivery.endpointId,
      eventType: delivery.eventType,
      payload: delivery.payload,
      success: false,
      deliveredAt: '',
      status: 'pending',
      attempts: 0,
      scheduledAt: delivery.scheduledAt.toISOString(),
      msgId: delivery.msgId,
    });
    return id;
  }

  async claimDueDeliveries(limit: number, now: Date): Promise<WebhookDelivery[]> {
    // Mirrors PgWebhookRepo: claimed rows flip to `processing`, so a second
    // claim (another worker / the next tick) never receives them until a
    // mark* call re-queues or finalizes them.
    const due = this.deliveries
      .filter((d) => d.status === 'pending' && new Date(d.scheduledAt).getTime() <= now.getTime())
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime())
      .slice(0, limit);
    for (const d of due) d.status = 'processing';
    return due.map((d) => ({ ...d }));
  }

  async markDeliverySent(id: string, attempts: number, statusCode: number | undefined, responseBody: string | undefined): Promise<void> {
    const d = this.deliveries.find((x) => x.id === id);
    if (!d) return;
    d.status = 'sent';
    d.success = true;
    d.attempts = attempts;
    d.statusCode = statusCode;
    d.responseBody = responseBody;
    d.deliveredAt = new Date().toISOString();
  }

  async markDeliveryPending(id: string, attempts: number, scheduledAt: Date, statusCode: number | undefined, responseBody: string | undefined, lastError: string): Promise<void> {
    const d = this.deliveries.find((x) => x.id === id);
    if (!d) return;
    d.status = 'pending';
    d.success = false;
    d.attempts = attempts;
    d.scheduledAt = scheduledAt.toISOString();
    d.statusCode = statusCode;
    d.responseBody = responseBody;
    d.lastError = lastError;
  }

  async markDeliveryFailed(id: string, attempts: number, statusCode: number | undefined, responseBody: string | undefined, lastError: string): Promise<void> {
    const d = this.deliveries.find((x) => x.id === id);
    if (!d) return;
    d.status = 'failed';
    d.success = false;
    d.attempts = attempts;
    d.statusCode = statusCode;
    d.responseBody = responseBody;
    d.lastError = lastError;
    d.deliveredAt = new Date().toISOString();
  }

  async listDeliveries(endpointId: string, limit: number, offset = 0): Promise<WebhookDelivery[]> {
    return this.deliveries
      .filter((d) => d.endpointId === endpointId)
      .slice(offset, offset + limit)
      .map((d) => ({ ...d }));
  }

  async countDeliveries(endpointId: string): Promise<number> {
    return this.deliveries.filter((d) => d.endpointId === endpointId).length;
  }
}
