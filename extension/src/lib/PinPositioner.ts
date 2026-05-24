/**
 * PinPositioner — single class that manages live screen positioning for every
 * annotation pin currently rendered on the page.
 *
 * Listens for layout-affecting events:
 *   - `MutationObserver` on `document.body` (subtree, childList, attributes
 *     filtered to `class`, `style`, `hidden`)
 *   - `ResizeObserver` on `document.documentElement`
 *   - `scroll` listener on `document` (capture phase, passive)
 *   - `resize` listener on `window` (passive)
 *
 * All events are coalesced through a single `requestAnimationFrame` tick.
 * Each tick walks every registered pin, calls `getBoundingClientRect()` on
 * its target element, and writes `transform: translate3d(x, y, 0)` from the
 * resolved bounding box (offset by current page scroll) onto the pin
 * element. When the registered `target` is `null` (or the previously
 * resolved element is no longer connected to the document), the pin
 * element is marked with `data-fallback="true"` AND, if the caller provided
 * stored `pageX/pageY` coordinates via the `fallback` option, the pin's
 * transform is written from those stored coordinates so the pin still has
 * a last-resort visual position (Req 14.3, 14.6). When no fallback
 * coordinates are provided, the transform is left untouched.
 *
 * Performance budget (Req 51.2): the positioner keeps a sliding window of
 * MutationObserver event timestamps. While the host page sustains > 60
 * mutation events per second over a 5-second trailing window, the
 * positioner downgrades scheduling from a per-frame `requestAnimationFrame`
 * pass to a 250 ms throttled pass (leading + trailing edge) and emits a
 * structured-logger warning. When the rate stays at or below 60/sec for
 * another 5 seconds, the positioner upgrades back to rAF scheduling.
 *
 * Per-host opt-out (Req 51.3 / task 43.2): when an `optOutStorage` is
 * supplied, the constructor reads the `pinPositionerOptOutHosts` key from
 * `chrome.storage.sync` and tests `window.location.hostname` against the
 * stored host patterns via `hostMatcher`. When the current host matches,
 * none of the layout observers / listeners are registered; pins are
 * placed exactly once on initial registration and never repositioned.
 * The opt-out list is also watched via `chrome.storage.onChanged` so a
 * change in the options page applies live without a page reload (the
 * positioner spins up the observers when opt-out is removed, and tears
 * them down when opt-out is added).
 *
 * Implements: Requirements 14.3, 14.5, 14.6, 51.1, 51.2, 51.3.
 */

import { hostMatchesAny } from './hostMatcher';

/**
 * Storage key for the per-host PinPositioner opt-out list. Mirrors the
 * key written by the options page (`extension/options/options.ts`). Kept
 * here so the file stays free of options-page imports.
 */
export const PIN_POSITIONER_OPT_OUT_STORAGE_KEY = 'pinPositionerOptOutHosts';

/**
 * Listener signature for `chrome.storage.onChanged`. Re-exported here so
 * the injected storage shim can mirror the runtime API exactly.
 */
export type PinPositionerStorageChangeListener = (
  changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
  areaName: string,
) => void;

/**
 * Minimal subset of `chrome.storage.sync` that PinPositioner needs in
 * order to read the per-host opt-out list and react to its changes.
 * Modeled this way so tests can pass an in-memory shim without depending
 * on the full `chrome.storage` surface.
 */
export interface PinPositionerOptOutStorage {
  /** Read one or more keys from the backing storage. */
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  /**
   * Optional change subscription. When provided, PinPositioner registers
   * a listener so opt-out toggles applied in the options page take effect
   * without a page reload.
   */
  onChanged?: {
    addListener: (cb: PinPositionerStorageChangeListener) => void;
    removeListener: (cb: PinPositionerStorageChangeListener) => void;
  };
  /** Storage area name `get` reads from. Defaults to `'sync'`. */
  readonly areaName?: string;
}

/** Strategy identifier used by the scheduler. */
export type PinPositionerStrategy = 'raf' | 'throttled';

/**
 * Structured-logger payload shape used by the extension. The extension
 * does not have access to server-side `pino`; the "structured-logger
 * pattern" in this context means a JSON-serializable object passed to a
 * single `console.warn` call (mirrored on the API server by `pino`).
 */
