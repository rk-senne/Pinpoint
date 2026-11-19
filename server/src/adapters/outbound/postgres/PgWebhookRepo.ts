import type { Knex } from 'knex';
import type { WebhookEndpoint, WebhookDelivery, WebhookDeliveryStatus } from '../../../domain/webhook/Webhook.js';
import { SecretBox, isEncrypted } from '../../../services/secretBox.js';
import type { WebhookRepo, NewWebhookEndpoint, NewWebhookDelivery } from '../../../domain/webhook/ports/WebhookRepo.js';

/** How long a claimed delivery is leased to one worker before it can be re-claimed. */
export const WEBHOOK_CLAIM_LEASE_MS = 2 * 60_000;

export class PgWebhookRepo implements WebhookRepo {
  /**
   * `secretBox` encrypts the signing secret at rest (PP-11). Without one the repo
   * stays plaintext (unit tests). Legacy plaintext rows are read transparently and
   * re-encrypted by migration 20261116000501.
   */
  constructor(private readonly db: Knex, private readonly secretBox?: SecretBox) {}

  async insert(endpoint: NewWebhookEndpoint): Promise<WebhookEndpoint> {
    const [row] = await this.db('webhook_endpoints').insert({
      org_id: endpoint.orgId,
      url: endpoint.url,
      secret: this.secretBox ? this.secretBox.encrypt(endpoint.secret) : endpoint.secret,
      // `events` is a Postgres text[]: pass a JS array (pg serializes it).
      events: endpoint.events,
    }).returning('*');
    return this.map(row);
  }

  async listByOrg(orgId: string): Promise<WebhookEndpoint[]> {
    const rows = await this.db('webhook_endpoints').where({ org_id: orgId }).orderBy('created_at', 'desc');
    return rows.map((r: any) => this.map(r));
  }

  async findById(id: string, orgId: string): Promise<WebhookEndpoint | null> {
    const row = await this.db('webhook_endpoints').where({ id, org_id: orgId }).first();
    return row ? this.map(row) : null;
  }

  async findEndpointById(id: string): Promise<WebhookEndpoint | null> {
    const row = await this.db('webhook_endpoints').where({ id }).first();
    return row ? this.map(row) : null;
  }

  async update(id: string, orgId: string, updates: Partial<Pick<WebhookEndpoint, 'url' | 'events' | 'active'>>): Promise<WebhookEndpoint | null> {
    const patch: Record<string, unknown> = {};
    if (updates.url !== undefined) patch.url = updates.url;
    if (updates.events !== undefined) patch.events = updates.events;
    if (updates.active !== undefined) patch.active = updates.active;
    patch.updated_at = this.db.fn.now();

    const [row] = await this.db('webhook_endpoints')
      .where({ id, org_id: orgId })
      .update(patch)
      .returning('*');
    return row ? this.map(row) : null;
  }

  async delete(id: string, orgId: string): Promise<boolean> {
    const count = await this.db('webhook_endpoints').where({ id, org_id: orgId }).del();
    return count > 0;
  }

  async findByOrgAndEvent(orgId: string, eventType: string): Promise<WebhookEndpoint[]> {
    const rows = await this.db('webhook_endpoints')
      .where({ org_id: orgId, active: true })
      .whereRaw('events @> ?::text[]', [[eventType]]);
    return rows.map((r: any) => this.map(r));
  }

  // --- durable delivery queue (Mission A5b) ---

  async enqueueDelivery(delivery: NewWebhookDelivery): Promise<string> {
    const [row] = await this.db('webhook_deliveries')
      .insert({
        endpoint_id: delivery.endpointId,
        event_type: delivery.eventType,
        payload: JSON.stringify(delivery.payload),
        msg_id: delivery.msgId,
        status: 'pending',
        attempts: 0,
        scheduled_at: delivery.scheduledAt,
        success: false,
      })
      .returning('id');
    return typeof row === 'string' ? row : row.id;
  }

