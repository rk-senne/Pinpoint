import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotificationWorker } from './notificationWorker.js';
import { FakeLogger } from '../../../__tests__/fakes/index.js';

afterEach(() => { vi.useRealTimers(); });

describe('createNotificationWorker', () => {
  it('dispatches with the configured batchSize on every interval and not before', async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValue({ dispatched: [] });
    const worker = createNotificationWorker({ dispatchPendingNotifications: { execute } as never, logger: new FakeLogger(), intervalMs: 1000, batchSize: 4 });
    worker.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2001);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledWith({ batchSize: 4 });
    await worker.stop();
  });

  it('defaults to a 5 s cadence and batch of 10', async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValue({});
    const worker = createNotificationWorker({ dispatchPendingNotifications: { execute } as never, logger: new FakeLogger() });
    worker.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(execute).toHaveBeenCalledWith({ batchSize: 10 });
    await worker.stop();
  });

  it('start() is idempotent and stop() prevents further ticks', async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValue({});
    const worker = createNotificationWorker({ dispatchPendingNotifications: { execute } as never, logger: new FakeLogger(), intervalMs: 100 });
    worker.start(); worker.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(execute).toHaveBeenCalledTimes(1);
    await worker.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('never crashes on a throwing tick and keeps ticking', async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockRejectedValueOnce(new Error('smtp down')).mockResolvedValue({});
    const logger = new FakeLogger();
    const error = vi.spyOn(logger, 'error');
    const worker = createNotificationWorker({ dispatchPendingNotifications: { execute } as never, logger, intervalMs: 100 });
    worker.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith({ error: 'smtp down' }, expect.stringContaining('threw'));
    await worker.stop();
  });

  it('skips (and warns) when the previous tick is still in flight; stop() drains it', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const execute = vi.fn().mockImplementation(() => new Promise<void>((r) => { release = r; }));
    const logger = new FakeLogger();
    const warn = vi.spyOn(logger, 'warn');
    const worker = createNotificationWorker({ dispatchPendingNotifications: { execute } as never, logger, intervalMs: 100 });
    worker.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    let stopped = false;
    const p = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await p;
    expect(stopped).toBe(true);
  });
});
