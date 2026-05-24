/**
 * CaptureBuffer — rolling capture of console messages and network resource
 * timing entries used to attach debugging context to bug-report annotations
 * (Requirement 36.1).
 *
 * Behavior:
 *   - Wraps `console.log`, `console.warn`, and `console.error` while
 *     preserving the originals so the host page's console output is
 *     unchanged. Each call appends a `CapturedConsoleEntry` to the
 *     console ring buffer before the original implementation is invoked.
 *   - Subscribes a `PerformanceObserver({ type: 'resource', buffered: true })`
 *     so any Resource Timing entries already on the timeline are surfaced
 *     to the buffer along with future ones.
 *   - Both buffers are bounded to the most recent 50 entries (FIFO
 *     eviction); the bound is configurable for tests.
 *   - Honors the user's per-stream capture preferences from
 *     `chrome.storage.local.fl_capture_console_enabled` /
 *     `fl_capture_network_enabled` (Req 36.4). Each defaults to `true`
 *     (capture enabled). The values are cached in memory and refreshed
 *     via `chrome.storage.onChanged` so toggles take effect without a
 *     page reload. When a stream's pref is `false`, the corresponding
 *     `pushConsole` / `pushNetwork` call is skipped entirely (the
 *     underlying console output is still passed through).
 *
 * The shapes of the returned entries match `CapturedConsoleEntry` and
 * `CapturedNetworkEntry` exported from `@pinpoint/shared`.
 */
import type {
  CapturedConsoleEntry,
  CapturedConsoleLevel,
  CapturedNetworkEntry,
} from '@pinpoint/shared';

/**
 * Storage keys for the capture toggles persisted by the options page
 * (Req 36.4). Both default to `true`.
 */
export const CAPTURE_CONSOLE_PREF_KEY = 'fl_capture_console_enabled';
export const CAPTURE_NETWORK_PREF_KEY = 'fl_capture_network_enabled';

/** Subset of the `Console` surface CaptureBuffer wraps. */
type WrappableConsoleMethod = (...args: unknown[]) => void;

interface WrappableConsole {
  log: WrappableConsoleMethod;
  warn: WrappableConsoleMethod;
  error: WrappableConsoleMethod;
}

/**
 * Optional injection points so tests can drive the buffer without relying
 * on jsdom's `PerformanceObserver` (which is not implemented) and without
 * mutating the real `globalThis.console`.
 */
export interface CaptureBufferOptions {
  /** Console object to wrap. Defaults to the global `console`. */
  readonly console?: WrappableConsole;
  /**
   * Constructor used to build the network observer. Defaults to the
   * runtime's `PerformanceObserver`. When undefined at construction time
   * AND the runtime has none (e.g., jsdom), network capture is disabled.
   */
  readonly PerformanceObserverCtor?: typeof PerformanceObserver;
  /** Override the per-buffer cap. Defaults to 50 (Req 36.1). */
  readonly maxEntries?: number;
  /** Override the timestamp source. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Override the storage backend used to read capture prefs and subscribe
   * to changes. Defaults to `chrome.storage.local`. When undefined at
   * construction time AND the runtime has none (e.g., jsdom without the
   * extension globals), the prefs default to `true` and never refresh.
   */
  readonly capturePrefStorage?: CapturePrefStorage;
}

/**
 * Minimal subset of `chrome.storage.local` that CaptureBuffer needs in
 * order to read the capture toggles and react to changes. Modeled this
 * way so tests can pass an in-memory shim without depending on the full
 * `chrome.storage` surface.
 */
export interface CapturePrefStorage {
  get(
    keys: string | string[],
  ): Promise<Record<string, unknown>>;
  onChanged?: {
    addListener: (
      cb: (
        changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
        areaName: string,
      ) => void,
    ) => void;
    removeListener: (
      cb: (
        changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
        areaName: string,
      ) => void,
    ) => void;
  };
  /** The storage area name this `get` reads from. Defaults to `'local'`. */
  readonly areaName?: string;
}

export class CaptureBuffer {
  /** Default ring-buffer cap mandated by Req 36.1. */
  static readonly DEFAULT_MAX_ENTRIES = 50;

  private readonly console: WrappableConsole;
  private readonly observerCtor: typeof PerformanceObserver | undefined;
  private readonly maxEntries: number;
  private readonly now: () => Date;

  private readonly consoleBuf: CapturedConsoleEntry[] = [];
  private readonly networkBuf: CapturedNetworkEntry[] = [];

