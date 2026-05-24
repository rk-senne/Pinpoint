// @vitest-environment jsdom
/**
 * Unit tests for PinPositioner.
 *
 * Validates Requirements 14.5, 14.6:
 *   - Recompute pin coordinates on layout-affecting events (mutation,
 *     scroll, resize) coalesced through a single rAF tick
 *   - Use `data-fallback="true"` on pins whose target element is null,
 *     leaving the transform untouched so the caller's stored coordinates
 *     can drive the fallback rendering
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PinPositioner } from './PinPositioner';
import { PIN_POSITIONER_OPT_OUT_STORAGE_KEY } from './PinPositioner';
import type {
  PinPositionerOptOutStorage,
  PinPositionerStorageChangeListener,
} from './PinPositioner';

/** Helper: create an element with a stubbed bounding rect, attached to the body. */
function makeTarget(rect: {
  left: number;
  top: number;
  width?: number;
  height?: number;
}): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({
      left: rect.left,
      top: rect.top,
      right: rect.left + (rect.width ?? 10),
      bottom: rect.top + (rect.height ?? 10),
      width: rect.width ?? 10,
      height: rect.height ?? 10,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

/**
 * Build a positioner with a manually-pumped rAF so tests can deterministically
 * decide when ticks happen.
 */
function makePositioner() {
  Object.defineProperty(window, 'scrollX', { configurable: true, value: 0, writable: true });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0, writable: true });

  let pendingCallbacks: FrameRequestCallback[] = [];
  let nextHandle = 1;
  const raf = vi.fn((cb: FrameRequestCallback) => {
    const handle = nextHandle++;
    pendingCallbacks.push(cb);
    return handle;
  });
  const caf = vi.fn(() => {
    pendingCallbacks = [];
  });
  const flushRaf = () => {
    const cbs = pendingCallbacks;
    pendingCallbacks = [];
    for (const cb of cbs) cb(performance.now());
  };

  const positioner = new PinPositioner({
    requestAnimationFrame: raf,
    cancelAnimationFrame: caf,
  });
  return { positioner, raf, caf, flushRaf };
}

