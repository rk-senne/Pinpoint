import { describe, it, expect, vi } from 'vitest';
import { createWebhookDeliveryWorker } from './webhookDeliveryWorker.js';
import { FakeLogger } from '../../../__tests__/fakes/index.js';

function makeDispatcher() {
  return { execute: vi.fn().mockResolvedValue({ dispatched: [] }) };
}

describe('createWebhookDeliveryWorker', () => {
  it('invokes the use case on a timer tick with the configured batchSize', async () => {
    vi.useFakeTimers();
    const dispatcher = makeDispatcher();
    const worker = createWebhookDeliveryWorker({
      dispatchWebhookDeliveries: dispatcher as never,
      logger: new FakeLogger(),
      intervalMs: 1000,
      batchSize: 7,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(dispatcher.execute).toHaveBeenCalledWith({ batchSize: 7 });
    await worker.stop();
    vi.useRealTimers();
  });

  it('start() is idempotent (no double interval)', async () => {
    vi.useFakeTimers();
    const dispatcher = makeDispatcher();
    const worker = createWebhookDeliveryWorker({
      dispatchWebhookDeliveries: dispatcher as never,
      logger: new FakeLogger(),
      intervalMs: 1000,
    });

    worker.start();
    worker.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(dispatcher.execute).toHaveBeenCalledTimes(1);
    await worker.stop();
    vi.useRealTimers();
  });

  it('catches + logs a thrown tick without crashing', async () => {
    vi.useFakeTimers();
    const dispatcher = { execute: vi.fn().mockRejectedValue(new Error('boom')) };
    const logger = new FakeLogger();
    const worker = createWebhookDeliveryWorker({
      dispatchWebhookDeliveries: dispatcher as never,
      logger,
      intervalMs: 1000,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(logger.logs.some((r) => r.level === 'error')).toBe(true);
    await worker.stop();
    vi.useRealTimers();
  });
});