export interface PinPositionerLogPayload {
  readonly component: 'PinPositioner';
  readonly event: 'throttle-engaged';
  /** Average mutation events per second across the trailing 5 s window. */
  readonly rate: number;
  /** Width of the trailing window in milliseconds. */
  readonly windowMs: number;
}

export type PinPositionerLogger = (
  level: 'warn',
  payload: PinPositionerLogPayload,
) => void;

export interface PinPositionerOptions {
  /**
   * Optional injection points to make the class testable in headless
   * environments where these globals may be missing or noisy.
   */
  readonly window?: Window;
  readonly document?: Document;
  readonly requestAnimationFrame?: (cb: FrameRequestCallback) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
  /** Inject a clock for deterministic rate-tracking tests. */
  readonly now?: () => number;
  /** Inject `setTimeout` for the 250 ms throttle (leading + trailing). */
  readonly setTimeout?: (cb: () => void, ms: number) => number;
  readonly clearTimeout?: (handle: number) => void;
  /**
   * Inject a structured logger sink. Defaults to `console.warn` with the
   * payload as the second argument so devtools displays the object
   * inline.
   */
  readonly logger?: PinPositionerLogger;
  /**
   * Storage backend used to read the per-host opt-out list (Req 51.3 /
   * task 43.2) and subscribe to its changes. When omitted, the per-host
   * opt-out is disabled and PinPositioner always runs layout-driven
   * repositioning (legacy behavior preserved for existing callers).
   */
  readonly optOutStorage?: PinPositionerOptOutStorage;
  /**
   * Hostname tested against the opt-out patterns. Defaults to
   * `window.location.hostname`. Exposed primarily for tests.
   */
  readonly hostname?: string;
  /**
   * Optional callback invoked at the end of every coalesced tick (after
   * pin transforms have been written). Used by `<fl-overlay-host>` to
   * drive `PinClusterer` reclustering "after every PinPositioner tick"
   * (Req 52.3 / task 44.4). The callback is wrapped in try/catch so a
   * subscriber that throws cannot break the positioner; failures are
   * silently swallowed.
   */
  readonly onAfterTick?: () => void;
}

interface RegisteredPin {
  readonly el: HTMLElement;
  readonly target: Element | null;
  /**
   * Stored `pageX/pageY` coordinates used as a last-resort visual hint
   * when `target` is null or detached (Req 14.3, 14.6). When undefined,
   * the pin's transform is left untouched on fallback so callers can
   * supply their own fallback positioning out-of-band.
   */
  readonly fallback?: { readonly pageX: number; readonly pageY: number };
}

/** Threshold above which the 1-second mutation rate is considered "high". */
const HIGH_RATE_THRESHOLD = 60;
/**
 * Width of both the trailing window we measure rate over AND the duration
 * the rate must stay on one side of `HIGH_RATE_THRESHOLD` before we
 * upgrade or downgrade the scheduling strategy.
 */
const WINDOW_MS = 5_000;
/** Throttle interval when the positioner downgrades from rAF. */
const THROTTLE_MS = 250;
/** 1-second sub-window used when measuring the instantaneous rate. */
const ONE_SECOND_MS = 1_000;

const defaultLogger: PinPositionerLogger = (level, payload) => {
  if (level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn('[pinpoint]', payload);
  }
};

export class PinPositioner {
  private readonly pins = new Map<string, RegisteredPin>();
  private readonly win: Window;
  private readonly doc: Document;
  private readonly raf: (cb: FrameRequestCallback) => number;
  private readonly caf: (handle: number) => void;
  private readonly nowFn: () => number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => number;
  private readonly clearTimeoutFn: (handle: number) => void;
  private readonly logger: PinPositionerLogger;
  private readonly afterTick: (() => void) | null;

  private mo: MutationObserver | null = null;
  private ro: ResizeObserver | null = null;
  private rafId: number | null = null;
  private started = false;
  private disposed = false;

  /**
   * Sliding window of MutationObserver event timestamps. We push one
   * entry per `MutationRecord` (each MO callback batch contributes
   * `records.length` entries) so the count reflects observed mutation
   * *events* — the unit Requirement 51.2 measures in.
   */
  private mutationTimestamps: number[] = [];
  private strategy: PinPositionerStrategy = 'raf';
  /**
   * Last evaluation time at which the trailing 1-second mutation rate
   * exceeded `HIGH_RATE_THRESHOLD`. Initialized to construction time so
   * the positioner cannot upgrade-to-throttle within its first 5
   * seconds of life.
   */
  private lastHighRateAt: number;
  /** Last evaluation time at which the trailing 1-second rate was at or below the threshold. */
  private lastLowRateAt: number;

