/**
 * Side-effect module: MUST be imported BEFORE `@webcomponents/custom-elements`
 * (see `isolatedWorldElements.ts`). On Firefox it flags the native registry
 * so the polyfill installs its own — see `customElementsPolyfillPolicy.ts`
 * for why. A no-op everywhere else.
 */
import { shouldForceCustomElementsPolyfill } from './customElementsPolyfillPolicy';

const registry = (globalThis as { customElements?: unknown }).customElements as
  | { forcePolyfill?: boolean }
  | null
  | undefined;
if (
  registry &&
  typeof navigator !== 'undefined' &&
  shouldForceCustomElementsPolyfill(navigator.userAgent)
) {
  try {
    registry.forcePolyfill = true;
  } catch {
    /* frozen registry — the polyfill then simply stays off */
  }
}