  /**
   * Atomically claim up to `limit` due deliveries for THIS worker.
   *
   * A single UPDATE … RETURNING flips the selected rows to `processing` with
   * a `locked_until` lease, so the claim is visible to every other worker
   * the moment it commits. (A bare `SELECT … FOR UPDATE SKIP LOCKED` in a
   * short transaction releases its locks before the HTTP send while rows are
   * still `pending`, which let concurrent workers / later ticks re-send the
   * same deliveries.) Rows whose lease expired — a worker crashed mid-send —
   * are claimable again, preserving at-least-once delivery.
   */
  async claimDueDeliveries(limit: number, now: Date, leaseMs = WEBHOOK_CLAIM_LEASE_MS): Promise<WebhookDelivery[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const result = await this.db.raw(
      `UPDATE webhook_deliveries d
          SET status = 'processing', locked_until = ?
        WHERE d.id IN (
          SELECT id
            FROM webhook_deliveries
           WHERE (status = 'pending' AND scheduled_at <= ?)
              OR (status = 'processing' AND locked_until <= ?)
           ORDER BY scheduled_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED
        )
        RETURNING d.*`,
      [leaseUntil, now, now, limit],
    );
    const rows: any[] = Array.isArray(result) ? result : (result?.rows ?? []);
    return rows.map((r) => this.mapDelivery(r));
  }

  async markDeliverySent(id: string, attempts: number, statusCode: number | undefined, responseBody: string | undefined): Promise<void> {
    await this.db('webhook_deliveries').where({ id }).update({
      status: 'sent',
      locked_until: null,
      success: true,
      attempts,
      status_code: statusCode ?? null,
      response_body: responseBody ?? null,
      delivered_at: this.db.fn.now(),
    });
  }

  async markDeliveryPending(id: string, attempts: number, scheduledAt: Date, statusCode: number | undefined, responseBody: string | undefined, lastError: string): Promise<void> {
    await this.db('webhook_deliveries').where({ id }).update({
      status: 'pending',
      locked_until: null,
      success: false,
      attempts,
      scheduled_at: scheduledAt,
      status_code: statusCode ?? null,
      response_body: responseBody ?? null,
      last_error: lastError,
    });
  }

  async markDeliveryFailed(id: string, attempts: number, statusCode: number | undefined, responseBody: string | undefined, lastError: string): Promise<void> {
    await this.db('webhook_deliveries').where({ id }).update({
      status: 'failed',
      locked_until: null,
      success: false,
      attempts,
      status_code: statusCode ?? null,
      response_body: responseBody ?? null,
      last_error: lastError,
      delivered_at: this.db.fn.now(),
    });
  }

  async listDeliveries(endpointId: string, limit: number, offset = 0): Promise<WebhookDelivery[]> {
    const rows = await this.db('webhook_deliveries')
      .where({ endpoint_id: endpointId })
      .orderBy('delivered_at', 'desc')
      .limit(limit)
      .offset(offset);
    return rows.map((r: any) => this.mapDelivery(r));
  }

  async countDeliveries(endpointId: string): Promise<number> {
    const [{ count }] = await this.db('webhook_deliveries')
      .where({ endpoint_id: endpointId })
      .count('* as count');
    return Number(count);
  }

  private map(row: any): WebhookEndpoint {
    return {
      id: row.id,
      orgId: row.org_id,
      url: row.url,
      secret: this.secretBox && isEncrypted(row.secret) ? this.secretBox.decrypt(row.secret) : row.secret,
      events: typeof row.events === 'string' ? JSON.parse(row.events) : row.events,
      active: row.active,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  }

  private mapDelivery(row: any): WebhookDelivery {
    return {
      id: row.id,
      endpointId: row.endpoint_id,
      eventType: row.event_type,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      statusCode: row.status_code ?? undefined,
      responseBody: row.response_body ?? undefined,
      success: row.success,
      deliveredAt: row.delivered_at instanceof Date ? row.delivered_at.toISOString() : row.delivered_at,
      status: (row.status ?? 'pending') as WebhookDeliveryStatus,
      attempts: row.attempts ?? 0,
      scheduledAt: row.scheduled_at instanceof Date ? row.scheduled_at.toISOString() : row.scheduled_at,
      msgId: row.msg_id ?? '',
      ...(row.last_error ? { lastError: row.last_error } : {}),
    };
  }
}
