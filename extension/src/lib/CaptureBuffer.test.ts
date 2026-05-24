// @vitest-environment jsdom
/**
 * Unit tests for CaptureBuffer.
 *
 * Validates Requirement 36.1:
 *   - Console wrapper preserves the original `console.{log,warn,error}` so
 *     the host page's output is unchanged.
 *   - Console and network buffers ring at the 50-entry boundary (FIFO
 *     eviction; the oldest entry is dropped when a 51st arrives).
 *   - `clear()` empties both buffers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CAPTURE_CONSOLE_PREF_KEY,
  CAPTURE_NETWORK_PREF_KEY,
  CaptureBuffer,
  type CapturePrefStorage,
} from './CaptureBuffer';

interface FakeConsole {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

function makeFakeConsole(): {
  fake: FakeConsole;
  calls: { level: 'log' | 'warn' | 'error'; args: unknown[] }[];
  originals: Record<'log' | 'warn' | 'error', FakeConsole['log']>;
} {
  const calls: { level: 'log' | 'warn' | 'error'; args: unknown[] }[] = [];
  const log = (...args: unknown[]): void => {
    calls.push({ level: 'log', args });
  };
  const warn = (...args: unknown[]): void => {
    calls.push({ level: 'warn', args });
  };
  const error = (...args: unknown[]): void => {
    calls.push({ level: 'error', args });
  };
  const fake: FakeConsole = { log, warn, error };
  return { fake, calls, originals: { log, warn, error } };
}

/**
 * Minimal `PerformanceObserver` stand-in that lets tests synthesize
 * resource timing entries without depending on jsdom's missing
 * implementation.
 */
function makeFakePerformanceObserverCtor() {
  const subscribers: ((entries: PerformanceResourceTiming[]) => void)[] = [];

  class FakePerformanceObserver {
    private readonly cb: PerformanceObserverCallback;
    private observed = false;

    constructor(cb: PerformanceObserverCallback) {
      this.cb = cb;
    }

    observe(_options: PerformanceObserverInit): void {
      if (this.observed) return;
      this.observed = true;
      subscribers.push((entries) => {
        const list = {
          getEntries: () => entries,
          getEntriesByName: () => [],
          getEntriesByType: () => [],
        } as unknown as PerformanceObserverEntryList;
        this.cb(list, this as unknown as PerformanceObserver);
      });
    }

    disconnect(): void {
      this.observed = false;
      // Fake observers don't bother to splice subscribers; tests use
      // fresh ctors per case so cross-test bleed is impossible.
    }

    takeRecords(): PerformanceEntryList {
      return [];
    }
  }

  function emit(entries: PerformanceResourceTiming[]): void {
    for (const sub of subscribers) sub(entries);
  }

  return {
    Ctor: FakePerformanceObserver as unknown as typeof PerformanceObserver,
    emit,
  };
}

function makeResourceEntry(
  overrides: Partial<PerformanceResourceTiming> = {},
): PerformanceResourceTiming {
  return {
    name: 'https://example.com/asset.js',
    initiatorType: 'script',
    startTime: 0,
    duration: 1,
    transferSize: 100,
    ...overrides,
  } as PerformanceResourceTiming;
}