  /** Timestamp of the most recent throttled-mode flush (leading edge). */
  private lastThrottleExecAt = Number.NEGATIVE_INFINITY;
  /** Pending trailing-edge `setTimeout` handle, if any. */
  private throttleTrailingTimer: number | null = null;

  /**
   * Per-host opt-out state (Req 51.3). When `true`, the layout
   * observers / scroll / resize listeners are NOT registered; pins are
   * positioned exactly once on `register()` and never repositioned.
   */
  private optedOut = false;
  private readonly optOutStorage: PinPositionerOptOutStorage | undefined;
  private readonly optOutAreaName: string;
  private readonly hostname: string;
  private optOutChangeListener:
    | PinPositionerStorageChangeListener
    | undefined;

  constructor(options: PinPositionerOptions = {}) {
    this.win = options.window ?? window;
    this.doc = options.document ?? document;
    this.raf =
      options.requestAnimationFrame ??
      this.win.requestAnimationFrame.bind(this.win);
    this.caf =
      options.cancelAnimationFrame ??
      this.win.cancelAnimationFrame.bind(this.win);
    this.nowFn = options.now ?? (() => Date.now());
    this.setTimeoutFn =
      options.setTimeout ??
      ((cb, ms) =>
        this.win.setTimeout(cb, ms) as unknown as number);
    this.clearTimeoutFn =
      options.clearTimeout ??
      ((handle) => this.win.clearTimeout(handle));
    this.logger = options.logger ?? defaultLogger;
    this.afterTick = options.onAfterTick ?? null;

    const t0 = this.nowFn();
    this.lastHighRateAt = t0;
    this.lastLowRateAt = t0;

    this.optOutStorage = options.optOutStorage;
    this.optOutAreaName = options.optOutStorage?.areaName ?? 'sync';
    this.hostname =
      options.hostname ??
      (typeof this.win.location !== 'undefined' &&
      typeof this.win.location.hostname === 'string'
        ? this.win.location.hostname
        : '');

    if (!this.optOutStorage) {
      // No opt-out storage configured: preserve the historical
      // eager-start behavior. The options page is the only path to opt
      // a host out (Req 51.3); without storage there is no way to be
      // opted out.
      this.start();
      return;
    }

    // Opt-out storage configured: defer `start()` until the async read
    // completes so we never even briefly register observers on opted-out
    // hosts. `register()` still positions pins via `flush()`, so the
    // initial render is unaffected by the deferred start.
    void this.initOptOut();
  }

  /**
   * Begin observing the page. Idempotent: subsequent calls are no-ops.
   * Called automatically from the constructor when no `optOutStorage` is
   * supplied; deferred until after the async opt-out read otherwise.
   *
   * When the host is opted out (Req 51.3), `start()` is a no-op so the
   * MutationObserver / ResizeObserver / scroll / resize listeners are
   * never wired up.
   */
  start(): void {
    if (this.disposed) {
      throw new Error('PinPositioner: cannot start after dispose()');
    }
    if (this.started) return;
    if (this.optedOut) return;
    this.started = true;

    const MO =
      (this.win as Window & { MutationObserver?: typeof MutationObserver })
        .MutationObserver ?? MutationObserver;
    this.mo = new MO(this.handleMutations);
    this.mo.observe(this.doc.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });

    const RO = (this.win as Window & { ResizeObserver?: typeof ResizeObserver })
      .ResizeObserver;
    if (typeof RO === 'function') {
      this.ro = new RO(this.schedule);
      this.ro.observe(this.doc.documentElement);
    }

