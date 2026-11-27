import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebhookEndpoint } from '../Webhook.js';
import { FakeWebhookRepo } from '../../../__tests__/fakes/index.js';
import {
  DispatchWebhook,
  DispatchWebhookDeliveries,
  isRetryableStatus,
  backoffDelayMs,
  truncateResponseBody,
  MAX_RESPONSE_BODY_BYTES,
} from '../usecases/webhooks.js';
import { verifySignature, isWhsecSecret } from '../../../services/standardWebhooks.js';

// --- helpers ---

function makeEndpoint(overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint {
  return {
    id: 'ep-1',
    orgId: 'org-1',
    url: 'https://hook.example.com/wh',
    secret: 'whsec_' + Buffer.alloc(32, 9).toString('base64'),
    events: ['annotation.created'],
    active: true,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockFetchResponse(status: number, body = 'ok') {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(body),
  } as Response);
}

// --- pure helpers (unchanged from A5a) ---

describe('isRetryableStatus', () => {
  it('returns true for network error (no status)', () => {
    expect(isRetryableStatus(undefined, true)).toBe(true);
  });

  it('returns true for 5xx + 429', () => {
    expect(isRetryableStatus(500, false)).toBe(true);
    expect(isRetryableStatus(503, false)).toBe(true);
    expect(isRetryableStatus(429, false)).toBe(true);
  });

  it('returns false for non-retryable 4xx and success', () => {
    expect(isRetryableStatus(400, false)).toBe(false);
    expect(isRetryableStatus(404, false)).toBe(false);
    expect(isRetryableStatus(200, false)).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('returns expected values for first 3 attempts', () => {
    expect(backoffDelayMs(0)).toBe(1000);
    expect(backoffDelayMs(1)).toBe(2200);
    expect(backoffDelayMs(2)).toBe(4400);
  });

  it('caps the exponential component at 30_000', () => {
    expect(backoffDelayMs(10)).toBe(30_000 + 10 * 200);
  });
});

// --- DispatchWebhook: enqueue only ---

describe('DispatchWebhook (enqueue side, A5b)', () => {
  it('enqueues one pending delivery per matching active endpoint', async () => {
    const repo = new FakeWebhookRepo([
      makeEndpoint({ id: 'ep-A' }),
      makeEndpoint({ id: 'ep-B' }),
      makeEndpoint({ id: 'ep-inactive', active: false }),
    ]);
    const uc = new DispatchWebhook({ webhookRepo: repo, generateMsgId: () => 'msg-fixed' });

    await uc.execute({ orgId: 'org-1', eventType: 'annotation.created', payload: { id: 'a1' } });

    expect(repo.deliveries).toHaveLength(2);
    for (const d of repo.deliveries) {
      expect(d.status).toBe('pending');
      expect(d.attempts).toBe(0);
      expect(d.msgId).toBe('msg-fixed');
    }
  });

  it('performs no network I/O (enqueue is synchronous DB-only)', async () => {
    const repo = new FakeWebhookRepo([makeEndpoint()]);
    const uc = new DispatchWebhook({ webhookRepo: repo });
    // No safeFetch dependency exists on DispatchWebhook anymore — enqueue only.
    await uc.execute({ orgId: 'org-1', eventType: 'annotation.created', payload: {} });
    expect(repo.deliveries).toHaveLength(1);
  });

  it('generates a unique msgId per delivery by default', async () => {
    const repo = new FakeWebhookRepo([makeEndpoint({ id: 'ep-A' }), makeEndpoint({ id: 'ep-B' })]);
    const uc = new DispatchWebhook({ webhookRepo: repo });
    await uc.execute({ orgId: 'org-1', eventType: 'annotation.created', payload: {} });
    const ids = repo.deliveries.map((d) => d.msgId);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.startsWith('msg_'))).toBe(true);
  });
});

// --- DispatchWebhookDeliveries: worker consumer side ---

describe('DispatchWebhookDeliveries (worker side, A5b)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  async function seed(repo: FakeWebhookRepo, endpoint: WebhookEndpoint, msgId = 'msg-1') {
    repo.endpoints.push(endpoint);
    await repo.enqueueDelivery({
      endpointId: endpoint.id,
      eventType: 'annotation.created',
      payload: { id: 'a1' },
      msgId,
      scheduledAt: new Date(0),
    });
  }

  it('AC1: immediate success → marks sent, no reschedule', async () => {
    const repo = new FakeWebhookRepo();
    await seed(repo, makeEndpoint());
    fetchMock.mockReturnValueOnce(mockFetchResponse(200));
    const worker = new DispatchWebhookDeliveries({ webhookRepo: repo, safeFetch: fetchMock as never });

    const { dispatched } = await worker.execute();

    expect(dispatched).toEqual([{ id: repo.deliveries[0].id, outcome: 'sent' }]);
    expect(repo.deliveries[0].status).toBe('sent');
    expect(repo.deliveries[0].success).toBe(true);
    expect(repo.deliveries[0].statusCode).toBe(200);
    expect(repo.deliveries[0].attempts).toBe(1);
  });

  it('AC2: transient 500 → stays pending, reschedules with backoff', async () => {
    const repo = new FakeWebhookRepo();
    await seed(repo, makeEndpoint());
    fetchMock.mockReturnValueOnce(mockFetchResponse(500, 'oops'));
    const now = new Date(1_000_000);
    const worker = new DispatchWebhookDeliveries({ webhookRepo: repo, safeFetch: fetchMock as never, now: () => now });

    const { dispatched } = await worker.execute();

    expect(dispatched[0].outcome).toBe('retry');
    const d = repo.deliveries[0];
    expect(d.status).toBe('pending');
    expect(d.attempts).toBe(1);
    // scheduled_at pushed forward by backoffDelayMs(0) = 1000ms
    expect(new Date(d.scheduledAt).getTime()).toBe(now.getTime() + backoffDelayMs(0));
    expect(d.lastError).toContain('500');
  });

  it('AC3: retryable failure at the last allowed attempt → failed', async () => {
    const repo = new FakeWebhookRepo();
    const ep = makeEndpoint();
    repo.endpoints.push(ep);
    // Pre-set attempts=2 so next attempt (3) is the last with maxAttempts=3.
    await repo.enqueueDelivery({ endpointId: ep.id, eventType: 'annotation.created', payload: {}, msgId: 'm', scheduledAt: new Date(0) });
    repo.deliveries[0].attempts = 2;
    fetchMock.mockReturnValueOnce(mockFetchResponse(503));
    const worker = new DispatchWebhookDeliveries({ webhookRepo: repo, safeFetch: fetchMock as never, maxAttempts: 3 });

    const { dispatched } = await worker.execute();

    expect(dispatched[0].outcome).toBe('failed');
    expect(repo.deliveries[0].status).toBe('failed');
    expect(repo.deliveries[0].attempts).toBe(3);
  });

  it('AC5: non-retryable 400 → immediate failed, no reschedule', async () => {
    const repo = new FakeWebhookRepo();
    await seed(repo, makeEndpoint());
    fetchMock.mockReturnValueOnce(mockFetchResponse(400, 'bad'));
    const worker = new DispatchWebhookDeliveries({ webhookRepo: repo, safeFetch: fetchMock as never });

    await worker.execute();

    expect(repo.deliveries[0].status).toBe('failed');
    expect(repo.deliveries[0].statusCode).toBe(400);
    expect(repo.deliveries[0].attempts).toBe(1);
  });

  it('AC7: network error → retryable, stays pending', async () => {
    const repo = new FakeWebhookRepo();
    await seed(repo, makeEndpoint());
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const worker = new DispatchWebhookDeliveries({ webhookRepo: repo, safeFetch: fetchMock as never });

    const { dispatched } = await worker.execute();

    expect(dispatched[0].outcome).toBe('retry');
    expect(repo.deliveries[0].status).toBe('pending');
    expect(repo.deliveries[0].lastError).toContain('fetch failed');
  });

  it('missing endpoint → failed', async () => {
    const repo = new FakeWebhookRepo();
    await repo.enqueueDelivery({ endpointId: 'gone', eventType: 'annotation.created', payload: {}, msgId: 'm', scheduledAt: new Date(0) });
    const worker = new DispatchWebhookDeliveries({ webhookRepo: repo, safeFetch: fetchMock as never });

    await worker.execute();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(repo.deliveries[0].status).toBe('failed');
    expect(repo.deliveries[0].lastError).toContain('endpoint not found');
  });

  it('A5a: truncates persisted responseBody to <=1KiB', async () => {
    const repo = new FakeWebhookRepo();
    await seed(repo, makeEndpoint());
    fetchMock.mockReturnValueOnce(mockFetchResponse(200, 'x'.repeat(5000)));
    const worker = new DispatchWebhookDeliveries({ webhookRepo: repo, safeFetch: fetchMock as never });

    await worker.execute();

    const stored = repo.deliveries[0].responseBody!;
    expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(MAX_RESPONSE_BODY_BYTES);
  });

  it('A5b: emits standard-webhooks headers with a verifiable signature + stable msgId', async () => {
    const repo = new FakeWebhookRepo();
    const ep = makeEndpoint();
    await seed(repo, ep, 'msg-stable');
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = '';
    fetchMock.mockImplementationOnce(async (_url: string, init: any) => {
      capturedHeaders = init.headers;
      capturedBody = init.body;
      return mockFetchResponse(200);
    });
    const worker = new DispatchWebhookDeliveries({ webhookRepo: repo, safeFetch: fetchMock as never });

    await worker.execute();

    expect(capturedHeaders['webhook-id']).toBe('msg-stable');
    expect(capturedHeaders['webhook-timestamp']).toMatch(/^\d+$/);
    expect(capturedHeaders['webhook-signature']).toMatch(/^v1,/);
    expect(isWhsecSecret(ep.secret)).toBe(true);

    const ts = Number(capturedHeaders['webhook-timestamp']);
    expect(
      verifySignature(ep.secret, 'msg-stable', ts, capturedBody, capturedHeaders['webhook-signature']),
    ).toBe(true);
  });

  it('claims at most batchSize rows per tick', async () => {
    const repo = new FakeWebhookRepo();
    const ep = makeEndpoint();
    repo.endpoints.push(ep);
    for (let i = 0; i < 5; i++) {
      await repo.enqueueDelivery({ endpointId: ep.id, eventType: 'annotation.created', payload: {}, msgId: `m${i}`, scheduledAt: new Date(0) });
    }
    fetchMock.mockReturnValue(mockFetchResponse(200));
    const worker = new DispatchWebhookDeliveries({ webhookRepo: repo, safeFetch: fetchMock as never });

    const { dispatched } = await worker.execute({ batchSize: 2 });

    expect(dispatched).toHaveLength(2);
  });
});

