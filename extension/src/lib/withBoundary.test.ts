// @vitest-environment jsdom
/**
 * Unit tests for `withBoundary` and `<fl-error-tag>`.
 *
 * Validates Requirement 50.1:
 *   - Normal calls pass through unchanged (return value preserved).
 *   - Synchronous throws are caught; the error is logged and the
 *     `<fl-error-tag>` indicator is rendered inside the affected element.
 *   - Rejected promises are caught the same way.
 *   - Multiple failing calls on the same element render exactly ONE
 *     error tag — repeated failures do not accumulate indicators.
 *   - The wrapper preserves `this` binding and forwards arguments.
 *   - Errors thrown inside a wrapped method do not propagate to the
 *     caller (the host page must remain stable).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FlErrorTag, renderInlineErrorTag, withBoundary } from './withBoundary';

describe('FlErrorTag custom element', () => {
  it('is registered under <fl-error-tag>', () => {
    expect(customElements.get('fl-error-tag')).toBe(FlErrorTag);
  });

  it('renders the "Something went wrong" indicator with role="alert"', () => {
    const tag = document.createElement('fl-error-tag') as FlErrorTag;
    document.body.appendChild(tag);
    const span = tag.shadowRoot!.querySelector('span.fl-error-tag') as HTMLSpanElement;
    expect(span).not.toBeNull();
    expect(span.getAttribute('role')).toBe('alert');
    expect(span.textContent).toBe('Something went wrong');
    tag.remove();
  });
});

describe('renderInlineErrorTag', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('appends a <fl-error-tag> into the host element when there is no Shadow Root', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    renderInlineErrorTag(host);

    const tag = host.querySelector('fl-error-tag');
    expect(tag).not.toBeNull();
    expect(tag!.hasAttribute('data-fl-error-tag')).toBe(true);
  });

  it('appends a <fl-error-tag> into the open Shadow Root when present', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);

    renderInlineErrorTag(host);

    expect(host.querySelector('fl-error-tag')).toBeNull();
    expect(shadow.querySelector('fl-error-tag')).not.toBeNull();
  });

  it('is idempotent: calling it twice on the same host renders one tag', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    renderInlineErrorTag(host);
    renderInlineErrorTag(host);
    renderInlineErrorTag(host);

    expect(host.querySelectorAll('fl-error-tag')).toHaveLength(1);
  });

  it('is a no-op when host is null/undefined', () => {
    expect(() => renderInlineErrorTag(null)).not.toThrow();
    expect(() => renderInlineErrorTag(undefined)).not.toThrow();
  });
});

describe('withBoundary', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('passes the return value of a normal call through unchanged', () => {
    const target = {
      doWork(a: number, b: number): number {
        return a + b;
      },
    };
    withBoundary(target, 'doWork');

    const result = target.doWork(2, 3);

    expect(result).toBe(5);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('preserves `this` and forwards arguments', () => {
    const target = {
      offset: 10,
      compute(this: { offset: number }, n: number): number {
        return this.offset + n;
      },
    };
    withBoundary(target, 'compute');

    expect(target.compute(5)).toBe(15);
  });

  it('catches synchronous throws and logs the error', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    Object.defineProperty(host, 'connectedCallback', {
      configurable: true,
      writable: true,
      value: function (this: Element) {
        throw new Error('boom');
      },
    });
    withBoundary(host as unknown as Record<string, () => void>, 'connectedCallback');

    expect(() => (host as unknown as { connectedCallback(): void }).connectedCallback()).not.toThrow();

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const [, payload] = consoleSpy.mock.calls[0] as [string, { method: string; error: { message: string } }];
    expect(payload.method).toBe('connectedCallback');
    expect(payload.error.message).toBe('boom');
  });

  it('renders <fl-error-tag> inside the affected element on sync error', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    Object.defineProperty(host, 'doWork', {
      configurable: true,
      writable: true,
      value: function () {
        throw new Error('explode');
      },
    });
    withBoundary(host as unknown as Record<string, () => void>, 'doWork');

    (host as unknown as { doWork(): void }).doWork();

    expect(host.querySelectorAll('fl-error-tag')).toHaveLength(1);
  });

  it('does not propagate the error to the caller', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    Object.defineProperty(host, 'doWork', {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error('do not catch me');
      },
    });
    withBoundary(host as unknown as Record<string, () => void>, 'doWork');

    expect(() => (host as unknown as { doWork(): void }).doWork()).not.toThrow();
  });

  it('catches rejected promises returned by async methods', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    Object.defineProperty(host, 'asyncWork', {
      configurable: true,
      writable: true,
      value: async () => {
        throw new Error('async boom');
      },
    });
    withBoundary(host as unknown as Record<string, () => Promise<unknown>>, 'asyncWork');

    const result = await (host as unknown as { asyncWork(): Promise<unknown> }).asyncWork();

    expect(result).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll('fl-error-tag')).toHaveLength(1);
  });

  it('passes async resolved values through unchanged', async () => {
    const target = {
      async fetchValue(): Promise<number> {
        return 42;
      },
    };
    withBoundary(target, 'fetchValue');

    await expect(target.fetchValue()).resolves.toBe(42);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('does not accumulate <fl-error-tag> elements when the wrapped method throws repeatedly', () => {
    // Validates the explicit task acceptance criterion:
    //   "multiple calls don't accumulate error tags"
    const host = document.createElement('div');
    document.body.appendChild(host);
    let calls = 0;
    Object.defineProperty(host, 'flaky', {
      configurable: true,
      writable: true,
      value: () => {
        calls += 1;
        throw new Error(`fail ${calls}`);
      },
    });
    withBoundary(host as unknown as Record<string, () => void>, 'flaky');

    (host as unknown as { flaky(): void }).flaky();
    (host as unknown as { flaky(): void }).flaky();
    (host as unknown as { flaky(): void }).flaky();

    expect(calls).toBe(3);
    expect(consoleSpy).toHaveBeenCalledTimes(3);
    // Exactly ONE error tag despite three failures.
    expect(host.querySelectorAll('fl-error-tag')).toHaveLength(1);
  });

  it('throws TypeError if methodName does not resolve to a function on target', () => {
    const target = { notAFn: 42 } as unknown as { notAFn: () => void };
    expect(() => withBoundary(target, 'notAFn')).toThrow(TypeError);
  });

  it('protects a Custom Element lifecycle callback when applied to the prototype before define()', () => {
    // The custom-elements spec caches lifecycle callbacks on the
    // definition at `customElements.define()` time by reading the
    // class prototype. Wrapping on the prototype BEFORE `define()` is
    // therefore the canonical way to install `withBoundary` around
    // `connectedCallback` / `disconnectedCallback` so the wrapped
    // function ends up in the cached definition.
    class FlBoom extends HTMLElement {
      connectedCallback(): void {
        throw new Error('lifecycle boom');
      }
    }
    withBoundary(FlBoom.prototype, 'connectedCallback');
    if (!customElements.get('fl-boom-test')) {
      customElements.define('fl-boom-test', FlBoom);
    }

    const el = document.createElement('fl-boom-test') as FlBoom;
    expect(() => document.body.appendChild(el)).not.toThrow();

    expect(el.querySelectorAll('fl-error-tag')).toHaveLength(1);
    expect(consoleSpy).toHaveBeenCalledTimes(1);

    el.remove();
  });
});
