// @vitest-environment jsdom
/**
 * Unit tests for `withContentScriptBoundary`.
 *
 * Validates Requirement 50.2 (task 42.2): the content script's outer
 * mount/unmount must never propagate exceptions into the host page's
 * runtime. Specifically:
 *
 *   - Synchronous throws inside the wrapped fn are caught; the outer
 *     code (the caller — i.e. content.ts) continues executing.
 *   - Asynchronous rejections inside the wrapped fn are caught; the
 *     wrapped Promise resolves to `undefined` so callers can safely
 *     `await` it.
 *   - Every caught error is logged via `console.error` under the
 *     stable `[Pinpoint ContentScriptBoundary]` tag so developers
 *     can grep for failures during development.
 *   - The global `unhandledrejection` listener is installed exactly
 *     once across multiple `withContentScriptBoundary` invocations.
 *   - The boundary preserves return values for happy-path executions
 *     and does not log when nothing went wrong.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTests,
  FL_BOUNDARY_MARKER,
  withContentScriptBoundary,
} from './ContentScriptBoundary';

const LOG_TAG = '[Pinpoint ContentScriptBoundary]';

describe('withContentScriptBoundary', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetForTests();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('runs the function and returns nothing for a synchronous happy path', () => {
    let ran = false;
    const result = withContentScriptBoundary(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(result).toBeUndefined();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('catches a synchronous throw inside the wrapped fn so outer code continues', () => {
    let outerRan = false;
    expect(() => {
      withContentScriptBoundary(() => {
        throw new Error('mount blew up');
      });
      // This statement executes only if the boundary swallowed the throw.
      outerRan = true;
    }).not.toThrow();
    expect(outerRan).toBe(true);
  });

  it('logs the synchronous throw with the [Pinpoint ContentScriptBoundary] tag', () => {
    withContentScriptBoundary(() => {
      throw new Error('sync boom');
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const args = consoleErrorSpy.mock.calls[0];
    expect(args[0]).toBe(LOG_TAG);
    // The second argument is the normalised payload.
    const payload = args[1] as { name: string; message: string };
    expect(payload.message).toBe('sync boom');
    expect(payload.name).toBe('Error');
  });

  it('catches an asynchronous rejection so outer code continues', async () => {
    const result = withContentScriptBoundary(async () => {
      throw new Error('async boom');
    });
    // The wrapped boundary must return a Promise that resolves rather
    // than rejecting — otherwise the caller would itself need a
    // try/catch and we'd be back where we started.
    await expect(result).resolves.toBeUndefined();
  });

  it('logs the async rejection with the expected tag and payload', async () => {
    await withContentScriptBoundary(async () => {
      throw new Error('async fail');
    });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const args = consoleErrorSpy.mock.calls[0];
    expect(args[0]).toBe(LOG_TAG);
    const payload = args[1] as { name: string; message: string };
    expect(payload.message).toBe('async fail');
  });

  it('preserves the resolved value path of an async fn that does not throw', async () => {
    let ran = false;
    await withContentScriptBoundary(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('marks rejection reasons with FL_BOUNDARY_MARKER so unhandledrejection listener can recognise them', async () => {
    const reason = new Error('with marker');
    await withContentScriptBoundary(async () => {
      throw reason;
    });
    // The boundary tags the reason in-place before logging so a re-thrown
    // copy carrying the same reference can be recognised by the global
    // unhandledrejection listener.
    expect((reason as unknown as Record<symbol, unknown>)[FL_BOUNDARY_MARKER]).toBe(true);
  });

  it('handles non-Error throw values without crashing', () => {
    expect(() => {
      withContentScriptBoundary(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'string reason';
      });
    }).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const args = consoleErrorSpy.mock.calls[0];
    expect(args[0]).toBe(LOG_TAG);
  });

  it('installs the unhandledrejection listener exactly once across multiple calls', () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    withContentScriptBoundary(() => undefined);
    withContentScriptBoundary(() => undefined);
    withContentScriptBoundary(() => undefined);

    const unhandledCalls = addEventListenerSpy.mock.calls.filter(
      ([eventName]) => eventName === 'unhandledrejection',
    );
    expect(unhandledCalls).toHaveLength(1);

    addEventListenerSpy.mockRestore();
  });

  it('the installed unhandledrejection listener prevents propagation for marker-tagged reasons', () => {
    // Prime the listener by going through the boundary once.
    withContentScriptBoundary(() => undefined);

    const reason: Record<symbol, unknown> & { message: string; stack?: string } = {
      message: 'simulated overlay failure',
    };
    reason[FL_BOUNDARY_MARKER] = true;

    // Build a faux PromiseRejectionEvent — jsdom 26+ supports the
    // constructor, but we synthesise one by hand for portability.
    const preventDefault = vi.fn();
    const event = new Event('unhandledrejection') as Event & {
      reason: unknown;
      preventDefault: () => void;
    };
    Object.defineProperty(event, 'reason', { value: reason, configurable: true });
    Object.defineProperty(event, 'preventDefault', {
      value: preventDefault,
      configurable: true,
    });

    window.dispatchEvent(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    // The listener also re-logs, so the tag should appear in console.error.
    const tagged = consoleErrorSpy.mock.calls.some(
      (args) => args[0] === LOG_TAG,
    );
    expect(tagged).toBe(true);
  });

  it('the unhandledrejection listener leaves unrelated host-page rejections alone', () => {
    withContentScriptBoundary(() => undefined);

    const preventDefault = vi.fn();
    const event = new Event('unhandledrejection') as Event & {
      reason: unknown;
      preventDefault: () => void;
    };
    // No marker, no stack referencing our content script — this looks
    // like a genuine host-page rejection. The listener must not
    // suppress it; otherwise we'd be hiding the host page's own bugs.
    Object.defineProperty(event, 'reason', {
      value: new Error('unrelated host failure'),
      configurable: true,
    });
    Object.defineProperty(event, 'preventDefault', {
      value: preventDefault,
      configurable: true,
    });

    window.dispatchEvent(event);

    expect(preventDefault).not.toHaveBeenCalled();
  });
});
