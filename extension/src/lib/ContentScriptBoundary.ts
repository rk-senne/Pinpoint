/**
 * `ContentScriptBoundary` — outer error boundary for the content script.
 *
 * Per task 42.2 of the pinpoint-app spec (Requirement 50.2) and
 * design §"Error boundaries":
 *
 *   - The Custom Element-level boundary (`withBoundary`, task 42.1) only
 *     catches errors thrown inside an individual Custom Element's
 *     lifecycle / event handlers. Failures that happen BEFORE the first
 *     element is constructed — e.g. inside `mountOverlay()` while
 *     building the Shadow Host, importing components, calling
 *     `customElements.define`, or resolving the active project — would
 *     still bubble up into the host page's runtime and could break a
 *     site's own JavaScript.
 *   - This module supplies a higher-level boundary that wraps the
 *     content script's mount AND any unmount paths so synchronous
 *     throws and rejected promises are swallowed before they reach the
 *     host page. The wrapper logs every caught error to `console.error`
 *     under a stable tag (`[Pinpoint ContentScriptBoundary]`) so
 *     the failure remains visible during development without taking the
 *     page down.
 *   - It also installs a one-time global `unhandledrejection` listener
 *     that filters for rejections originating inside the overlay
 *     (identified by stack trace + a custom marker on rejection
 *     reasons) and prevents them from bubbling into the page's own
 *     `window.onunhandledrejection` handler.
 *
 * The wrapper is intentionally minimal and side-effect free at module
 * scope: importing this file does NOT install any listeners. The
 * listener is installed lazily by `withContentScriptBoundary` the
 * first time it is called, so unit tests for unrelated modules don't
 * accidentally pick up the global handler.
 */

const LOG_TAG = '[Pinpoint ContentScriptBoundary]';

/**
 * Marker attached to rejection `reason` objects (or strings) by the
 * boundary so the global `unhandledrejection` listener can recognise
 * rejections that originated inside the overlay versus genuine host-
 * page rejections that happen to share the event loop. The marker is a
 * Symbol so it cannot collide with any property the host page sets.
 */
export const FL_BOUNDARY_MARKER = Symbol.for('pinpoint.boundaryMarker');

/**
 * Track whether the global `unhandledrejection` listener has already
 * been installed so repeated `withContentScriptBoundary` calls do not
 * stack multiple listeners. Module-scoped so HMR / repeated imports
 * remain idempotent within a single page load.
 */
let unhandledRejectionListenerInstalled = false;

/**
 * Bookkeeping for the installed listener so unit tests can detach it
 * between cases via `__resetForTests`. Production code never reads
 * these — they exist purely to keep the test environment hermetic.
 */
let installedListener: ((event: Event) => void) | null = null;
let installedListenerTarget: EventTarget | null = null;

/**
 * Test-only: reset the one-time listener flag (and detach the
 * previously-registered listener) so unit tests can verify
 * registration behaviour across cases without leaking handlers
 * between tests. Not part of the public surface used by the content
 * script.
 */
export function __resetForTests(): void {
  if (
    installedListener !== null &&
    installedListenerTarget !== null &&
    typeof installedListenerTarget.removeEventListener === 'function'
  ) {
    installedListenerTarget.removeEventListener('unhandledrejection', installedListener);
  }
  installedListener = null;
  installedListenerTarget = null;
  unhandledRejectionListenerInstalled = false;
}

/**
 * Best-effort detection of a "thenable" — covers native Promises,
 * `async` function results, and any object with a `.then` method that
 * behaves like a Promise. Mirrors the check used inside `withBoundary`
 * (task 42.1) so the two boundaries treat async failures consistently.
 */
function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Normalise a thrown / rejected value into a structured payload the
 * `console.error` log can carry without losing information when the
 * value is something unusual (a string, a `null`, a non-Error object).
 */
function normaliseError(err: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  try {
    return { name: 'NonError', message: String(err) };
  } catch {
    return { name: 'NonError', message: '<unprintable>' };
  }
}

/**
 * Mark a rejection reason so the global `unhandledrejection` listener
 * can recognise it as overlay-originated. We tag both the reason
 * itself (when it is an object) and the rejection's eventual stack
 * fingerprint via `console.error` ahead of time. The marker is a
 * `Symbol.for(...)` lookup so the same symbol is shared across module
 * instances under a single realm — important because the bundled
 * content script can be re-evaluated under HMR.
 */