describe('CaptureBuffer', () => {
  let fakeConsole: ReturnType<typeof makeFakeConsole>;
  let buffer: CaptureBuffer | null;

  beforeEach(() => {
    fakeConsole = makeFakeConsole();
    buffer = null;
  });

  afterEach(() => {
    buffer?.stop();
  });

  describe('console wrapping (Req 36.1)', () => {
    it('passes calls through to the original console method', () => {
      buffer = new CaptureBuffer({ console: fakeConsole.fake });
      buffer.start();

      fakeConsole.fake.log('hello', 1, { k: 'v' });
      fakeConsole.fake.warn('careful');
      fakeConsole.fake.error('boom');

      expect(fakeConsole.calls).toEqual([
        { level: 'log', args: ['hello', 1, { k: 'v' }] },
        { level: 'warn', args: ['careful'] },
        { level: 'error', args: ['boom'] },
      ]);
    });

    it('captures the level, formatted message, and ISO timestamp', () => {
      const fixedNow = new Date('2024-06-01T12:00:00.000Z');
      buffer = new CaptureBuffer({
        console: fakeConsole.fake,
        now: () => fixedNow,
      });
      buffer.start();

      fakeConsole.fake.log('hello', 42);

      const entries = buffer.getConsoleEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        level: 'log',
        message: 'hello 42',
        timestamp: '2024-06-01T12:00:00.000Z',
      });
    });

    it('extracts the stack from Error arguments on warn/error', () => {
      buffer = new CaptureBuffer({ console: fakeConsole.fake });
      buffer.start();

      const err = new Error('boom');
      fakeConsole.fake.error('failed', err);

      const [entry] = buffer.getConsoleEntries();
      expect(entry.level).toBe('error');
      expect(entry.stack).toBe(err.stack);
    });

    it('restores the original console methods on stop()', () => {
      buffer = new CaptureBuffer({ console: fakeConsole.fake });
      buffer.start();

      const wrappedLog = fakeConsole.fake.log;
      expect(wrappedLog).not.toBe(fakeConsole.originals.log);

      buffer.stop();

      expect(fakeConsole.fake.log).toBe(fakeConsole.originals.log);
      expect(fakeConsole.fake.warn).toBe(fakeConsole.originals.warn);
      expect(fakeConsole.fake.error).toBe(fakeConsole.originals.error);
    });

    it('start() is idempotent', () => {
      buffer = new CaptureBuffer({ console: fakeConsole.fake });
      buffer.start();
      const wrapped = fakeConsole.fake.log;
      buffer.start();
      // The wrapper installed by the second start() call is the same
      // function as the first; we did not double-wrap.
      expect(fakeConsole.fake.log).toBe(wrapped);

      fakeConsole.fake.log('once');
      expect(buffer.getConsoleEntries()).toHaveLength(1);
    });
  });

  describe('console ring buffer (Req 36.1)', () => {
    it('keeps only the most recent 50 entries; evicts oldest at the boundary', () => {
      buffer = new CaptureBuffer({ console: fakeConsole.fake });
      buffer.start();

      for (let i = 0; i < 50; i++) {
        fakeConsole.fake.log(`msg-${i}`);
      }
      expect(buffer.getConsoleEntries()).toHaveLength(50);
      expect(buffer.getConsoleEntries()[0].message).toBe('msg-0');
      expect(buffer.getConsoleEntries()[49].message).toBe('msg-49');

      // The 51st entry must drop msg-0 and append msg-50
      fakeConsole.fake.log('msg-50');

      const entries = buffer.getConsoleEntries();
      expect(entries).toHaveLength(50);
      expect(entries[0].message).toBe('msg-1');
      expect(entries[49].message).toBe('msg-50');
    });

    it('still pushes to original console while ring-buffering', () => {
      buffer = new CaptureBuffer({ console: fakeConsole.fake });
      buffer.start();

      for (let i = 0; i < 75; i++) {
        fakeConsole.fake.log(`msg-${i}`);
      }

      // Buffer is capped at 50, but the original console saw all 75.
      expect(buffer.getConsoleEntries()).toHaveLength(50);
      expect(fakeConsole.calls).toHaveLength(75);
      expect(fakeConsole.calls[0].args[0]).toBe('msg-0');
      expect(fakeConsole.calls[74].args[0]).toBe('msg-74');
    });
  });

  describe('network ring buffer (Req 36.1)', () => {
    it('subscribes a buffered resource observer and stores entries', () => {
      const fakeObserver = makeFakePerformanceObserverCtor();
      buffer = new CaptureBuffer({
        console: fakeConsole.fake,
        PerformanceObserverCtor: fakeObserver.Ctor,
      });
      buffer.start();

      fakeObserver.emit([
        makeResourceEntry({
          name: 'https://example.com/a.js',
          initiatorType: 'script',
          startTime: 1,
          duration: 2,
          transferSize: 10,
        }),
        makeResourceEntry({
          name: 'https://example.com/b.css',
          initiatorType: 'link',
          startTime: 3,
          duration: 4,
        }),
      ]);

      const entries = buffer.getNetworkEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        name: 'https://example.com/a.js',
        initiatorType: 'script',
        startTime: 1,
        duration: 2,
        transferSize: 10,
      });
      expect(entries[1]).toMatchObject({
        name: 'https://example.com/b.css',
        initiatorType: 'link',
      });
    });

    it('keeps only the most recent 50 network entries', () => {
      const fakeObserver = makeFakePerformanceObserverCtor();
      buffer = new CaptureBuffer({
        console: fakeConsole.fake,
        PerformanceObserverCtor: fakeObserver.Ctor,
      });
      buffer.start();

      const entries: PerformanceResourceTiming[] = [];
      for (let i = 0; i < 50; i++) {
        entries.push(makeResourceEntry({ name: `https://x/${i}` }));
      }
      fakeObserver.emit(entries);
      expect(buffer.getNetworkEntries()).toHaveLength(50);
      expect(buffer.getNetworkEntries()[0].name).toBe('https://x/0');

      fakeObserver.emit([makeResourceEntry({ name: 'https://x/50' })]);

      const after = buffer.getNetworkEntries();
      expect(after).toHaveLength(50);
      expect(after[0].name).toBe('https://x/1');
      expect(after[49].name).toBe('https://x/50');
    });

    it('disconnects the observer on stop()', () => {
      const fakeObserver = makeFakePerformanceObserverCtor();
      const disconnectSpy = vi.fn();
      class SpyingObserver {
        private cb: PerformanceObserverCallback;
        constructor(cb: PerformanceObserverCallback) {
          this.cb = cb;
          void this.cb;
        }
        observe(): void {}
        disconnect(): void {
          disconnectSpy();
        }
        takeRecords(): PerformanceEntryList {
          return [];
        }
      }
      void fakeObserver;
      buffer = new CaptureBuffer({
        console: fakeConsole.fake,
        PerformanceObserverCtor:
          SpyingObserver as unknown as typeof PerformanceObserver,
      });
      buffer.start();
      buffer.stop();

      expect(disconnectSpy).toHaveBeenCalledTimes(1);
    });

    it('silently disables network capture when no observer ctor is available', () => {
      buffer = new CaptureBuffer({
        console: fakeConsole.fake,
        PerformanceObserverCtor: undefined,
      });
      // Inject undefined explicitly to bypass the fallback to the runtime
      // global; we want to assert the no-op path.
      // @ts-expect-error — exercise the falsy-ctor branch by stomping
      // private state for this one assertion.
      buffer.observerCtor = undefined;

      expect(() => buffer!.start()).not.toThrow();
      expect(buffer.getNetworkEntries()).toEqual([]);
    });
  });

  describe('clear()', () => {
    it('empties both buffers', () => {
      const fakeObserver = makeFakePerformanceObserverCtor();
      buffer = new CaptureBuffer({
        console: fakeConsole.fake,
        PerformanceObserverCtor: fakeObserver.Ctor,
      });
      buffer.start();

      fakeConsole.fake.log('one');
      fakeConsole.fake.log('two');
      fakeObserver.emit([makeResourceEntry()]);

      expect(buffer.getConsoleEntries()).toHaveLength(2);
      expect(buffer.getNetworkEntries()).toHaveLength(1);

      buffer.clear();

      expect(buffer.getConsoleEntries()).toEqual([]);
      expect(buffer.getNetworkEntries()).toEqual([]);
    });
  });

  describe('capture pref gating (Req 36.4 / Task 27.5)', () => {
    /**
     * Build an in-memory pref storage shim that exercises the same shape
     * `chrome.storage.local` exposes — `get` returns a record subset and
     * `onChanged` lets us synthesize updates.
     */
    function makePrefStorage(initial: Record<string, unknown> = {}): {
      storage: CapturePrefStorage;
      data: Record<string, unknown>;
      emit: (
        changes: Record<
          string,
          { newValue?: unknown; oldValue?: unknown }
        >,
        areaName?: string,
      ) => void;
    } {
      const data: Record<string, unknown> = { ...initial };
      const listeners: ((
        changes: Record<
          string,
          { newValue?: unknown; oldValue?: unknown }
        >,
        areaName: string,
      ) => void)[] = [];
      const storage: CapturePrefStorage = {
        async get(keys: string | string[]): Promise<Record<string, unknown>> {
          const arr = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of arr) {
            if (k in data) out[k] = data[k];
          }
          return out;
        },
        onChanged: {
          addListener: (cb) => {
            listeners.push(cb);
          },
          removeListener: (cb) => {
            const i = listeners.indexOf(cb);
            if (i >= 0) listeners.splice(i, 1);
          },
        },
        areaName: 'local',
      };
      const emit = (
        changes: Record<
          string,
          { newValue?: unknown; oldValue?: unknown }
        >,
        areaName = 'local',
      ): void => {
        for (const [k, v] of Object.entries(changes)) {
          if ('newValue' in v) {
            data[k] = v.newValue;
          }
        }
        for (const cb of [...listeners]) cb(changes, areaName);
      };
      return { storage, data, emit };
    }

    it('captures both streams by default (missing prefs => true)', async () => {
      const fakeObserver = makeFakePerformanceObserverCtor();
      const prefs = makePrefStorage({});
      buffer = new CaptureBuffer({
        console: fakeConsole.fake,
        PerformanceObserverCtor: fakeObserver.Ctor,
        capturePrefStorage: prefs.storage,
      });
      buffer.start();
      // Wait for the async hydration triggered by start().
      await buffer.refreshCapturePrefs();

      fakeConsole.fake.log('hello');
      fakeObserver.emit([makeResourceEntry({ name: 'https://x/a' })]);

      expect(buffer.getConsoleEnabled()).toBe(true);
      expect(buffer.getNetworkEnabled()).toBe(true);
      expect(buffer.getConsoleEntries()).toHaveLength(1);
      expect(buffer.getNetworkEntries()).toHaveLength(1);
    });

    it('skips console pushes when fl_capture_console_enabled is false', async () => {
      const fakeObserver = makeFakePerformanceObserverCtor();
      const prefs = makePrefStorage({
        [CAPTURE_CONSOLE_PREF_KEY]: false,
        [CAPTURE_NETWORK_PREF_KEY]: true,
      });
      buffer = new CaptureBuffer({
        console: fakeConsole.fake,
        PerformanceObserverCtor: fakeObserver.Ctor,
        capturePrefStorage: prefs.storage,
      });
      buffer.start();
      await buffer.refreshCapturePrefs();

      fakeConsole.fake.log('hello');
      fakeConsole.fake.warn('careful');
      fakeObserver.emit([makeResourceEntry({ name: 'https://x/a' })]);

      // Console capture is gated: zero buffered entries...
      expect(buffer.getConsoleEntries()).toEqual([]);
      // ...but the original console still received both calls.
      expect(fakeConsole.calls).toHaveLength(2);
      // Network capture is still on.
      expect(buffer.getNetworkEntries()).toHaveLength(1);
    });

    it('skips network pushes when fl_capture_network_enabled is false', async () => {
      const fakeObserver = makeFakePerformanceObserverCtor();
      const prefs = makePrefStorage({
        [CAPTURE_CONSOLE_PREF_KEY]: true,
        [CAPTURE_NETWORK_PREF_KEY]: false,
      });
      buffer = new CaptureBuffer({
        console: fakeConsole.fake,
        PerformanceObserverCtor: fakeObserver.Ctor,
        capturePrefStorage: prefs.storage,
      });
      buffer.start();
      await buffer.refreshCapturePrefs();

      fakeConsole.fake.log('hello');
      fakeObserver.emit([
        makeResourceEntry({ name: 'https://x/a' }),
        makeResourceEntry({ name: 'https://x/b' }),
      ]);

      expect(buffer.getNetworkEntries()).toEqual([]);
      expect(buffer.getConsoleEntries()).toHaveLength(1);
    });

    it('refreshes the cached prefs via chrome.storage.onChanged without a reload', async () => {
      const fakeObserver = makeFakePerformanceObserverCtor();
      const prefs = makePrefStorage({
        [CAPTURE_CONSOLE_PREF_KEY]: true,
        [CAPTURE_NETWORK_PREF_KEY]: true,
      });
      buffer = new CaptureBuffer({
        console: fakeConsole.fake,
        PerformanceObserverCtor: fakeObserver.Ctor,
        capturePrefStorage: prefs.storage,
      });
      buffer.start();
      await buffer.refreshCapturePrefs();

      // Both capture streams initially active.
      fakeConsole.fake.log('first');
      fakeObserver.emit([makeResourceEntry({ name: 'https://x/a' })]);
      expect(buffer.getConsoleEntries()).toHaveLength(1);
      expect(buffer.getNetworkEntries()).toHaveLength(1);

      // User flips the console toggle off in the options page; storage
      // emits a change event and the listener flips our cached pref.
      prefs.emit({
        [CAPTURE_CONSOLE_PREF_KEY]: { oldValue: true, newValue: false },
      });
      expect(buffer.getConsoleEnabled()).toBe(false);

      fakeConsole.fake.log('second');
      expect(buffer.getConsoleEntries()).toHaveLength(1); // unchanged

      // Flip it back on — capture resumes immediately, no reload required.
      prefs.emit({
        [CAPTURE_CONSOLE_PREF_KEY]: { oldValue: false, newValue: true },
      });
      expect(buffer.getConsoleEnabled()).toBe(true);
      fakeConsole.fake.log('third');
      expect(buffer.getConsoleEntries()).toHaveLength(2);
    });

    it('ignores onChanged events for other storage areas', async () => {
      const fakeObserver = makeFakePerformanceObserverCtor();
      const prefs = makePrefStorage({
        [CAPTURE_CONSOLE_PREF_KEY]: true,
      });
      buffer = new CaptureBuffer({
        console: fakeConsole.fake,
        PerformanceObserverCtor: fakeObserver.Ctor,
        capturePrefStorage: prefs.storage,
      });
      buffer.start();
      await buffer.refreshCapturePrefs();

      // Synthesize a change from the `sync` area — the listener should
      // ignore it because our pref storage advertises `local`.
      prefs.emit(
        {
          [CAPTURE_CONSOLE_PREF_KEY]: { oldValue: true, newValue: false },
        },
        'sync',
      );

      expect(buffer.getConsoleEnabled()).toBe(true);
    });

    it('treats non-boolean stored values as "capture on"', async () => {
      const fakeObserver = makeFakePerformanceObserverCtor();
      const prefs = makePrefStorage({
        [CAPTURE_CONSOLE_PREF_KEY]: 'truthy',
        [CAPTURE_NETWORK_PREF_KEY]: 0,
      });
      buffer = new CaptureBuffer({
        console: fakeConsole.fake,
        PerformanceObserverCtor: fakeObserver.Ctor,
        capturePrefStorage: prefs.storage,
      });
      buffer.start();
      await buffer.refreshCapturePrefs();

      expect(buffer.getConsoleEnabled()).toBe(true);
      expect(buffer.getNetworkEnabled()).toBe(true);
    });

    it('detaches the onChanged listener on stop()', async () => {
      const fakeObserver = makeFakePerformanceObserverCtor();
      const prefs = makePrefStorage({
        [CAPTURE_CONSOLE_PREF_KEY]: true,
      });
      buffer = new CaptureBuffer({
        console: fakeConsole.fake,
        PerformanceObserverCtor: fakeObserver.Ctor,
        capturePrefStorage: prefs.storage,
      });
      buffer.start();
      await buffer.refreshCapturePrefs();
      buffer.stop();

      // After stop(), an onChanged event must not flip the cached value
      // because the listener has been removed.
      prefs.emit({
        [CAPTURE_CONSOLE_PREF_KEY]: { oldValue: true, newValue: false },
      });
      expect(buffer.getConsoleEnabled()).toBe(true);
    });
  });
});