  /** Cached capture prefs (Req 36.4). Both default to `true`. */
  private consoleEnabled = true;
  private networkEnabled = true;

  /**
   * Storage handle and listener references — held so we can detach the
   * `onChanged` subscription on `stop()`. `undefined` when no storage is
   * available (jsdom without injected stub).
   */
  private readonly prefStorage: CapturePrefStorage | undefined;
  private readonly prefAreaName: string;
  private prefChangeListener:
    | ((
        changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
        areaName: string,
      ) => void)
    | undefined;

  /**
   * Originals captured at `start()` so `stop()` can restore them
   * exactly. Stored as own-property descriptors of `this.console` so
   * restoration sets the same property the wrapper installed onto.
   */
  private originals: Partial<Record<CapturedConsoleLevel, WrappableConsoleMethod>> = {};

  private observer: PerformanceObserver | undefined;
  private started = false;

  constructor(options: CaptureBufferOptions = {}) {
    this.console =
      options.console ??
      (globalThis.console as unknown as WrappableConsole);

    // Resolve the observer ctor from options first, then fall back to the
    // runtime global when present. Leave undefined when neither exists so
    // network capture silently no-ops in environments like jsdom.
    const runtimePO =
      typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : undefined;
    this.observerCtor = options.PerformanceObserverCtor ?? runtimePO;

    this.maxEntries = options.maxEntries ?? CaptureBuffer.DEFAULT_MAX_ENTRIES;
    if (this.maxEntries < 1) {
      throw new Error('CaptureBuffer: maxEntries must be >= 1');
    }
    this.now = options.now ?? (() => new Date());

    // Resolve the capture-pref storage. Prefer the explicitly supplied
    // shim (tests). Otherwise, when running inside the Chrome extension
    // runtime, wrap `chrome.storage.local` and `chrome.storage.onChanged`
    // into the minimal shape we need. Outside both contexts we leave the
    // handle undefined and the prefs stay at their defaults (`true`).
    if (options.capturePrefStorage) {
      this.prefStorage = options.capturePrefStorage;
      this.prefAreaName = options.capturePrefStorage.areaName ?? 'local';
    } else if (
      typeof chrome !== 'undefined' &&
      chrome.storage?.local &&
      typeof chrome.storage.local.get === 'function'
    ) {
      this.prefStorage = {
        get: (keys) =>
          chrome.storage.local.get(
            keys as string | string[] | Record<string, unknown> | null,
          ) as Promise<Record<string, unknown>>,
        onChanged: chrome.storage.onChanged
          ? {
              addListener: (cb) => chrome.storage.onChanged.addListener(cb),
              removeListener: (cb) =>
                chrome.storage.onChanged.removeListener(cb),
            }
          : undefined,
      };
      this.prefAreaName = 'local';
    } else {
      this.prefStorage = undefined;
      this.prefAreaName = 'local';
    }
  }

  /**
   * Begin capturing. Idempotent — calling `start()` twice is a no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.wrapConsole('log');
    this.wrapConsole('warn');
    this.wrapConsole('error');

    if (this.observerCtor) {
      try {
        this.observer = new this.observerCtor((list) => {
          const entries = list.getEntries() as PerformanceResourceTiming[];
          for (const entry of entries) {
            this.pushNetwork(entry);
          }
        });
        this.observer.observe({ type: 'resource', buffered: true });
      } catch {
        // Some runtimes reject the observe options (older browsers,
        // jsdom polyfills). Fail closed: console capture still works.
        this.observer = undefined;
      }
    }

    // Hydrate capture prefs (Req 36.4) and subscribe to changes so a
    // toggle in the options page takes effect without a page reload.
    // Fire-and-forget: a slow read must not delay capture, and a missing
    // value keeps the default `true`.
    void this.refreshCapturePrefs();
    this.subscribeToCapturePrefs();
  }

  /**
   * Stop capturing. Restores wrapped console methods and disconnects
   * the performance observer. Idempotent.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    for (const level of ['log', 'warn', 'error'] as const) {
      const original = this.originals[level];
      if (original) {
        this.console[level] = original;
      }
    }
    this.originals = {};

    if (this.observer) {
      this.observer.disconnect();
      this.observer = undefined;
    }

    if (this.prefChangeListener && this.prefStorage?.onChanged) {
      this.prefStorage.onChanged.removeListener(this.prefChangeListener);
    }
    this.prefChangeListener = undefined;
  }

  /** Whether console capture is currently enabled (Req 36.4). */
  getConsoleEnabled(): boolean {
    return this.consoleEnabled;
  }

