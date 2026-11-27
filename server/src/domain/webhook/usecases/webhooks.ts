import crypto from 'node:crypto';
import type { WebhookEndpoint, WebhookDelivery, WebhookEventType } from '../Webhook.js';
import { WEBHOOK_EVENTS } from '../Webhook.js';
import type { WebhookRepo } from '../ports/WebhookRepo.js';
import { type DomainError, type Result, ok, err, Validation, NotFound } from '../../shared/DomainError.js';
import { generateSecret, buildSignatureHeaders } from '../../../services/standardWebhooks.js';

/**
 * Structural types for the SSRF egress guard (Mission A5a). The concrete
 * implementation lives in the infrastructure layer (`services/egressGuard.ts`)
 * and is injected by the composition root — the domain stays free of undici /
 * node:dns per the hexagonal boundary documented in DomainError.ts.
 */
export type AssertPublicUrlFn = (url: string) => Promise<unknown>;
export type SafeFetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; ok: boolean; text: () => Promise<string> }>;

/** Duck-typed detection of the egress guard's block error without importing it. */
function isEgressBlockedError(e: unknown): boolean {
  return e instanceof Error && e.name === 'EgressBlockedError';
}

/** Persisted webhook response bodies are capped at 1 KiB (Mission A5a). */
export const MAX_RESPONSE_BODY_BYTES = 1024;