    this.win.addEventListener('resize', this.schedule, { passive: true });
    this.doc.addEventListener('scroll', this.schedule, {
      passive: true,
      capture: true,
    });
  }

  /**
   * Register a pin element against a target DOM element. Pass `null` for
   * `target` when the stored selector failed to resolve — the pin is then
   * marked `data-fallback="true"` (Req 14.6).
   *
   * `fallback` carries the annotation's stored `pageX/pageY` coordinates.
   * When provided AND the target cannot be resolved (null or detached),
   * the positioner writes those coordinates into the pin's transform on
   * every tick as a last-resort visual hint (Req 14.3). Without
   * `fallback`, the transform is left untouched on the fallback path so
   * existing callers retain their previous behavior.
   *
   * On opted-out hosts (Req 51.3) `register()` still positions the pin
   * exactly once via the synchronous `flush()` below; subsequent layout
   * changes do not reposition it.
   */
  register(
    id: string,
    pinEl: HTMLElement,
    target: Element | null,
    fallback?: { pageX: number; pageY: number },
  ): void {
    if (this.disposed) return;
    this.pins.set(id, { el: pinEl, target, fallback });
    if (this.optedOut) {
      // Place the pin once on initial render; no rAF tick will run later.
      this.flush();
    } else {
      this.schedule();
    }
  }

  /**
   * Unregister a previously registered pin.
   */
  unregister(id: string): void {
    this.pins.delete(id);
  }

  /**
   * Disconnect every observer and listener. After `dispose()` the
   * positioner is no longer usable; further `register`/`start` calls are
   * ignored or throw.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;

    if (this.rafId !== null) {
      this.caf(this.rafId);
      this.rafId = null;
    }
    if (this.throttleTrailingTimer !== null) {
      this.clearTimeoutFn(this.throttleTrailingTimer);
      this.throttleTrailingTimer = null;
    }

    if (this.mo) {
      this.mo.disconnect();
      this.mo = null;
    }
    if (this.ro) {
      this.ro.disconnect();
      this.ro = null;
    }

    this.win.removeEventListener('resize', this.schedule);
    this.doc.removeEventListener('scroll', this.schedule, {
      capture: true,
    } as EventListenerOptions);

    if (this.optOutChangeListener && this.optOutStorage?.onChanged) {
      this.optOutStorage.onChanged.removeListener(this.optOutChangeListener);
    }
    this.optOutChangeListener = undefined;

    this.pins.clear();
    this.mutationTimestamps = [];
  }

  /**
   * Force the next scheduled tick to run synchronously. Exposed for tests
   * and for callers that want to position newly-registered pins before the
   * next paint without waiting on rAF.
   */
  flush(): void {
    if (this.rafId !== null) {
      this.caf(this.rafId);
      this.rafId = null;
    }
    this.tick();
  }

  /**
   * Returns the current scheduling strategy. `'raf'` means the
   * positioner ticks once per animation frame; `'throttled'` means it
   * ticks at most once per 250 ms (with leading + trailing edges)
   * because the host page is producing mutations faster than the
   * configured budget. Exposed for tests and observability.
   */
  getStrategy(): PinPositionerStrategy {
    return this.strategy;
  }

  /** Whether this positioner is currently opted out (Req 51.3). */
  isOptedOut(): boolean {
    return this.optedOut;
  }

  /* ------------------------------------------------------------------ */
  /* Per-host opt-out (Req 51.3 / task 43.2)                            */
  /* ------------------------------------------------------------------ */

  /**
   * Async opt-out initialization. Reads the configured opt-out list,
   * sets `optedOut`, conditionally starts the layout observers, then
   * subscribes to storage changes so the list can be toggled live from
   * the options page.
   */
  private async initOptOut(): Promise<void> {
    if (!this.optOutStorage) return;
    try {
      const stored = await this.optOutStorage.get(
        PIN_POSITIONER_OPT_OUT_STORAGE_KEY,
      );
      const patterns = this.coerceOptOutPatterns(
        stored[PIN_POSITIONER_OPT_OUT_STORAGE_KEY],
      );
      this.optedOut = hostMatchesAny(this.hostname, patterns);
    } catch {
      // Fail open: a storage read failure should not prevent the
      // positioner from doing its job. Treat the host as opted-IN and
      // fall through to the default eager-start path.
      this.optedOut = false;
    }

    if (this.disposed) return;

    if (!this.optedOut) {
      this.start();
    }

    this.subscribeToOptOutChanges();
  }

  /**
   * Subscribe to `chrome.storage.onChanged` so a change in the options
   * page is applied live without a page reload. When the opt-out list
   * changes, re-evaluate whether the current host matches and either
   * tear down (newly opted-out) or spin up (newly opted-in) the layout
   * observers.
   */
  private subscribeToOptOutChanges(): void {
    if (this.optOutChangeListener) return;
    if (!this.optOutStorage?.onChanged) return;

    const listener: PinPositionerStorageChangeListener = (
      changes,
      areaName,
    ) => {
      if (this.disposed) return;
      if (areaName !== this.optOutAreaName) return;
      if (!(PIN_POSITIONER_OPT_OUT_STORAGE_KEY in changes)) return;

      const next = this.coerceOptOutPatterns(
        changes[PIN_POSITIONER_OPT_OUT_STORAGE_KEY]?.newValue,
      );
      const wasOptedOut = this.optedOut;
      this.optedOut = hostMatchesAny(this.hostname, next);

      if (this.optedOut && !wasOptedOut) {
        // Newly opted out: tear down observers / listeners. Pins keep
        // their last-known transform; no rAF tick will run again.
        this.stopLayoutObservers();
      } else if (!this.optedOut && wasOptedOut) {
        // Newly opted in: spin observers back up and re-tick so any
        // staleness from the opted-out interval is reconciled.
        this.start();
        this.schedule();
      }
    };

    this.optOutChangeListener = listener;
    this.optOutStorage.onChanged.addListener(listener);
  }

  /**
   * Disconnect every layout observer and listener without disposing the
   * positioner. Used when the per-host opt-out is flipped on at runtime
   * via `chrome.storage.onChanged`.
   */
  private stopLayoutObservers(): void {
    this.started = false;

    if (this.mo) {
      this.mo.disconnect();
      this.mo = null;
    }
    if (this.ro) {
      this.ro.disconnect();
      this.ro = null;
    }

    this.win.removeEventListener('resize', this.schedule);
    this.doc.removeEventListener('scroll', this.schedule, {
      capture: true,
    } as EventListenerOptions);

    if (this.rafId !== null) {
      this.caf(this.rafId);
      this.rafId = null;
    }
    if (this.throttleTrailingTimer !== null) {
      this.clearTimeoutFn(this.throttleTrailingTimer);
      this.throttleTrailingTimer = null;
    }
  }

  /**
   * Coerce a storage value into a `string[]`. Tolerates non-array values
   * and non-string entries by returning an empty list / filtering out
   * non-strings.
   */
  private coerceOptOutPatterns(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string');
  }

  /**
   * MutationObserver callback. Records one timestamp per `MutationRecord`
   * (each batch contributes `records.length` entries) so the rate
   * counter measures observed mutation *events*, then defers to the
   * normal `schedule()` pipeline.
   */
  private readonly handleMutations = (records: MutationRecord[]): void => {
    if (this.disposed) return;
    const now = this.nowFn();
    for (let i = 0; i < records.length; i++) {
      this.mutationTimestamps.push(now);
    }
    this.schedule();
  };

  /**
   * Coalescing scheduler. Picks rAF or 250 ms throttle based on the
   * current strategy, evaluating that strategy first so a sudden burst
   * of mutations downgrades us in the same tick.
   */
  private readonly schedule = (): void => {
    if (this.disposed) return;
    this.evaluateStrategy();
    if (this.strategy === 'raf') {
      this.scheduleRaf();
    } else {
      this.scheduleThrottled();
    }
  };

  private scheduleRaf(): void {
    if (this.rafId !== null) return;
    this.rafId = this.raf(() => {
      this.rafId = null;
      this.tick();
    });
  }

  /**
   * Throttled scheduler — wraps `scheduleRaf()` with a 250 ms throttle
   * (leading + trailing edge). Multiple `schedule()` calls within the
   * same 250 ms window collapse to at most one leading-edge call plus
   * one trailing-edge call at the end of the window.
   */
  private scheduleThrottled(): void {
    const now = this.nowFn();
    const sinceLast = now - this.lastThrottleExecAt;
    if (sinceLast >= THROTTLE_MS) {
      // Leading edge: execute immediately.
      this.lastThrottleExecAt = now;
      if (this.throttleTrailingTimer !== null) {
        this.clearTimeoutFn(this.throttleTrailingTimer);
        this.throttleTrailingTimer = null;
      }
      this.scheduleRaf();
      return;
    }
    // Within the throttle window: queue exactly one trailing call.
    if (this.throttleTrailingTimer !== null) return;
    const remaining = THROTTLE_MS - sinceLast;
    this.throttleTrailingTimer = this.setTimeoutFn(() => {
      this.throttleTrailingTimer = null;
      if (this.disposed) return;
      this.lastThrottleExecAt = this.nowFn();
      this.scheduleRaf();
    }, remaining);
  }

  /**
   * Recompute the trailing 1-second mutation rate, update the
   * high/low-rate watermarks, and switch strategy when one of the
   * watermarks has been more than `WINDOW_MS` ahead of the other.
   *
   * Switching is symmetric:
   *   - rAF → throttled when the rate has stayed *above* threshold for
   *     `WINDOW_MS` (i.e. `lastHighRateAt - lastLowRateAt >= WINDOW_MS`)
   *   - throttled → rAF when the rate has stayed *at or below* threshold
   *     for `WINDOW_MS` (i.e. `lastLowRateAt - lastHighRateAt >= WINDOW_MS`)
   */
  private evaluateStrategy(): void {
    const now = this.nowFn();
    this.trimMutationWindow(now);

    const oneSecondAgo = now - ONE_SECOND_MS;
    let count1s = 0;
    for (let i = this.mutationTimestamps.length - 1; i >= 0; i--) {
      const t = this.mutationTimestamps[i];
      // Strict `>` keeps the trailing window half-open `(now-1s, now]` so
      // a steady stream of 60 batches/sec landing exactly on the second
      // boundary measures as 60/sec — not 120/sec — and stays at the
      // requirement's threshold without tripping it.
      if (t > oneSecondAgo) {
        count1s++;
      } else {
        // Array is monotonically non-decreasing; once we cross the cut-off,
        // all earlier entries are also out of the 1-second window.
        break;
      }
    }

    if (count1s > HIGH_RATE_THRESHOLD) {
      this.lastHighRateAt = now;
    } else {
      this.lastLowRateAt = now;
    }

    if (
      this.strategy === 'raf' &&
      this.lastHighRateAt - this.lastLowRateAt >= WINDOW_MS
    ) {
      this.strategy = 'throttled';
      const rate = this.mutationTimestamps.length / (WINDOW_MS / 1000);
      this.logger('warn', {
        component: 'PinPositioner',
        event: 'throttle-engaged',
        rate,
        windowMs: WINDOW_MS,
      });
    } else if (
      this.strategy === 'throttled' &&
      this.lastLowRateAt - this.lastHighRateAt >= WINDOW_MS
    ) {
      this.strategy = 'raf';
      if (this.throttleTrailingTimer !== null) {
        this.clearTimeoutFn(this.throttleTrailingTimer);
        this.throttleTrailingTimer = null;
      }
    }
  }

  /**
   * Drop mutation timestamps that fall outside the trailing
   * `WINDOW_MS` window. Implemented as a single pass + `splice` so the
   * amortized cost stays bounded even when the host emits thousands of
   * mutations per second.
   */
  private trimMutationWindow(now: number): void {
    const cutoff = now - WINDOW_MS;
    let drop = 0;
    while (
      drop < this.mutationTimestamps.length &&
      this.mutationTimestamps[drop] < cutoff
    ) {
      drop++;
    }
    if (drop > 0) {
      this.mutationTimestamps.splice(0, drop);
    }
  }

  private tick(): void {
    if (this.disposed) return;
    const scrollX = this.win.scrollX ?? 0;
    const scrollY = this.win.scrollY ?? 0;

    for (const { el, target, fallback } of this.pins.values()) {
      if (target && target.isConnected) {
        const rect = target.getBoundingClientRect();
        const x = rect.left + scrollX;
        const y = rect.top + scrollY;
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        if (el.dataset.fallback) {
          delete el.dataset.fallback;
        }
      } else {
        el.dataset.fallback = 'true';
        // Last-resort visual hint (Req 14.3): when the caller provided
        // stored `pageX/pageY` coordinates, position the pin from them
        // so it remains visible on the page even though the selector
        // could not be resolved. When no fallback is provided, leave
        // the transform untouched so callers that prefer to handle
        // fallback positioning out-of-band keep their previous
        // behavior.
        if (fallback) {
          el.style.transform = `translate3d(${fallback.pageX}px, ${fallback.pageY}px, 0)`;
        }
      }
    }

    // Notify subscribers that a tick just completed (Req 52.3 / task 44.4
    // — `<fl-overlay-host>` uses this hook to recluster pins after every
    // positioning pass). Wrapped in try/catch so a buggy subscriber
    // cannot brick the positioner.
    if (this.afterTick) {
      try {
        this.afterTick();
      } catch {
        /* swallow — onAfterTick failures must not break positioning */
      }
    }
  }
}

export default PinPositioner;