describe('PinPositioner', () => {
  let scrollXBefore: number;
  let scrollYBefore: number;

  beforeEach(() => {
    document.body.innerHTML = '';
    scrollXBefore = window.scrollX;
    scrollYBefore = window.scrollY;
  });

  afterEach(() => {
    Object.defineProperty(window, 'scrollX', { configurable: true, value: scrollXBefore, writable: true });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: scrollYBefore, writable: true });
  });

  describe('register and tick', () => {
    it('positions a pin via translate3d using getBoundingClientRect + scroll offsets', () => {
      const { positioner, flushRaf } = makePositioner();

      const target = makeTarget({ left: 100, top: 200 });
      const pin = document.createElement('div');

      positioner.register('a1', pin, target);
      flushRaf();

      expect(pin.style.transform).toBe('translate3d(100px, 200px, 0)');
      expect(pin.dataset.fallback).toBeUndefined();
    });

    it('honors scroll offsets when computing the page-space transform', () => {
      const { positioner, flushRaf } = makePositioner();

      Object.defineProperty(window, 'scrollX', { configurable: true, value: 50, writable: true });
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 75, writable: true });

      const target = makeTarget({ left: 10, top: 20 });
      const pin = document.createElement('div');

      positioner.register('a1', pin, target);
      flushRaf();

      expect(pin.style.transform).toBe('translate3d(60px, 95px, 0)');
    });

    it('reflects layout changes on the registered target on the next tick', () => {
      // Validates Req 14.5: recompute pin position from the resolved
      // element's *current* bounding-box on each layout-affecting event.
      const { positioner, flushRaf } = makePositioner();

      const target = makeTarget({ left: 10, top: 10 });
      const pin = document.createElement('div');
      positioner.register('a1', pin, target);
      flushRaf();
      expect(pin.style.transform).toBe('translate3d(10px, 10px, 0)');

      // Simulate a layout change — element moves
      target.getBoundingClientRect = () =>
        ({
          left: 200,
          top: 300,
          right: 210,
          bottom: 310,
          width: 10,
          height: 10,
          x: 200,
          y: 300,
          toJSON: () => ({}),
        }) as DOMRect;

      // Trigger a scroll → schedules one rAF tick
      document.dispatchEvent(new Event('scroll'));
      flushRaf();

      expect(pin.style.transform).toBe('translate3d(200px, 300px, 0)');
    });

    it('coalesces multiple events into a single rAF tick', () => {
      const { positioner, raf, flushRaf } = makePositioner();
      raf.mockClear();

      const target = makeTarget({ left: 0, top: 0 });
      const pin = document.createElement('div');
      positioner.register('a1', pin, target);

      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
      document.dispatchEvent(new Event('scroll'));

      // register + 2 resizes + 1 scroll → 1 rAF call
      expect(raf).toHaveBeenCalledTimes(1);
      flushRaf();
      expect(pin.style.transform).toBe('translate3d(0px, 0px, 0)');
    });
  });

  describe('fallback semantics (Req 14.6)', () => {
    it('marks data-fallback="true" when target is null and leaves transform untouched', () => {
      const { positioner, flushRaf } = makePositioner();

      const pin = document.createElement('div');
      pin.style.transform = 'translate3d(0px, 0px, 0)'; // pre-existing fallback position

      positioner.register('a1', pin, null);
      flushRaf();

      expect(pin.dataset.fallback).toBe('true');
      // Caller's stored-coords fallback position is preserved
      expect(pin.style.transform).toBe('translate3d(0px, 0px, 0)');
    });

    it('marks data-fallback when the target is detached from the DOM', () => {
      const { positioner, flushRaf } = makePositioner();

      const target = document.createElement('div'); // never attached
      const pin = document.createElement('div');

      positioner.register('a1', pin, target);
      flushRaf();

      expect(pin.dataset.fallback).toBe('true');
    });

    it('clears data-fallback when re-registered with a connected target', () => {
      const { positioner, flushRaf } = makePositioner();

      const pin = document.createElement('div');
      positioner.register('a1', pin, null);
      flushRaf();
      expect(pin.dataset.fallback).toBe('true');

      const target = makeTarget({ left: 5, top: 6 });
      positioner.register('a1', pin, target);
      flushRaf();

      expect(pin.dataset.fallback).toBeUndefined();
      expect(pin.style.transform).toBe('translate3d(5px, 6px, 0)');
    });
  });

  describe('fallback positioning (Req 14.3)', () => {
    // Req 14.3: when selector resolution fails, position the pin at the
    // stored pageX/pageY as a last-resort visual hint AND show the
    // warning indicator (data-fallback="true").
    it('writes transform from stored pageX/pageY when target is null and fallback is provided', () => {
      const { positioner, flushRaf } = makePositioner();

      const pin = document.createElement('div');
      positioner.register('a1', pin, null, { pageX: 123, pageY: 456 });
      flushRaf();

      expect(pin.dataset.fallback).toBe('true');
      expect(pin.style.transform).toBe('translate3d(123px, 456px, 0)');
    });

    it('writes transform from stored pageX/pageY when the target is detached and fallback is provided', () => {
      const { positioner, flushRaf } = makePositioner();

      const detached = document.createElement('div'); // never attached
      const pin = document.createElement('div');
      positioner.register('a1', pin, detached, { pageX: 10, pageY: 20 });
      flushRaf();

      expect(pin.dataset.fallback).toBe('true');
      expect(pin.style.transform).toBe('translate3d(10px, 20px, 0)');
    });

    it('prefers the resolved element over the stored fallback when both are available (Req 14.6)', () => {
      // Req 14.6: stored coords are *only* the last-resort fallback; when
      // the resolved element is available, it drives the position.
      const { positioner, flushRaf } = makePositioner();

      const target = makeTarget({ left: 7, top: 8 });
      const pin = document.createElement('div');
      positioner.register('a1', pin, target, { pageX: 999, pageY: 999 });
      flushRaf();

      expect(pin.dataset.fallback).toBeUndefined();
      expect(pin.style.transform).toBe('translate3d(7px, 8px, 0)');
    });

    it('switches between fallback transform and resolved transform when the target connects/disconnects', () => {
      const { positioner, flushRaf } = makePositioner();

      const target = makeTarget({ left: 50, top: 60 });
      const pin = document.createElement('div');
      positioner.register('a1', pin, target, { pageX: 1, pageY: 2 });
      flushRaf();
      expect(pin.style.transform).toBe('translate3d(50px, 60px, 0)');
      expect(pin.dataset.fallback).toBeUndefined();

      // Detach the target → next tick falls back to stored coords
      target.remove();
      positioner.flush();

      expect(pin.dataset.fallback).toBe('true');
      expect(pin.style.transform).toBe('translate3d(1px, 2px, 0)');
    });
  });

  describe('event-driven scheduling (Req 14.5)', () => {
    it('schedules a tick when the document scrolls', () => {
      const { positioner, raf } = makePositioner();
      void positioner;
      raf.mockClear();

      document.dispatchEvent(new Event('scroll'));
      expect(raf).toHaveBeenCalledTimes(1);
    });

    it('schedules a tick when the window resizes', () => {
      const { positioner, raf } = makePositioner();
      void positioner;
      raf.mockClear();

      window.dispatchEvent(new Event('resize'));
      expect(raf).toHaveBeenCalledTimes(1);
    });

    it('schedules a tick when a watched DOM mutation occurs', async () => {
      const { positioner, raf } = makePositioner();
      void positioner;
      raf.mockClear();

      const div = document.createElement('div');
      document.body.appendChild(div);

      // MutationObserver delivers asynchronously via microtask
      await Promise.resolve();
      await Promise.resolve();

      expect(raf).toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('start() is idempotent', () => {
      const { positioner } = makePositioner();
      expect(() => positioner.start()).not.toThrow();
      expect(() => positioner.start()).not.toThrow();
    });

    it('unregister stops further updates for that pin', () => {
      const { positioner, flushRaf } = makePositioner();

      const target = makeTarget({ left: 1, top: 2 });
      const pin = document.createElement('div');
      positioner.register('a1', pin, target);
      flushRaf();
      expect(pin.style.transform).toBe('translate3d(1px, 2px, 0)');

      positioner.unregister('a1');

      // Move the target then tick again; the pin must NOT update
      target.getBoundingClientRect = () =>
        ({
          left: 99,
          top: 99,
          right: 99,
          bottom: 99,
          width: 0,
          height: 0,
          x: 99,
          y: 99,
          toJSON: () => ({}),
        }) as DOMRect;
      positioner.flush();

      expect(pin.style.transform).toBe('translate3d(1px, 2px, 0)');
    });

    it('dispose() disconnects observers, removes listeners, and stops scheduling', () => {
      const { positioner, raf } = makePositioner();
      positioner.dispose();
      raf.mockClear();

      window.dispatchEvent(new Event('resize'));
      document.dispatchEvent(new Event('scroll'));

      expect(raf).not.toHaveBeenCalled();
    });

    it('dispose() is idempotent', () => {
      const { positioner } = makePositioner();
      positioner.dispose();
      expect(() => positioner.dispose()).not.toThrow();
    });

    it('start() after dispose() throws', () => {
      const { positioner } = makePositioner();
      positioner.dispose();
      expect(() => positioner.start()).toThrow(/dispose/);
    });

    it('register() after dispose() is a no-op', () => {
      const { positioner, flushRaf } = makePositioner();
      positioner.dispose();

      const target = makeTarget({ left: 1, top: 2 });
      const pin = document.createElement('div');
      positioner.register('a1', pin, target);
      flushRaf();

      expect(pin.style.transform).toBe('');
    });
  });

  describe('mutation-rate-driven strategy switch (Req 51.1, 51.2)', () => {
    /**
     * Builds a positioner with a controllable clock + injected
     * `setTimeout`/`clearTimeout` so the trailing-edge throttle does not
     * leak real timers into the test.
     */
    function makePerfPositioner() {
      Object.defineProperty(window, 'scrollX', {
        configurable: true,
        value: 0,
        writable: true,
      });
      Object.defineProperty(window, 'scrollY', {
        configurable: true,
        value: 0,
        writable: true,
      });

      let pendingRaf: FrameRequestCallback[] = [];
      let nextRaf = 1;
      const raf = vi.fn((cb: FrameRequestCallback) => {
        const handle = nextRaf++;
        pendingRaf.push(cb);
        return handle;
      });
      const caf = vi.fn(() => {
        pendingRaf = [];
      });
      const flushRaf = () => {
        const cbs = pendingRaf;
        pendingRaf = [];
        for (const cb of cbs) cb(0);
      };

      let now = 0;
      const setNow = (t: number) => {
        now = t;
      };
      const nowFn = () => now;

      const timers = new Map<number, () => void>();
      let nextTimer = 1;
      const setTimeoutFn = vi.fn((cb: () => void, _ms: number) => {
        const handle = nextTimer++;
        timers.set(handle, cb);
        return handle;
      });
      const clearTimeoutFn = vi.fn((handle: number) => {
        timers.delete(handle);
      });

      const logger = vi.fn();

      const positioner = new PinPositioner({
        requestAnimationFrame: raf,
        cancelAnimationFrame: caf,
        now: nowFn,
        setTimeout: setTimeoutFn,
        clearTimeout: clearTimeoutFn,
        logger,
      });

      return {
        positioner,
        raf,
        caf,
        flushRaf,
        setNow,
        setTimeoutFn,
        clearTimeoutFn,
        logger,
      };
    }

    /**
     * Wait long enough for the jsdom MutationObserver microtask to
     * deliver a queued batch of records to the positioner's callback.
     */
    async function flushMicrotasks(): Promise<void> {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    /**
     * Append `count` children to `document.body` and await the
     * MutationObserver microtask delivery so the positioner observes
     * `count` mutation records in a single batch.
     */
    async function emitMutations(count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        document.body.appendChild(document.createElement('div'));
      }
      await flushMicrotasks();
    }

    it('starts in the default rAF strategy', () => {
      const { positioner } = makePerfPositioner();
      expect(positioner.getStrategy()).toBe('raf');
    });

    it('switches to throttled when > 60 mutations/sec are sustained for 5 seconds and emits a structured warning', async () => {
      const { positioner, setNow, logger } = makePerfPositioner();

      // 70 mutations per "second" of simulated time, for 5 seconds.
      // 70 > 60, so the trailing 1 s rate stays high the entire time.
      for (let s = 1; s <= 5; s++) {
        setNow(s * 1000);
        await emitMutations(70);
      }

      expect(positioner.getStrategy()).toBe('throttled');
      expect(logger).toHaveBeenCalledTimes(1);
      const [level, payload] = logger.mock.calls[0];
      expect(level).toBe('warn');
      expect(payload).toMatchObject({
        component: 'PinPositioner',
        event: 'throttle-engaged',
        windowMs: 5000,
      });
      expect(typeof payload.rate).toBe('number');
      expect(payload.rate).toBeGreaterThan(60);
    });

    it('does not switch to throttled when the burst lasts less than 5 seconds', async () => {
      const { positioner, setNow, logger } = makePerfPositioner();

      // 70 mutations/sec for only 3 seconds, then a quiet second.
      for (let s = 1; s <= 3; s++) {
        setNow(s * 1000);
        await emitMutations(70);
      }
      setNow(4000);
      await emitMutations(0); // dispatch nothing; no MO callback fires
      // Drive an evaluation via a scroll event.
      document.dispatchEvent(new Event('scroll'));

      expect(positioner.getStrategy()).toBe('raf');
      expect(logger).not.toHaveBeenCalled();
    });

    it('does not switch when the rate stays at or below 60/sec', async () => {
      const { positioner, setNow, logger } = makePerfPositioner();

      // Exactly 60 mutations/sec for 6 seconds — the requirement is
      // *more than* 60, so this should never trip the budget.
      for (let s = 1; s <= 6; s++) {
        setNow(s * 1000);
        await emitMutations(60);
      }

      expect(positioner.getStrategy()).toBe('raf');
      expect(logger).not.toHaveBeenCalled();
    });

    it('switches back to raf after the rate drops below the threshold for 5 seconds', async () => {
      const { positioner, setNow, logger } = makePerfPositioner();

      // Phase 1: drive into throttled mode.
      for (let s = 1; s <= 5; s++) {
        setNow(s * 1000);
        await emitMutations(70);
      }
      expect(positioner.getStrategy()).toBe('throttled');

      // Phase 2: stop mutating. Drive evaluations via scroll events.
      // The last burst's contribution to the trailing 1 s window
      // expires shortly after t=6000, so we need ~6 seconds of
      // quiet-time to satisfy the "5 s sustained low rate" rule.
      for (let s = 6; s <= 12; s++) {
        setNow(s * 1000);
        document.dispatchEvent(new Event('scroll'));
      }

      expect(positioner.getStrategy()).toBe('raf');
      // We only logged the *engagement* — disengaging is silent.
      expect(logger).toHaveBeenCalledTimes(1);
    });

    it('uses 250 ms throttling instead of rAF while in throttled mode', async () => {
      const { positioner, raf, setTimeoutFn, setNow } = makePerfPositioner();

      // Drive into throttled mode.
      for (let s = 1; s <= 5; s++) {
        setNow(s * 1000);
        await emitMutations(70);
      }
      expect(positioner.getStrategy()).toBe('throttled');

      // The leading edge of the throttle fires immediately (one rAF
      // call). Capture how many rAFs we have so far.
      const rafCallsAfterEngagement = raf.mock.calls.length;
      setTimeoutFn.mockClear();

      // Within the same 250 ms window, dispatch many scroll events.
      // None should trigger a new rAF — they should collapse onto a
      // single trailing-edge `setTimeout(..., <250ms)`.
      setNow(5050);
      for (let i = 0; i < 10; i++) {
        document.dispatchEvent(new Event('scroll'));
      }

      expect(raf.mock.calls.length).toBe(rafCallsAfterEngagement);
      // Exactly one trailing-edge timer was queued.
      const throttleTimers = setTimeoutFn.mock.calls.filter(
        ([, ms]) => ms > 0 && ms <= 250,
      );
      expect(throttleTimers.length).toBe(1);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Per-host opt-out (Req 51.3 / task 43.2)                                    */
/* -------------------------------------------------------------------------- */

interface FakeOptOutStorage extends PinPositionerOptOutStorage {
  emitChange(
    changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
    areaName?: string,
  ): void;
  readonly listeners: PinPositionerStorageChangeListener[];
  data: Record<string, unknown>;
}

function makeOptOutStorage(
  initial: Record<string, unknown> = {},
): FakeOptOutStorage {
  const listeners: PinPositionerStorageChangeListener[] = [];
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    listeners,
    areaName: 'sync',
    get: vi.fn(async (keys: string | string[]) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of arr) {
        if (k in data) out[k] = data[k];
      }
      return out;
    }),
    onChanged: {
      addListener: (cb) => {
        listeners.push(cb);
      },
      removeListener: (cb) => {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) listeners.splice(idx, 1);
      },
    },
    emitChange(changes, areaName = 'sync') {
      for (const cb of listeners.slice()) cb(changes, areaName);
    },
  };
}

/**
 * Build a positioner with a manually-pumped rAF and an injectable
 * opt-out storage shim. Mirrors `makePositioner()` but plumbs through
 * the new options the per-host opt-out introduces.
 */
function makePositionerWithOptOut(
  storage: FakeOptOutStorage,
  hostname: string,
) {
  Object.defineProperty(window, 'scrollX', { configurable: true, value: 0, writable: true });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0, writable: true });

  let pendingCallbacks: FrameRequestCallback[] = [];
  let nextHandle = 1;
  const raf = vi.fn((cb: FrameRequestCallback) => {
    const handle = nextHandle++;
    pendingCallbacks.push(cb);
    return handle;
  });
  const caf = vi.fn(() => {
    pendingCallbacks = [];
  });
  const flushRaf = () => {
    const cbs = pendingCallbacks;
    pendingCallbacks = [];
    for (const cb of cbs) cb(performance.now());
  };

  const positioner = new PinPositioner({
    requestAnimationFrame: raf,
    cancelAnimationFrame: caf,
    optOutStorage: storage,
    hostname,
  });
  return { positioner, raf, caf, flushRaf };
}