  /** Whether network capture is currently enabled (Req 36.4). */
  getNetworkEnabled(): boolean {
    return this.networkEnabled;
  }

  /**
   * Re-read the capture prefs from storage. Public for tests; in
   * production the values are kept fresh by `subscribeToCapturePrefs`.
   * Errors and missing keys leave the cached default in place.
   */
  async refreshCapturePrefs(): Promise<void> {
    if (!this.prefStorage) return;
    try {
      const stored = await this.prefStorage.get([
        CAPTURE_CONSOLE_PREF_KEY,
        CAPTURE_NETWORK_PREF_KEY,
      ]);
      const consoleVal = stored[CAPTURE_CONSOLE_PREF_KEY];
      const networkVal = stored[CAPTURE_NETWORK_PREF_KEY];
      this.consoleEnabled =
        typeof consoleVal === 'boolean' ? consoleVal : true;
      this.networkEnabled =
        typeof networkVal === 'boolean' ? networkVal : true;
    } catch {
      // Treat read failures as "stay on" so we never silently drop
      // capture data the user expects.
    }
  }

  private subscribeToCapturePrefs(): void {
    if (this.prefChangeListener) return;
    if (!this.prefStorage?.onChanged) return;
    const listener = (
      changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
      areaName: string,
    ): void => {
      if (areaName !== this.prefAreaName) return;
      if (CAPTURE_CONSOLE_PREF_KEY in changes) {
        const next = changes[CAPTURE_CONSOLE_PREF_KEY]?.newValue;
        this.consoleEnabled = typeof next === 'boolean' ? next : true;
      }
      if (CAPTURE_NETWORK_PREF_KEY in changes) {
        const next = changes[CAPTURE_NETWORK_PREF_KEY]?.newValue;
        this.networkEnabled = typeof next === 'boolean' ? next : true;
      }
    };
    this.prefChangeListener = listener;
    this.prefStorage.onChanged.addListener(listener);
  }

  /** Snapshot of the captured console entries (oldest first). */
  getConsoleEntries(): CapturedConsoleEntry[] {
    return this.consoleBuf.slice();
  }

  /** Snapshot of the captured network entries (oldest first). */
  getNetworkEntries(): CapturedNetworkEntry[] {
    return this.networkBuf.slice();
  }

  /** Drop every captured entry from both buffers. */
  clear(): void {
    this.consoleBuf.length = 0;
    this.networkBuf.length = 0;
  }

  // --- internals ---------------------------------------------------------

  private wrapConsole(level: CapturedConsoleLevel): void {
    const original = this.console[level].bind(this.console);
    this.originals[level] = this.console[level];

    const self = this;
    this.console[level] = function captureBufferWrapped(
      ...args: unknown[]
    ): void {
      try {
        self.pushConsole(level, args);
      } catch {
        // The buffer must never break the host page's console.
      }
      original(...args);
    };
  }

  private pushConsole(level: CapturedConsoleLevel, args: unknown[]): void {
    if (!this.consoleEnabled) return;
    const entry: CapturedConsoleEntry = {
      level,
      message: formatConsoleArgs(args),
      timestamp: this.now().toISOString(),
    };
    if (level !== 'log') {
      const stack = extractStack(args);
      if (stack) entry.stack = stack;
    }
    this.consoleBuf.push(entry);
    if (this.consoleBuf.length > this.maxEntries) {
      this.consoleBuf.shift();
    }
  }

  private pushNetwork(entry: PerformanceResourceTiming): void {
    if (!this.networkEnabled) return;
    const captured: CapturedNetworkEntry = {
      name: entry.name,
      initiatorType: entry.initiatorType,
      startTime: entry.startTime,
      duration: entry.duration,
    };
    if (typeof entry.transferSize === 'number') {
      captured.transferSize = entry.transferSize;
    }
    const status = (entry as PerformanceResourceTiming & {
      responseStatus?: number;
    }).responseStatus;
    if (typeof status === 'number') {
      captured.responseStatus = status;
    }
    this.networkBuf.push(captured);
    if (this.networkBuf.length > this.maxEntries) {
      this.networkBuf.shift();
    }
  }
}

/** Format `console.*` arguments into a single string. */
function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

/**
 * Pick out the first Error in `args` and return its stack, when available.
 * Falls back to `undefined` so callers can omit the field.
 */
function extractStack(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (arg instanceof Error && typeof arg.stack === 'string') {
      return arg.stack;
    }
  }
  return undefined;
}

export default CaptureBuffer;
