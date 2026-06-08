import crypto from 'node:crypto';
import type { WebhookEndpoint, WebhookEventType } from '../Webhook.js';
import { WEBHOOK_EVENTS } from '../Webhook.js';
import type { WebhookRepo } from '../ports/WebhookRepo.js';
import { type DomainError, type Result, ok, err, Validation, NotFound } from '../../shared/DomainError.js';

export interface RegisterWebhookInput {
  orgId: string;
  url: string;
  events: string[];
}

export interface RegisterWebhookDeps {
  webhookRepo: WebhookRepo;
}

export class RegisterWebhook {
  constructor(private readonly deps: RegisterWebhookDeps) {}

  async execute(input: RegisterWebhookInput): Promise<Result<{ endpoint: WebhookEndpoint }, DomainError>> {
    const invalid = input.events.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
    if (invalid.length > 0) {
      return err(new Validation(`Invalid event types: ${invalid.join(', ')}`));
    }
    try { new URL(input.url); } catch { return err(new Validation('Invalid URL')); }

    const secret = crypto.randomBytes(32).toString('hex');
    const endpoint = await this.deps.webhookRepo.insert({
      orgId: input.orgId,
      url: input.url,
      secret,
      events: input.events,
    });
    return ok({ endpoint });
  }
}

export interface DispatchWebhookInput {
  orgId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
}

export interface DispatchWebhookDeps {
  webhookRepo: WebhookRepo;
}

export class DispatchWebhook {
  constructor(private readonly deps: DispatchWebhookDeps) {}

  async execute(input: DispatchWebhookInput): Promise<void> {
    const endpoints = await this.deps.webhookRepo.findByOrgAndEvent(input.orgId, input.eventType);
    for (const ep of endpoints) {
      if (!ep.active) continue;
      const body = JSON.stringify({ event: input.eventType, data: input.payload, timestamp: new Date().toISOString() });
      const signature = crypto.createHmac('sha256', ep.secret).update(body).digest('hex');

      let statusCode: number | undefined;
      let responseBody: string | undefined;
      let success = false;

      try {
        const resp = await fetch(ep.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Pinpoint-Signature': signature,
            'X-Pinpoint-Event': input.eventType,
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        statusCode = resp.status;
        responseBody = await resp.text().catch(() => '');
        success = resp.ok;
      } catch (e: any) {
        responseBody = e.message;
      }

      await this.deps.webhookRepo.insertDelivery({
        endpointId: ep.id,
        eventType: input.eventType,
        payload: input.payload,
        statusCode,
        responseBody,
        success,
      }).catch(() => {});
    }
  }
}

export interface DeleteWebhookDeps {
  webhookRepo: WebhookRepo;
}

export class DeleteWebhook {
  constructor(private readonly deps: DeleteWebhookDeps) {}

  async execute(id: string, orgId: string): Promise<Result<void, DomainError>> {
    const deleted = await this.deps.webhookRepo.delete(id, orgId);
    if (!deleted) return err(new NotFound('Webhook not found'));
    return ok(undefined);
  }
}
