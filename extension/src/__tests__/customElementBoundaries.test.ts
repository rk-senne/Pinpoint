// @vitest-environment jsdom

/**
 * Integration test for task 9 / Req 50.1: every Custom Element in the
 * extension wraps `connectedCallback` and `disconnectedCallback` with
 * `withBoundary` so synchronous throws during mount / unmount cannot
 * break the host page's runtime, and the failure is surfaced via an
 * inline `<fl-error-tag>` indicator inside the affected element.
 *
 * The probe element below exercises the canonical wiring path used by
 * every `<fl-*>` component: wrap the lifecycle callbacks on the
 * prototype before `customElements.define()`, then mount the element.
 * That ordering matters because the custom-elements spec caches
 * lifecycle callbacks on the registered definition by reading the
 * class prototype at definition time — a constructor-time own-property
 * override is never observed by the engine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { withBoundary } from '../lib/withBoundary';

describe('Custom Element error boundaries (Req 50.1)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('connecting an element whose connectedCallback throws does not bubble the exception, and renders <fl-error-tag>', () => {
    class FlBoundaryProbe extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' });
      }
      connectedCallback(): void {
        throw new Error('probe boom');
      }
      disconnectedCallback(): void {
        // intentionally a no-op so withBoundary has a function to wrap
      }
    }

    // Wrap on the prototype BEFORE define() — the spec caches the
    // callback at definition time. This mirrors what every real
    // `<fl-*>` component in the extension does.
    withBoundary(FlBoundaryProbe.prototype, 'connectedCallback');
    withBoundary(FlBoundaryProbe.prototype, 'disconnectedCallback');

    if (!customElements.get('fl-boundary-probe')) {
      customElements.define('fl-boundary-probe', FlBoundaryProbe);
    }

    const el = document.createElement('fl-boundary-probe') as FlBoundaryProbe;

    expect(() => document.body.appendChild(el)).not.toThrow();

    // The error tag is appended to the open Shadow Root since the
    // probe attached one. (`pickRenderRoot` in `withBoundary`
    // prefers the Shadow Root when it exists.)
    const tag = el.shadowRoot!.querySelector('fl-error-tag');
    expect(tag).not.toBeNull();
    expect(tag!.hasAttribute('data-fl-error-tag')).toBe(true);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const [, payload] = consoleSpy.mock.calls[0] as [
      string,
      { method: string; error: { message: string } },
    ];
    expect(payload.method).toBe('connectedCallback');
    expect(payload.error.message).toBe('probe boom');

    el.remove();
  });

  it('repeated mount failures render exactly one <fl-error-tag> on the affected element', () => {
    let count = 0;
    class FlFlakyProbe extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' });
      }
      connectedCallback(): void {
        count += 1;
        throw new Error(`flaky ${count}`);
      }
    }
    withBoundary(FlFlakyProbe.prototype, 'connectedCallback');
    if (!customElements.get('fl-boundary-flaky')) {
      customElements.define('fl-boundary-flaky', FlFlakyProbe);
    }

    const el = document.createElement('fl-boundary-flaky') as FlFlakyProbe;
    document.body.appendChild(el);
    el.remove();
    document.body.appendChild(el);
    el.remove();
    document.body.appendChild(el);

    // connectedCallback fires once per appendChild — so 3 throws total.
    expect(count).toBe(3);
    expect(consoleSpy).toHaveBeenCalledTimes(3);

    // Exactly ONE error tag despite three failures.
    expect(el.shadowRoot!.querySelectorAll('fl-error-tag')).toHaveLength(1);

    el.remove();
  });

  it('regression: every shipping <fl-*> component has its prototype lifecycle wrapped (loaded by the extension under test)', async () => {
    // Importing the components module-graph as a side-effect runs the
    // `withBoundary(Class.prototype, 'connectedCallback')` calls. We
    // assert that the wrapped prototype methods are no longer the
    // identity functions originally defined on the class — the
    // wrapper renames its function to `wrappedByBoundary`.
    const { FlOverlayHost } = await import('../components/OverlayHost.js');
    const { FlPopover } = await import('../components/Popover.js');
    const { FlSidebarPanel } = await import('../components/SidebarPanel.js');

    const tagged = (proto: object, key: string): boolean => {
      const fn = (proto as Record<string, unknown>)[key];
      return typeof fn === 'function' && fn.name === 'wrappedByBoundary';
    };

    expect(tagged(FlOverlayHost.prototype, 'connectedCallback')).toBe(true);
    expect(tagged(FlOverlayHost.prototype, 'disconnectedCallback')).toBe(true);
    expect(tagged(FlPopover.prototype, 'connectedCallback')).toBe(true);
    expect(tagged(FlPopover.prototype, 'disconnectedCallback')).toBe(true);
    expect(tagged(FlSidebarPanel.prototype, 'connectedCallback')).toBe(true);
    expect(tagged(FlSidebarPanel.prototype, 'disconnectedCallback')).toBe(true);
  });
});
