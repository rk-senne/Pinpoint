import { afterEach, describe, expect, it, vi } from 'vitest';

const refreshExpiredTokens = vi.fn();
vi.mock('../../../services/integrationTokenRefresh.js', () => ({ refreshExpiredTokens: (...a: unknown[]) => refreshExpiredTokens(...a) }));

import { createIntegrationRefreshWorker } from './integrationRefreshWorker.js';
import { FakeLogger } from '../../../__tests__/fakes/index.js';

afterEach(() => { vi.useRealTimers(); refreshExpiredTokens.mockReset(); });

describe('createIntegrationRefreshWorker', () => {
  it('refreshes tokens with the db handle every interval (default 5 min)', async () => {
    vi.useFakeTimers();
    refreshExpiredTokens.mockResolvedValue(undefined);
    const db = {} as never;
    const worker = createIntegrationRefreshWorker({ db, logger: new FakeLogger() });
    worker.start(); worker.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(refreshExpiredTokens).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshExpiredTokens).toHaveBeenCalledTimes(1);
    expect(refreshExpiredTokens).toHaveBeenCalledWith(db);
    await worker.stop();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(refreshExpiredTokens).toHaveBeenCalledTimes(1);
  });

  it('logs a failing tick without crashing and keeps running', async () => {
    vi.useFakeTimers();
    refreshExpiredTokens.mockRejectedValueOnce(new Error('provider 500')).mockResolvedValue(undefined);
    const logger = new FakeLogger();
    const error = vi.spyOn(logger, 'error');
    const worker = createIntegrationRefreshWorker({ db: {} as never, logger, intervalMs: 50 });
    worker.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(error).toHaveBeenCalledWith({ error: 'provider 500' }, expect.stringContaining('threw'));
    expect(refreshExpiredTokens).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it('does not overlap ticks; stop() waits for the in-flight refresh', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    refreshExpiredTokens.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    const worker = createIntegrationRefreshWorker({ db: {} as never, logger: new FakeLogger(), intervalMs: 50 });
    worker.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(refreshExpiredTokens).toHaveBeenCalledTimes(1);
    let done = false;
    const p = worker.stop().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await p;
    expect(done).toBe(true);
  });
});
