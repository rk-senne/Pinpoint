/**
 * connectionMonitor — combines `navigator.onLine` with an active heartbeat
 * against the API server so the overlay can show an "Offline" banner when
 * either signal goes red (task 36.8 / Req 44.1).
 *
 * Why both signals? Browser `navigator.onLine` only flips on network-stack
 * changes (cable unplugged, Wi-Fi disconnected, captive portal). It does not
 * reflect "the API is reachable but is hard-down" or "we are on a portal
 * that lets DNS through but refuses our origin", which the design calls
 * out in §"Offline behaviour" as the failure modes the banner needs to
 * cover. So we add a 30-second `HEAD /api/v1/health` heartbeat: three
 * consecutive failures flip us offline, a single success flips us back.
 *
 * Public surface:
 *   - `createConnectionMonitor(options?)`: factory returning
 *     `{ isOffline: Signal<boolean>, dispose(): void, checkNow(): Promise<void> }`.
 *     `isOffline` is a `signal<boolean>()` slice ready to plug into the
 *     overlay store. `dispose()` removes window listeners and stops the
 *     polling timer.
 *
 * The monitor is intentionally side-effect-free at module load. The content
 * script (or the overlay host's `connectedCallback`) constructs one
 * instance and disposes it on teardown, so unit tests can spin up isolated
 * monitors without leaking timers.
 *
 * Implements: Requirement 44.1.
 */
import { signal, type Signal } from '@pinpoint/shared';

import { API_BASE, resolveServerOrigin as defaultResolveOrigin } from './api';

/** Number of consecutive heartbeat failures before flipping to offline. */
export const FAILURE_THRESHOLD = 3;

/** Interval between heartbeats while the page has focus (milliseconds). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** AbortController timeout for a single heartbeat (milliseconds). */
export const HEARTBEAT_TIMEOUT_MS = 5_000;

/** Public surface of a `ConnectionMonitor` instance. */
export interface ConnectionMonitor {
  /** `true` when offline (heartbeat-failed or `navigator.onLine === false`). */
  readonly isOffline: Signal<boolean>;
  /** Stop listening to events and clear the polling timer. */
  dispose(): void;
  /**
   * Force a heartbeat right now. Resolves once the heartbeat completes
   * (success or failure). Useful for tests and for the `online` event
   * handler so the banner clears immediately when the network returns.
   */
  checkNow(): Promise<void>;
}

/** Factory options — all optional; defaults match the spec. */
export interface ConnectionMonitorOptions {
  /**
   * URL of the heartbeat endpoint. Defaults to
   * `${origin}${API_BASE}/health` resolved at construction time. Tests
   * inject a stub URL to keep heartbeats hermetic.
   */
  url?: string;
  /**
   * Custom `fetch` implementation. Defaults to `globalThis.fetch`. Tests
   * inject a fake to control success / failure / timeout.
   */
  fetchImpl?: typeof fetch;
  /** Override the heartbeat interval. */
  intervalMs?: number;
  /** Override the heartbeat timeout. */
  timeoutMs?: number;
  /**
   * Number of consecutive failures before flipping offline. Defaults to
   * `FAILURE_THRESHOLD` (3) per spec.
   */
  failureThreshold?: number;
  /**
   * If `false`, the heartbeat timer never starts. The monitor only
   * reacts to `online` / `offline` window events. Used as a fallback
   * when no heartbeat URL is available — see "graceful degradation"
   * comment below.
   */
  enableHeartbeat?: boolean;
  /**
   * Override the server-origin resolver. Defaults to the same global
   * (`__PINPOINT_API_ORIGIN__`) that `lib/api.ts` consults so the
   * monitor talks to the same server as the rest of the extension.
   */
  resolveOrigin?: () => string;
}

/**
 * Resolve the server origin the heartbeat should target. Delegates to
 * `lib/api.ts`'s exported resolver so the monitor and the API client
 * never drift.
 */

/**
 * `true` when `navigator.onLine` is available and reports `false`. We
 * read this dynamically (not at construction) because the OS can flip
 * it without firing an `offline` event in some browsers.
 */
function browserReportsOffline(): boolean {
  if (typeof navigator === 'undefined') return false;
  // `navigator.onLine` is a runtime read; no caching.
  return navigator.onLine === false;
}

