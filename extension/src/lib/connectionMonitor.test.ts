// @vitest-environment jsdom
/**
 * Unit tests for `connectionMonitor` (task 36.8 / Req 44.1).
 *
 * Coverage:
 *   - Initial `isOffline` reflects `navigator.onLine` at construction time.
 *   - `online` / `offline` window events flip the signal.
 *   - Three consecutive heartbeat failures flip `isOffline` to `true`.
 *   - A single heartbeat success while offline flips back to `false`.
 *   - `dispose()` clears the polling timer and removes the window
 *     listeners (idempotent).
 *   - `checkNow()` issues an immediate heartbeat that respects the
 *     same success/failure rules as the polled heartbeat.
 *
 * Note on timers: the monitor uses `setInterval` so we cannot use
 * `vi.runAllTimersAsync()` (it would loop forever). Instead, every
 * test that exercises the heartbeat advances the clock by the
 * configured interval explicitly and drains the resulting microtasks
 * with `await Promise.resolve()` so the `fetch` promise (a real
 * promise wrapped around our spy) resolves before the next assertion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConnectionMonitor } from './connectionMonitor';

function makeFetchSpy(seq: Array<'ok' | 'fail' | 'status5xx'>): {
  spy: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const spy = vi.fn(async () => {
    const verdict = seq[Math.min(i, seq.length - 1)];
    i += 1;
    if (verdict === 'fail') throw new Error('network');
    if (verdict === 'status5xx') return new Response('', { status: 503 });
    return new Response('', { status: 200 });
  });
  return { spy };
}

/** Drain the microtask queue several times so chained `.then`s settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom's `navigator.onLine` defaults to true.
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createConnectionMonitor', () => {
  it('starts online when navigator.onLine === true', () => {
    const { spy } = makeFetchSpy(['ok']);
    const monitor = createConnectionMonitor({
      url: 'http://test/api/v1/health',
      fetchImpl: spy,
      intervalMs: 60_000,
    });
    expect(monitor.isOffline.get()).toBe(false);
    monitor.dispose();
  });

  it('starts offline when navigator.onLine === false', () => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => false,
    });
    const { spy } = makeFetchSpy(['fail']);
    const monitor = createConnectionMonitor({
      url: 'http://test/api/v1/health',
      fetchImpl: spy,
      intervalMs: 60_000,
    });
    expect(monitor.isOffline.get()).toBe(true);
    monitor.dispose();
  });

  it('flips offline immediately on the window `offline` event', () => {
    const { spy } = makeFetchSpy(['ok']);
    const monitor = createConnectionMonitor({
      url: 'http://test/api/v1/health',
      fetchImpl: spy,
      intervalMs: 60_000,
    });
    expect(monitor.isOffline.get()).toBe(false);

    window.dispatchEvent(new Event('offline'));
    expect(monitor.isOffline.get()).toBe(true);
    monitor.dispose();
  });

  it('runs a heartbeat on the window `online` event and clears offline on success', async () => {
    const { spy } = makeFetchSpy(['ok', 'ok']);
    const monitor = createConnectionMonitor({
      url: 'http://test/api/v1/health',
      fetchImpl: spy,
      intervalMs: 60_000,
    });

    // Force offline, then dispatch `online` and let the heartbeat resolve.
    window.dispatchEvent(new Event('offline'));
    expect(monitor.isOffline.get()).toBe(true);

    window.dispatchEvent(new Event('online'));
    await flush();
    expect(monitor.isOffline.get()).toBe(false);
    monitor.dispose();
  });

  it('flips offline after three consecutive heartbeat failures', async () => {
    const { spy } = makeFetchSpy(['fail', 'fail', 'fail']);
    const monitor = createConnectionMonitor({
      url: 'http://test/api/v1/health',
      fetchImpl: spy,
      intervalMs: 1000,
    });

    // First heartbeat is kicked off synchronously. Drain it.
    await flush();
    expect(monitor.isOffline.get()).toBe(false); // 1 failure

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(monitor.isOffline.get()).toBe(false); // 2 failures

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(monitor.isOffline.get()).toBe(true); // 3 failures → offline
    monitor.dispose();
  });

  it('counts a non-2xx response as a heartbeat failure', async () => {
    const { spy } = makeFetchSpy([
      'status5xx',
      'status5xx',
      'status5xx',
    ]);
    const monitor = createConnectionMonitor({
      url: 'http://test/api/v1/health',
      fetchImpl: spy,
      intervalMs: 1000,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(monitor.isOffline.get()).toBe(true);
    monitor.dispose();
  });

  it('flips back online after a single heartbeat success while offline', async () => {
    const { spy } = makeFetchSpy(['fail', 'fail', 'fail', 'ok']);
    const monitor = createConnectionMonitor({
      url: 'http://test/api/v1/health',
      fetchImpl: spy,
      intervalMs: 1000,
    });

    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(monitor.isOffline.get()).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(monitor.isOffline.get()).toBe(false);
    monitor.dispose();
  });

  it('checkNow() forces an immediate heartbeat', async () => {
    const { spy } = makeFetchSpy(['fail', 'fail', 'fail']);
    const monitor = createConnectionMonitor({
      url: 'http://test/api/v1/health',
      fetchImpl: spy,
      intervalMs: 60_000, // big interval so only checkNow drives it
    });

    // Drain the synchronous initial heartbeat (the 1st failure).
    await flush();
    expect(monitor.isOffline.get()).toBe(false);

    await monitor.checkNow();
    expect(monitor.isOffline.get()).toBe(false); // 2 failures
    await monitor.checkNow();
    expect(monitor.isOffline.get()).toBe(true); // 3 failures
    monitor.dispose();
  });

  it('dispose() removes window listeners and stops the timer', async () => {
    const { spy } = makeFetchSpy(['fail', 'fail', 'fail', 'fail']);
    const monitor = createConnectionMonitor({
      url: 'http://test/api/v1/health',
      fetchImpl: spy,
      intervalMs: 1000,
    });

    await flush();
    const callsBefore = spy.mock.calls.length;
    monitor.dispose();

    // After dispose, advancing time must not trigger another heartbeat,
    // and `offline` events must not flip the state.
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(spy.mock.calls.length).toBe(callsBefore);

    const previous = monitor.isOffline.get();
    window.dispatchEvent(new Event('offline'));
    expect(monitor.isOffline.get()).toBe(previous);
  });

  it('falls back to navigator.onLine when no fetch is available', () => {
    const monitor = createConnectionMonitor({
      url: 'http://test/api/v1/health',
      // Explicitly disable heartbeat (mirrors Manifest V3 worker shapes
      // where fetch is not yet loaded).
      enableHeartbeat: false,
      fetchImpl: undefined,
    });
    expect(monitor.isOffline.get()).toBe(false);

    window.dispatchEvent(new Event('offline'));
    expect(monitor.isOffline.get()).toBe(true);
    window.dispatchEvent(new Event('online'));
    expect(monitor.isOffline.get()).toBe(false);
    monitor.dispose();
  });
});