function markRejectionReason(reason: unknown): void {
  if (reason !== null && typeof reason === 'object') {
    try {
      (reason as Record<symbol, unknown>)[FL_BOUNDARY_MARKER] = true;
    } catch {
      // The reason may be frozen / sealed (e.g. SyntaxError under some
      // engines). Marker is best-effort; the listener falls back to
      // stack-trace matching when the marker is missing.
    }
  }
}

/**
 * Log a caught error in a structured form. The tag `[Pinpoint
 * ContentScriptBoundary]` is stable so developers can grep for it in
 * the host page's console; the second argument carries the normalised
 * error payload alongside the original value for debugging.
 */
function logCaught(err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(LOG_TAG, normaliseError(err), err);
}

/**
 * Install — exactly once per page load — a global `unhandledrejection`
 * listener that swallows rejections originating from inside the
 * overlay. Recognition relies on the `FL_BOUNDARY_MARKER` symbol that
 * `withContentScriptBoundary` writes onto every rejection reason it
 * catches before re-emitting `undefined`. Marker-less rejections are
 * left alone — they're either genuine host-page bugs (which the page
 * is responsible for) or rare overlay rejections that escaped the
 * boundary entirely (which we'd rather log loudly than silently
 * swallow under a guess-y heuristic). The marker approach makes the
 * listener's behaviour fully deterministic and avoids matching
 * unrelated stack frames that just happen to mention our project.
 *
 * The listener calls `event.preventDefault()` so the rejection does
 * not propagate to `window.onunhandledrejection` on the host page.
 *
 * The listener is installed against `window` because `globalThis.window`
 * is the canonical event target inside a content script; falling back
 * to `globalThis` covers test environments (jsdom) that may have a
 * non-window global.
 */
function ensureUnhandledRejectionListener(): void {
  if (unhandledRejectionListenerInstalled) return;
  if (typeof globalThis.addEventListener !== 'function') return;
  const target: EventTarget = (globalThis as { window?: EventTarget }).window ?? globalThis;
  if (typeof (target as EventTarget).addEventListener !== 'function') return;

  const listener = (event: Event): void => {
    const ev = event as PromiseRejectionEvent;
    const reason = ev.reason;
    if (
      reason === null ||
      typeof reason !== 'object' ||
      !(reason as Record<symbol, unknown>)[FL_BOUNDARY_MARKER]
    ) {
      // Not an overlay-originated rejection — leave it alone so the
      // host page's own bugs remain observable.
      return;
    }

    logCaught(reason);
    // Suppress propagation to the host page's handlers.
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
  };
  target.addEventListener('unhandledrejection', listener);
  installedListener = listener;
  installedListenerTarget = target;
  unhandledRejectionListenerInstalled = true;
}

/**
 * Wrap a content-script entry function (mount, unmount, or any other
 * top-level invocation) so synchronous throws and rejected promises
 * never propagate into the host page's runtime.
 *
 *   - Synchronous throws are caught, logged with `console.error` under
 *     the `[Pinpoint ContentScriptBoundary]` tag, and swallowed.
 *   - Promise rejections are caught the same way; the wrapper returns
 *     a Promise that always resolves to `undefined` so callers can
 *     `await` it without worrying about an unhandled rejection.
 *   - Before catching the rejected reason, the boundary tags it with
 *     `FL_BOUNDARY_MARKER` so the lazily-installed
 *     `unhandledrejection` listener can recognise re-thrown copies.
 *   - The first call lazily installs the global
 *     `unhandledrejection` listener so promise rejections from inside
 *     the overlay that escape the wrapper (e.g. unawaited promises
 *     spawned by event handlers) are also suppressed.
 *
 * Returns `void` for synchronous `fn`s and `Promise<void>` for
 * asynchronous ones. The return value mirrors `fn` so callers can
 * decide whether to `await` the boundary based on `fn`'s shape.
 */
export function withContentScriptBoundary(
  fn: () => void | Promise<void>,
): void | Promise<void> {
  ensureUnhandledRejectionListener();

  let result: void | Promise<void>;
  try {
    result = fn();
  } catch (err) {
    logCaught(err);
    return;
  }

  if (isThenable(result)) {
    return result.then(
      () => undefined,
      (err: unknown) => {
        markRejectionReason(err);
        logCaught(err);
        return undefined;
      },
    );
  }
  return result;
}
