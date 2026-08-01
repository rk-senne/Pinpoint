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

// --- Retry helpers (pure, exported for testing) ---

/**
 * Returns true when the failure is transient and worth retrying.
 * Retryable: network/timeout error (no status), HTTP 429, or 5xx.
 * Non-retryable: any other 4xx (400, 401, 403, 404, 409, 422…) or success.
 */
export function isRetryableStatus(statusCode: number | undefined, errored: boolean): boolean {
  if (errored && statusCode === undefined) return true;
  if (statusCode === undefined) return false;
  if (statusCode === 429) return true;
  if (statusCode >= 500) return true;
  return false;
}

/**
 * Exponential backoff with deterministic linear jitter, capped.
 * Formula: min(cap, baseMs * 2^attempt) + (attempt * jitterStepMs)
 * attempt is 0-indexed (first retry = attempt 0).
 */
export function backoffDelayMs(
  attempt: number,
  baseMs = 1000,
  cap = 30_000,
  jitterStepMs = 200,
): number {
  const exponential = Math.min(cap, baseMs * Math.pow(2, attempt));
  return exponential + attempt * jitterStepMs;
}

// --- DispatchWebhook use case ---

export interface DispatchWebhookInput {
  orgId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
}

export interface DispatchWebhookDeps {
  webhookRepo: WebhookRepo;
  /** Max delivery attempts per endpoint (default 3). */
  maxAttempts?: number;
  /** Injectable delay function (default: real setTimeout-based sleep). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class DispatchWebhook {
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: DispatchWebhookDeps) {
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  async execute(input: DispatchWebhookInput): Promise<void> {
    const endpoints = await this.deps.webhookRepo.findByOrgAndEvent(input.orgId, input.eventType);
    for (const ep of endpoints) {
      if (!ep.active) continue;
      const body = JSON.stringify({ event: input.eventType, data: input.payload, timestamp: new Date().toISOString() });
      const signature = crypto.createHmac('sha256', ep.secret).update(body).digest('hex');

      let statusCode: number | undefined;
      let responseBody: string | undefined;
      let success = false;

      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        statusCode = undefined;
        responseBody = undefined;
        success = false;
        let errored = false;

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
          errored = true;
        }

        // Stop: success or non-retryable failure
        if (success || !isRetryableStatus(statusCode, errored)) break;

        // If attempts remain, backoff before next retry
        if (attempt < this.maxAttempts) {
          await this.sleep(backoffDelayMs(attempt - 1));
        }
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