/** Truncate a response body to at most MAX_RESPONSE_BODY_BYTES bytes. */
export function truncateResponseBody(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  if (Buffer.byteLength(body, 'utf8') <= MAX_RESPONSE_BODY_BYTES) return body;
  // Slice by bytes, then use a streaming decoder so any trailing partial
  // multi-byte UTF-8 sequence is dropped rather than turned into a 3-byte
  // replacement character (which would push us back over the cap).
  const buf = Buffer.from(body, 'utf8').subarray(0, MAX_RESPONSE_BODY_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  // `stream: true` withholds any incomplete sequence at the end of the chunk;
  // not calling a final flush means that partial tail is simply discarded.
  return decoder.decode(buf, { stream: true });
}

export interface RegisterWebhookInput {
  orgId: string;
  url: string;
  events: string[];
}

export interface RegisterWebhookDeps {
  webhookRepo: WebhookRepo;
  /**
   * SSRF guard injected by the composition root. When omitted (e.g. unit
   * tests that only exercise event validation) the URL public-reachability
   * check is skipped.
   */
  assertPublicUrl?: AssertPublicUrlFn;
}

export class RegisterWebhook {
  private readonly assertPublicUrl?: AssertPublicUrlFn;

  constructor(private readonly deps: RegisterWebhookDeps) {
    this.assertPublicUrl = deps.assertPublicUrl;
  }

  async execute(input: RegisterWebhookInput): Promise<Result<{ endpoint: WebhookEndpoint }, DomainError>> {
    const invalid = input.events.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
    if (invalid.length > 0) {
      return err(new Validation(`Invalid event types: ${invalid.join(', ')}`));
    }
    try { new URL(input.url); } catch { return err(new Validation('Invalid URL')); }

    // Reject non-public / non-https URLs at registration so a hostile endpoint
    // never reaches the dispatch path (Mission A5a).
    if (this.assertPublicUrl) {
      try {
        await this.assertPublicUrl(input.url);
      } catch (e) {
        if (isEgressBlockedError(e)) {
          return err(new Validation(`Webhook URL rejected: ${(e as Error).message}`));
        }
        return err(new Validation('Webhook URL rejected'));
      }
    }

    // Standard Webhooks `whsec_`-prefixed secret (Mission A5b). The plaintext
    // secret is returned to the caller exactly once (on create); subsequent
    // reads never expose it.
    const secret = generateSecret();
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

// --- DispatchWebhook use case (enqueue side, Mission A5b) ---

export interface DispatchWebhookInput {
  orgId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
}

export interface DispatchWebhookDeps {
  webhookRepo: WebhookRepo;
  /** Clock for the initial `scheduledAt` (default: real now). */
  now?: () => Date;
  /** Stable msgId generator (default: random uuid). Injectable for tests. */
  generateMsgId?: () => string;
}

/**
 * DispatchWebhook now ONLY enqueues durable delivery rows (Mission A5b). For
 * each matching active endpoint it inserts a `pending` `webhook_deliveries`
 * row with a stable `msgId` and `scheduled_at = now` BEFORE any network I/O.
 * The webhook delivery worker (DispatchWebhookDeliveries) performs the actual
 * HTTP with backoff, so a SIGTERM mid-flight can never drop a delivery — the
 * pending row survives and is reclaimed after restart.
 */
export class DispatchWebhook {
  private readonly now: () => Date;
  private readonly generateMsgId: () => string;

  constructor(private readonly deps: DispatchWebhookDeps) {
    this.now = deps.now ?? (() => new Date());
    this.generateMsgId = deps.generateMsgId ?? (() => `msg_${crypto.randomUUID()}`);
  }

  async execute(input: DispatchWebhookInput): Promise<void> {
    const endpoints = await this.deps.webhookRepo.findByOrgAndEvent(input.orgId, input.eventType);
    const scheduledAt = this.now();
    for (const ep of endpoints) {
      if (!ep.active) continue;
      await this.deps.webhookRepo.enqueueDelivery({
        endpointId: ep.id,
        eventType: input.eventType,
        payload: input.payload,
        msgId: this.generateMsgId(),
        scheduledAt,
      }).catch(() => {});
    }
  }
}

// --- DispatchWebhookDeliveries use case (worker consumer side, Mission A5b) ---

export interface DispatchWebhookDeliveriesInput {
  /** Maximum number of rows to claim this tick. Defaults to 10. */
  batchSize?: number;
}

export interface DispatchedWebhookDelivery {
  id: string;
  outcome: 'sent' | 'retry' | 'failed';
}

export interface DispatchWebhookDeliveriesDeps {
  webhookRepo: WebhookRepo;
  /** Max delivery attempts per row (default 3). */
  maxAttempts?: number;
  /** Clock (default: real now). */
  now?: () => Date;
  /** SSRF-safe fetch injected by the composition root. */
  safeFetch?: SafeFetchFn;
}

const globalFetchAsSafeFetch: SafeFetchFn = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<SafeFetchFn>;

export class DispatchWebhookDeliveries {
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly safeFetch: SafeFetchFn;

  constructor(private readonly deps: DispatchWebhookDeliveriesDeps) {
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.now = deps.now ?? (() => new Date());
    this.safeFetch = deps.safeFetch ?? globalFetchAsSafeFetch;
  }

  async execute(input: DispatchWebhookDeliveriesInput = {}): Promise<{ dispatched: DispatchedWebhookDelivery[] }> {
    const batchSize = input.batchSize ?? 10;
    const rows = await this.deps.webhookRepo.claimDueDeliveries(batchSize, this.now());
    const dispatched: DispatchedWebhookDelivery[] = [];

    for (const row of rows) {
      const outcome = await this.deliverOne(row);
      dispatched.push({ id: row.id, outcome });
    }
    return { dispatched };
  }

  private async deliverOne(row: WebhookDelivery): Promise<'sent' | 'retry' | 'failed'> {
    const endpoint = await this.deps.webhookRepo.findEndpointById(row.endpointId);
    const attempts = row.attempts + 1;

    if (!endpoint) {
      await this.deps.webhookRepo.markDeliveryFailed(row.id, attempts, undefined, undefined, 'endpoint not found');
      return 'failed';
    }

    const body = JSON.stringify({ event: row.eventType, data: row.payload, timestamp: new Date().toISOString() });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Pinpoint-Event': row.eventType,
      ...buildSignatureHeaders(endpoint.secret, row.msgId, body),
    };

    let statusCode: number | undefined;
    let responseBody: string | undefined;
    let errored = false;

    try {
      const resp = await this.safeFetch(endpoint.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      statusCode = resp.status;
      responseBody = await readCappedText(resp, MAX_RESPONSE_BODY_BYTES);
      if (resp.ok) {
        await this.deps.webhookRepo.markDeliverySent(row.id, attempts, statusCode, truncateResponseBody(responseBody));
        return 'sent';
      }
    } catch (e) {
      responseBody = e instanceof Error ? e.message : String(e);
      errored = true;
    }

    const truncated = truncateResponseBody(responseBody);
    const lastError = errored ? (responseBody ?? 'network error') : `HTTP ${statusCode}`;

    // Non-retryable failure or attempts exhausted → terminal failure.
    if (!isRetryableStatus(statusCode, errored) || attempts >= this.maxAttempts) {
      await this.deps.webhookRepo.markDeliveryFailed(row.id, attempts, statusCode, truncated, lastError);
      return 'failed';
    }

    // Retryable: reschedule with backoff (attempt index is 0-based).
    const delayMs = backoffDelayMs(attempts - 1);
    const scheduledAt = new Date(this.now().getTime() + delayMs);
    await this.deps.webhookRepo.markDeliveryPending(row.id, attempts, scheduledAt, statusCode, truncated, lastError);
    return 'retry';
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

/**
 * Read at most `maxBytes` of a delivery response body. Only a ≤1 KiB prefix
 * is ever persisted, so there is no reason to buffer an endpoint's full
 * (possibly unbounded) response. Domain-local on purpose: the domain layer
 * must not import infrastructure (services/egressGuard).
 */
async function readCappedText(
  resp: { body?: ReadableStream<Uint8Array> | null; text?: () => Promise<string> },
  maxBytes: number,
): Promise<string> {
  if (!resp.body) return resp.text ? await resp.text().catch(() => '') : '';
  const reader = resp.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value.subarray(0, maxBytes - total));
      total += Math.min(value.byteLength, maxBytes - total);
    }
  } catch {
    // keep what was read
  } finally {
    reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { joined.set(p, off); off += p.byteLength; }
  return new TextDecoder('utf-8').decode(joined);
}