/**
 * Build a `ConnectionMonitor`. Each call returns an independent instance
 * (own signal, own listeners, own timer) so tests and per-tab monitors
 * never share state.
 *
 * Graceful degradation: if `globalThis.fetch` is undefined (highly
 * constrained Manifest V3 worker shapes that have not loaded `fetch`
 * yet), we still wire the `online`/`offline` window events and skip the
 * heartbeat — `navigator.onLine` becomes the only signal. The banner
 * still works for the obvious "Wi-Fi off" case; it just won't catch
 * "API is hard-down". This matches the task's instruction to "fall back
 * to using `navigator.onLine` only and document the gap in a comment".
 */
export function createConnectionMonitor(
  options: ConnectionMonitorOptions = {},
): ConnectionMonitor {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const failureThreshold = options.failureThreshold ?? FAILURE_THRESHOLD;
  const fetchImpl =
    options.fetchImpl ??
    (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  const resolveOrigin = options.resolveOrigin ?? defaultResolveOrigin;
  const heartbeatUrl =
    options.url ?? `${resolveOrigin()}${API_BASE}/health`;
  const enableHeartbeat =
    options.enableHeartbeat ?? typeof fetchImpl === 'function';

  const isOffline = signal<boolean>(browserReportsOffline());

  let consecutiveFailures = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let inFlight: Promise<void> | null = null;

  const updateBannerState = (offline: boolean): void => {
    isOffline.set(offline);
  };

  /**
   * Heartbeat single-shot. Returns once the request completes (or the
   * `AbortController` fires the timeout). Concurrent calls coalesce
   * onto the in-flight promise so the timer firing while a manual
   * `checkNow()` is in progress does not double-issue.
   */
  const heartbeatOnce = async (): Promise<void> => {
    if (inFlight) return inFlight;
    if (typeof fetchImpl !== 'function') {
      // No fetch available — heartbeat is disabled. We still respect
      // `navigator.onLine` (set during construction and refreshed by
      // window events).
      return;
    }

    const ac = new AbortController();
    const timeoutHandle: ReturnType<typeof setTimeout> | undefined =
      typeof timeoutMs === 'number' && timeoutMs > 0
        ? setTimeout(() => ac.abort(), timeoutMs)
        : undefined;

    const work = (async () => {
      try {
        const res = await fetchImpl(heartbeatUrl, {
          method: 'HEAD',
          signal: ac.signal,
          // Heartbeats must never carry credentials — `/api/v1/health`
          // is unauthenticated and we don't want the cookie / bearer
          // overhead on a 30-second poll.
          credentials: 'omit',
          // No cache; we want an actual reachability check.
          cache: 'no-store',
        });
        if (res.ok) {
          // A single success clears the offline state, per spec.
          consecutiveFailures = 0;
          if (isOffline.get()) {
            updateBannerState(false);
          }
        } else {
          // 4xx/5xx counts as a failure: the server is reachable but
          // not healthy.
          consecutiveFailures += 1;
          if (consecutiveFailures >= failureThreshold) {
            updateBannerState(true);
          }
        }
      } catch {
        // Network error, abort, or DNS failure all count.
        consecutiveFailures += 1;
        if (consecutiveFailures >= failureThreshold) {
          updateBannerState(true);
        }
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    })();

    const tracked = work.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };

  const onOnline = (): void => {
    // navigator.onLine just flipped to true. Don't assume reachability —
    // run an immediate heartbeat so the banner clears only when the API
    // actually answers. If heartbeats are disabled, fall through to
    // clearing the offline state directly (we have no better signal).
    if (enableHeartbeat && typeof fetchImpl === 'function') {
      void heartbeatOnce();
    } else if (isOffline.get()) {
      updateBannerState(false);
    }
  };

  const onOffline = (): void => {
    // navigator.onLine just flipped to false. Flip immediately —
    // requiring three failed heartbeats here would leave the banner
    // hidden for ~90s after the user yanks their cable, which is the
    // exact scenario Req 44.1 is designed to catch.
    consecutiveFailures = failureThreshold;
    updateBannerState(true);
  };

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
  }

  if (enableHeartbeat && typeof fetchImpl === 'function') {
    // Kick off the first heartbeat immediately so the banner reflects
    // current reachability without a 30-second wait. We deliberately do
    // not `await` here — `createConnectionMonitor` must remain
    // synchronous so callers can subscribe to `isOffline` before the
    // network call resolves.
    void heartbeatOnce();
    timer = setInterval(() => {
      void heartbeatOnce();
    }, intervalMs);
  }

  return {
    isOffline,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      }
    },
    checkNow(): Promise<void> {
      if (disposed) return Promise.resolve();
      return heartbeatOnce();
    },
  };
}
