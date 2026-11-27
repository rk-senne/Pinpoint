/**
 * Side-effect module: import AFTER `@webcomponents/custom-elements` (see
 * `isolatedWorldElements.ts`). Only acts when `window !== globalThis`, i.e.
 * in Firefox's content-script sandbox; a no-op in Chrome's isolated world.
 */
import { relaxDefinePrototypeCheck, syncPolyfilledGlobals } from './syncPolyfilledGlobals';

if (typeof window !== 'undefined' && (window as unknown) !== globalThis) {
  syncPolyfilledGlobals(
    window as unknown as Record<string, unknown>,
    globalThis as unknown as Record<string, unknown>,
  );
  relaxDefinePrototypeCheck(
    (globalThis as unknown as { customElements?: { define: (...a: unknown[]) => unknown } })
      .customElements,
  );
}