describe('truncateResponseBody', () => {
  it('returns undefined unchanged', () => {
    expect(truncateResponseBody(undefined)).toBeUndefined();
  });
  it('keeps short bodies intact', () => {
    expect(truncateResponseBody('ok')).toBe('ok');
  });
  it('caps long bodies to the byte limit', () => {
    const out = truncateResponseBody('a'.repeat(10_000))!;
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_RESPONSE_BODY_BYTES);
  });
  it('does not emit invalid trailing multi-byte sequences', () => {
    const out = truncateResponseBody('€'.repeat(2000))!;
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_RESPONSE_BODY_BYTES);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

describe('FakeWebhookRepo claim mirrors the Pg lease contract', () => {
  it('a claimed delivery is not handed to a second claim until re-queued', async () => {
    const { FakeWebhookRepo } = await import('../../../__tests__/fakes/FakeWebhookRepo.js');
    const repo = new FakeWebhookRepo();
    await repo.enqueueDelivery({
      endpointId: 'ep-1',
      eventType: 'annotation.created',
      payload: {},
      msgId: 'msg_1',
      scheduledAt: new Date(Date.now() - 1000),
    } as never);
    const first = await repo.claimDueDeliveries(10, new Date());
    const second = await repo.claimDueDeliveries(10, new Date());
    expect(first).toHaveLength(1);
    // Regression: the Pg claim released its locks with rows still `pending`,
    // so concurrent workers re-sent the same delivery.
    expect(second).toHaveLength(0);
    await repo.markDeliveryPending(first[0]!.id, 1, new Date(Date.now() - 1), 500, '', 'retry');
    expect(await repo.claimDueDeliveries(10, new Date())).toHaveLength(1);
  });
});
