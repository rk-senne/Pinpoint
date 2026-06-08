import type { WebhookEndpoint, WebhookDelivery } from '../Webhook.js';

export interface NewWebhookEndpoint {
  orgId: string;
  url: string;
  secret: string;
  events: string[];
}

export interface WebhookRepo {
  insert(endpoint: NewWebhookEndpoint): Promise<WebhookEndpoint>;
  listByOrg(orgId: string): Promise<WebhookEndpoint[]>;
  findById(id: string, orgId: string): Promise<WebhookEndpoint | null>;
  update(id: string, orgId: string, updates: Partial<Pick<WebhookEndpoint, 'url' | 'events' | 'active'>>): Promise<WebhookEndpoint | null>;
  delete(id: string, orgId: string): Promise<boolean>;
  findByOrgAndEvent(orgId: string, eventType: string): Promise<WebhookEndpoint[]>;
  insertDelivery(delivery: Omit<WebhookDelivery, 'id' | 'deliveredAt'>): Promise<void>;
  listDeliveries(endpointId: string, limit: number): Promise<WebhookDelivery[]>;
}
