import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebhookEndpoint, WebhookDelivery } from '../Webhook.js';
import type { WebhookRepo } from '../ports/WebhookRepo.js';
import { DispatchWebhook, isRetryableStatus, backoffDelayMs } from '../usecases/webhooks.js';

// --- Fakes & helpers ---

interface DeliveryRecord {
  endpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
  statusCode?: number;
  responseBody?: string;
  success: boolean;
}

function makeFakeWebhookRepo(endpoints: WebhookEndpoint[] = []): WebhookRepo & { deliveries: DeliveryRecord[] } {
  const deliveries: DeliveryRecord[] = [];
  return {
    deliveries,
    insert: vi.fn() as any,
    listByOrg: vi.fn() as any,
    findById: vi.fn() as any,
    update: vi.fn() as any,
    delete: vi.fn() as any,
    listDeliveries: vi.fn() as any,
    findByOrgAndEvent: vi.fn(async () => endpoints),
    insertDelivery: vi.fn(async (d: Omit<WebhookDelivery, 'id' | 'deliveredAt'>) => {
      deliveries.push(d as DeliveryRecord);
    }),
  };
}

function makeEndpoint(overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint {
  return {
    id: 'ep-1',
    orgId: 'org-1',
    url: 'https://hook.example.com/wh',
    secret: 'test-secret',
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

// --- Tests ---

describe('isRetryableStatus', () => {
  it('returns true for network error (no status)', () => {
    expect(isRetryableStatus(undefined, true)).toBe(true);
  });

  it('returns true for 5xx codes', () => {
    expect(isRetryableStatus(500, false)).toBe(true);
    expect(isRetryableStatus(502, false)).toBe(true);
    expect(isRetryableStatus(503, false)).toBe(true);
    expect(isRetryableStatus(599, false)).toBe(true);
  });

  it('returns true for 429', () => {
    expect(isRetryableStatus(429, false)).toBe(true);
  });

  it('returns false for non-retryable 4xx', () => {
    expect(isRetryableStatus(400, false)).toBe(false);
    expect(isRetryableStatus(401, false)).toBe(false);
    expect(isRetryableStatus(403, false)).toBe(false);
    expect(isRetryableStatus(404, false)).toBe(false);
    expect(isRetryableStatus(409, false)).toBe(false);
    expect(isRetryableStatus(422, false)).toBe(false);
  });

  it('returns false for success codes', () => {
    expect(isRetryableStatus(200, false)).toBe(false);
    expect(isRetryableStatus(201, false)).toBe(false);
    expect(isRetryableStatus(204, false)).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('returns expected values for first 3 attempts', () => {
    // attempt 0: min(30000, 1000*2^0) + 0*200 = 1000
    expect(backoffDelayMs(0)).toBe(1000);
    // attempt 1: min(30000, 1000*2^1) + 1*200 = 2200
    expect(backoffDelayMs(1)).toBe(2200);
    // attempt 2: min(30000, 1000*2^2) + 2*200 = 4400
    expect(backoffDelayMs(2)).toBe(4400);
  });

  it('is monotonically increasing for early attempts', () => {
    let prev = 0;
    for (let i = 0; i < 10; i++) {
      const val = backoffDelayMs(i);
      expect(val).toBeGreaterThan(prev);
      prev = val;
    }
  });

  it('values are non-negative', () => {
    for (let i = 0; i < 20; i++) {
      expect(backoffDelayMs(i)).toBeGreaterThanOrEqual(0);
    }
  });

  it('caps the exponential component at 30_000', () => {
    // attempt 10: min(30000, 1000*1024) = 30000, + 10*200 = 32000
    const val = backoffDelayMs(10);
    expect(val).toBe(30_000 + 10 * 200);
    // Even at extreme attempts stays bounded
    expect(backoffDelayMs(100)).toBeLessThanOrEqual(30_000 + 100 * 200);
  });
});

describe('DispatchWebhook retry logic', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sleepMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    sleepMock = vi.fn(async () => {});
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function buildSut(endpoints: WebhookEndpoint[] = [makeEndpoint()], maxAttempts = 3) {
    const webhookRepo = makeFakeWebhookRepo(endpoints);
    const usecase = new DispatchWebhook({
      webhookRepo,
      maxAttempts,
      sleep: sleepMock,
    });
    return { usecase, webhookRepo };
  }

  const defaultInput = {
    orgId: 'org-1',
    eventType: 'annotation.created' as const,
    payload: { id: 'ann-1' },
  };

  it('AC1: immediate success — no retry, records success', async () => {
    fetchMock.mockReturnValueOnce(mockFetchResponse(200));
    const { usecase, webhookRepo } = buildSut();

    await usecase.execute(defaultInput);

    expect(webhookRepo.deliveries).toHaveLength(1);
    expect(webhookRepo.deliveries[0].success).toBe(true);
    expect(webhookRepo.deliveries[0].statusCode).toBe(200);
    expect(sleepMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AC2: transient 500 then success — retries once', async () => {
    fetchMock
      .mockReturnValueOnce(mockFetchResponse(500, 'Internal Server Error'))
      .mockReturnValueOnce(mockFetchResponse(200, 'OK'));
    const { usecase, webhookRepo } = buildSut();

    await usecase.execute(defaultInput);

    expect(webhookRepo.deliveries).toHaveLength(1);
    expect(webhookRepo.deliveries[0].success).toBe(true);
    expect(webhookRepo.deliveries[0].statusCode).toBe(200);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledWith(backoffDelayMs(0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('AC3: all attempts 503 — exhausted, records failure', async () => {
    fetchMock
      .mockReturnValue(mockFetchResponse(503, 'Service Unavailable'));
    const { usecase, webhookRepo } = buildSut();

    await usecase.execute(defaultInput);

    expect(webhookRepo.deliveries).toHaveLength(1);
    expect(webhookRepo.deliveries[0].success).toBe(false);
    expect(webhookRepo.deliveries[0].statusCode).toBe(503);
    expect(sleepMock).toHaveBeenCalledTimes(2); // maxAttempts - 1
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('AC4: 429 is retryable — retries and succeeds', async () => {
    fetchMock
      .mockReturnValueOnce(mockFetchResponse(429, 'Too Many Requests'))
      .mockReturnValueOnce(mockFetchResponse(200, 'OK'));
    const { usecase, webhookRepo } = buildSut();

    await usecase.execute(defaultInput);

    expect(webhookRepo.deliveries).toHaveLength(1);
    expect(webhookRepo.deliveries[0].success).toBe(true);
    expect(sleepMock).toHaveBeenCalledTimes(1);
  });

  it('AC5: non-retryable 400 — no retry', async () => {
    fetchMock.mockReturnValueOnce(mockFetchResponse(400, 'Bad Request'));
    const { usecase, webhookRepo } = buildSut();

    await usecase.execute(defaultInput);

    expect(webhookRepo.deliveries).toHaveLength(1);
    expect(webhookRepo.deliveries[0].success).toBe(false);
    expect(webhookRepo.deliveries[0].statusCode).toBe(400);
    expect(sleepMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AC6: non-retryable 404 — no retry', async () => {
    fetchMock.mockReturnValueOnce(mockFetchResponse(404, 'Not Found'));
    const { usecase, webhookRepo } = buildSut();

    await usecase.execute(defaultInput);

    expect(webhookRepo.deliveries).toHaveLength(1);
    expect(webhookRepo.deliveries[0].success).toBe(false);
    expect(webhookRepo.deliveries[0].statusCode).toBe(404);
    expect(sleepMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AC7: network error on all attempts — retries and records failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const { usecase, webhookRepo } = buildSut();

    await usecase.execute(defaultInput);

    expect(webhookRepo.deliveries).toHaveLength(1);
    expect(webhookRepo.deliveries[0].success).toBe(false);
    expect(webhookRepo.deliveries[0].statusCode).toBeUndefined();
    expect(webhookRepo.deliveries[0].responseBody).toContain('fetch failed');
    expect(sleepMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('AC8: network error then success — retries and records success', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockReturnValueOnce(mockFetchResponse(200, 'OK'));
    const { usecase, webhookRepo } = buildSut();

    await usecase.execute(defaultInput);

    expect(webhookRepo.deliveries).toHaveLength(1);
    expect(webhookRepo.deliveries[0].success).toBe(true);
    expect(webhookRepo.deliveries[0].statusCode).toBe(200);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('AC12: multiple endpoints are independent', async () => {
    const epA = makeEndpoint({ id: 'ep-A', url: 'https://a.example.com/wh' });
    const epB = makeEndpoint({ id: 'ep-B', url: 'https://b.example.com/wh' });

    // ep-A: all attempts fail with 500
    // ep-B: immediate success
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://a.example.com/wh') {
        return { status: 500, ok: false, text: async () => 'Server Error' } as Response;
      }
      return { status: 200, ok: true, text: async () => 'OK' } as Response;
    });

    const { usecase, webhookRepo } = buildSut([epA, epB]);

    await usecase.execute(defaultInput);

    expect(webhookRepo.deliveries).toHaveLength(2);

    const deliveryA = webhookRepo.deliveries.find((d) => d.endpointId === 'ep-A')!;
    const deliveryB = webhookRepo.deliveries.find((d) => d.endpointId === 'ep-B')!;

    expect(deliveryA.success).toBe(false);
    expect(deliveryA.statusCode).toBe(500);
    expect(deliveryB.success).toBe(true);
    expect(deliveryB.statusCode).toBe(200);
  });
});