describe('PinPositioner per-host opt-out (Req 51.3 / task 43.2)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does NOT register MutationObserver / ResizeObserver / scroll / resize listeners when the host is opted out', async () => {
    const storage = makeOptOutStorage({
      [PIN_POSITIONER_OPT_OUT_STORAGE_KEY]: ['app.example.com'],
    });

    // Spy the global observer ctors and the listener registration paths
    // BEFORE constructing the positioner so we can prove it never wires
    // them up on opted-out hosts.
    const moSpy = vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      disconnect: vi.fn(),
      takeRecords: vi.fn(() => []),
    }));
    const roSpy = vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      disconnect: vi.fn(),
      unobserve: vi.fn(),
    }));
    const winAddSpy = vi.spyOn(window, 'addEventListener');
    const docAddSpy = vi.spyOn(document, 'addEventListener');
    vi.stubGlobal('MutationObserver', moSpy);
    vi.stubGlobal('ResizeObserver', roSpy);

    const { positioner } = makePositionerWithOptOut(
      storage,
      'app.example.com',
    );

    // Opt-out is async: wait for the storage read to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(positioner.isOptedOut()).toBe(true);
    expect(moSpy).not.toHaveBeenCalled();
    expect(roSpy).not.toHaveBeenCalled();
    expect(
      winAddSpy.mock.calls.some(([type]) => type === 'resize'),
    ).toBe(false);
    expect(
      docAddSpy.mock.calls.some(([type]) => type === 'scroll'),
    ).toBe(false);

    vi.unstubAllGlobals();
    winAddSpy.mockRestore();
    docAddSpy.mockRestore();
  });

  it('still positions a pin once on register() when opted out, then never repositions on layout events', async () => {
    const storage = makeOptOutStorage({
      [PIN_POSITIONER_OPT_OUT_STORAGE_KEY]: ['app.example.com'],
    });
    const { positioner, raf } = makePositionerWithOptOut(
      storage,
      'app.example.com',
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(positioner.isOptedOut()).toBe(true);
    raf.mockClear();

    const target = makeTarget({ left: 50, top: 60 });
    const pin = document.createElement('div');
    positioner.register('a1', pin, target);

    // Initial placement happened synchronously via `flush()`, no rAF needed.
    expect(pin.style.transform).toBe('translate3d(50px, 60px, 0)');
    expect(raf).not.toHaveBeenCalled();

    // Layout event must NOT schedule a tick on an opted-out host.
    document.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    expect(raf).not.toHaveBeenCalled();

    // Even if the target moves, the pin transform stays at its initial value.
    target.getBoundingClientRect = () =>
      ({
        left: 999,
        top: 999,
        right: 999,
        bottom: 999,
        width: 0,
        height: 0,
        x: 999,
        y: 999,
        toJSON: () => ({}),
      }) as DOMRect;
    document.dispatchEvent(new Event('scroll'));
    expect(pin.style.transform).toBe('translate3d(50px, 60px, 0)');
  });

  it('starts the layout observers when the host is NOT opted out', async () => {
    const storage = makeOptOutStorage({
      [PIN_POSITIONER_OPT_OUT_STORAGE_KEY]: ['*.other.example.com'],
    });
    const { positioner, raf } = makePositionerWithOptOut(
      storage,
      'app.example.com',
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(positioner.isOptedOut()).toBe(false);

    raf.mockClear();
    document.dispatchEvent(new Event('scroll'));
    expect(raf).toHaveBeenCalledTimes(1);
  });

  it('honors *.example.com wildcard patterns from the opt-out list', async () => {
    const storage = makeOptOutStorage({
      [PIN_POSITIONER_OPT_OUT_STORAGE_KEY]: ['*.example.com'],
    });
    const { positioner } = makePositionerWithOptOut(
      storage,
      'deep.app.example.com',
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(positioner.isOptedOut()).toBe(true);
  });

  it('treats a missing opt-out key as opted-IN', async () => {
    const storage = makeOptOutStorage({});
    const { positioner } = makePositionerWithOptOut(
      storage,
      'app.example.com',
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(positioner.isOptedOut()).toBe(false);
  });

  it('subscribes to chrome.storage.onChanged and tears observers down when newly opted-out', async () => {
    const storage = makeOptOutStorage({
      [PIN_POSITIONER_OPT_OUT_STORAGE_KEY]: [],
    });
    const { positioner, raf } = makePositionerWithOptOut(
      storage,
      'app.example.com',
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(positioner.isOptedOut()).toBe(false);
    expect(storage.listeners.length).toBe(1);

    // The options page just added the host to the opt-out list.
    storage.emitChange({
      [PIN_POSITIONER_OPT_OUT_STORAGE_KEY]: {
        oldValue: [],
        newValue: ['app.example.com'],
      },
    });
    expect(positioner.isOptedOut()).toBe(true);

    // Observers should be torn down — layout events no longer schedule ticks.
    raf.mockClear();
    document.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    expect(raf).not.toHaveBeenCalled();
  });

  it('re-arms observers when the host is removed from the opt-out list', async () => {
    const storage = makeOptOutStorage({
      [PIN_POSITIONER_OPT_OUT_STORAGE_KEY]: ['app.example.com'],
    });
    const { positioner, raf, flushRaf } = makePositionerWithOptOut(
      storage,
      'app.example.com',
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(positioner.isOptedOut()).toBe(true);

    storage.emitChange({
      [PIN_POSITIONER_OPT_OUT_STORAGE_KEY]: {
        oldValue: ['app.example.com'],
        newValue: [],
      },
    });
    expect(positioner.isOptedOut()).toBe(false);

    // The opt-out toggle scheduled a "reconcile" rAF tick — let it run
    // so the positioner is back to a clean state before we test the
    // event-driven path.
    flushRaf();

    // Observers should be back; a scroll schedules a rAF tick again.
    raf.mockClear();
    document.dispatchEvent(new Event('scroll'));
    expect(raf).toHaveBeenCalled();
  });

  it('ignores onChanged events from other storage areas', async () => {
    const storage = makeOptOutStorage({
      [PIN_POSITIONER_OPT_OUT_STORAGE_KEY]: [],
    });
    const { positioner } = makePositionerWithOptOut(
      storage,
      'app.example.com',
    );

    await Promise.resolve();
    await Promise.resolve();

    storage.emitChange(
      {
        [PIN_POSITIONER_OPT_OUT_STORAGE_KEY]: {
          oldValue: [],
          newValue: ['app.example.com'],
        },
      },
      'local', // wrong area
    );
    expect(positioner.isOptedOut()).toBe(false);
  });

  it('dispose() removes the storage onChanged listener', async () => {
    const storage = makeOptOutStorage({
      [PIN_POSITIONER_OPT_OUT_STORAGE_KEY]: [],
    });
    const { positioner } = makePositionerWithOptOut(
      storage,
      'app.example.com',
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(storage.listeners.length).toBe(1);

    positioner.dispose();
    expect(storage.listeners.length).toBe(0);
  });

  it('falls back to opted-IN when the storage read throws', async () => {
    const storage = makeOptOutStorage({});
    storage.get = vi.fn(async () => {
      throw new Error('storage unavailable');
    });

    const { positioner, raf } = makePositionerWithOptOut(
      storage,
      'app.example.com',
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(positioner.isOptedOut()).toBe(false);

    // Observers should be wired despite the storage failure.
    raf.mockClear();
    document.dispatchEvent(new Event('scroll'));
    expect(raf).toHaveBeenCalled();
  });
});

