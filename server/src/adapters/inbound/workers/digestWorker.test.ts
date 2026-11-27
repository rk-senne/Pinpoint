import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDigestWorker } from './digestWorker.js';
import { FakeLogger } from '../../../__tests__/fakes/index.js';

afterEach(() => { vi.useRealTimers(); });

/** Minimal knex stand-in: db('table') returns a thenable chain resolving to fixed rows. */
function fakeDb(orgs: Array<{ id: string }>, owners: Record<string, Array<{ user_id: string }>>) {
  return ((table: string) => {
    let orgId = '';
    const chain: Record<string, unknown> = {
      where(w: { org_id: string }) { orgId = w.org_id; return chain; },
      select() {
        return Promise.resolve(table === 'organizations' ? orgs : (owners[orgId] ?? []));
      },
    };
    return chain;
  }) as never;
}

const digest = (n: number) => ({ newAnnotations: n, insight: `insight ${n}` }) as never;

describe('createDigestWorker', () => {
  it('enqueues one digest notification per org owner on each tick', async () => {
    vi.useFakeTimers();
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const generateDailyDigest = vi.fn().mockImplementation(async (_db, orgId: string) => digest(orgId === 'o1' ? 3 : 0));
    const worker = createDigestWorker({
      db: fakeDb([{ id: 'o1' }, { id: 'o2' }], { o1: [{ user_id: 'u1' }, { user_id: 'u2' }], o2: [{ user_id: 'u3' }] }),
      notificationQueue: { enqueue } as never,
      generateDailyDigest,
      logger: new FakeLogger(),
      intervalMs: 1000,
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(generateDailyDigest).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ recipientUserId: 'u1', subject: 'Daily Digest — 3 new items', body: 'insight 3' });
    expect(enqueue.mock.calls[2]![0]).toMatchObject({ recipientUserId: 'u3', subject: 'Daily Digest — 0 new items' });
    await worker.stop();
  });

  it('logs and survives a failing digest generation, and ticks again', async () => {
    vi.useFakeTimers();
    const logger = new FakeLogger();
    const error = vi.spyOn(logger, 'error');
    const generateDailyDigest = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(digest(1));
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const worker = createDigestWorker({
      db: fakeDb([{ id: 'o1' }], { o1: [{ user_id: 'u1' }] }),
      notificationQueue: { enqueue } as never, generateDailyDigest, logger, intervalMs: 100,
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(error).toHaveBeenCalledWith({ error: 'boom' }, expect.stringContaining('threw'));
    expect(enqueue).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it('start() is idempotent and stop() halts the schedule', async () => {
    vi.useFakeTimers();
    const generateDailyDigest = vi.fn().mockResolvedValue(digest(0));
    const worker = createDigestWorker({
      db: fakeDb([{ id: 'o1' }], {}), notificationQueue: { enqueue: vi.fn() } as never,
      generateDailyDigest, logger: new FakeLogger(), intervalMs: 100,
    });
    worker.start(); worker.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(generateDailyDigest).toHaveBeenCalledTimes(1);
    await worker.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(generateDailyDigest).toHaveBeenCalledTimes(1);
  });

  it('defaults to a 24 h cadence', async () => {
    vi.useFakeTimers();
    const generateDailyDigest = vi.fn().mockResolvedValue(digest(0));
    const worker = createDigestWorker({
      db: fakeDb([{ id: 'o1' }], {}), notificationQueue: { enqueue: vi.fn() } as never,
      generateDailyDigest, logger: new FakeLogger(),
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(24 * 3600 * 1000 - 1);
    expect(generateDailyDigest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(generateDailyDigest).toHaveBeenCalledTimes(1);
    await worker.stop();
  });
});
