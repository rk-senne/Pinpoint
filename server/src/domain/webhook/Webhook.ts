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

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
  statusCode?: number;
  responseBody?: string;
  success: boolean;
  deliveredAt: string;
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
