import type { Knex } from 'knex';
import type { WebhookEndpoint, WebhookDelivery } from '../../../domain/webhook/Webhook.js';
import type { WebhookRepo, NewWebhookEndpoint } from '../../../domain/webhook/ports/WebhookRepo.js';

export class PgWebhookRepo implements WebhookRepo {
  constructor(private readonly db: Knex) {}

  async insert(endpoint: NewWebhookEndpoint): Promise<WebhookEndpoint> {
    const [row] = await this.db('webhook_endpoints').insert({
      org_id: endpoint.orgId,
      url: endpoint.url,
      secret: endpoint.secret,
      events: JSON.stringify(endpoint.events),
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

  async update(id: string, orgId: string, updates: Partial<Pick<WebhookEndpoint, 'url' | 'events' | 'active'>>): Promise<WebhookEndpoint | null> {
    const patch: Record<string, unknown> = {};
    if (updates.url !== undefined) patch.url = updates.url;
    if (updates.events !== undefined) patch.events = JSON.stringify(updates.events);
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
      .whereRaw('events @> ?', [JSON.stringify([eventType])]);
    return rows.map((r: any) => this.map(r));
  }

  async insertDelivery(delivery: Omit<WebhookDelivery, 'id' | 'deliveredAt'>): Promise<void> {
    await this.db('webhook_deliveries').insert({
      endpoint_id: delivery.endpointId,
      event_type: delivery.eventType,
      payload: JSON.stringify(delivery.payload),
      status_code: delivery.statusCode ?? null,
      response_body: delivery.responseBody ?? null,
      success: delivery.success,
    });
  }

  async listDeliveries(endpointId: string, limit: number): Promise<WebhookDelivery[]> {
    const rows = await this.db('webhook_deliveries')
      .where({ endpoint_id: endpointId })
      .orderBy('delivered_at', 'desc')
      .limit(limit);
    return rows.map((r: any) => this.mapDelivery(r));
  }

  private map(row: any): WebhookEndpoint {
    return {
      id: row.id,
      orgId: row.org_id,
      url: row.url,
      secret: row.secret,
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
    };
  }
}
