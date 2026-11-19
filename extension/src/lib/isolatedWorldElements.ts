/**
 * Custom Elements support for the content script's isolated world.
 *
 * Chrome runs content scripts in an isolated JS world where
 * `window.customElements` is `null` (the registry belongs to the page's
 * main world). Every overlay UI piece is a Custom Element, so without this
 * the first `customElements.get(...)` threw at import time and the overlay
 * could never mount on any page. Verified in real Chromium (148 and 149).
 *
 * `@webcomponents/custom-elements` installs a spec-compliant registry into
 * THIS world only; it is a no-op when a native registry already exists
 * (main world, jsdom). The host page's own registry is untouched, so tag
 * names can't collide with the site's components.
 *
 * Firefox is the exception: its content-script `customElements` exists but
 * never upgrades sandbox-defined elements, so `forceCustomElementsPolyfill`
 * flags it first (see `customElementsPolyfillPolicy.ts`).
 *
 * The polyfill assigns `window.HTMLElement` etc.; in Firefox's sandbox
 * `window !== globalThis`, so `installSyncPolyfilledGlobals` mirrors those
 * onto the real global (see `syncPolyfilledGlobals.ts`).
 *
 * MUST be the first import of `content.ts`: ES module evaluation order runs
 * this before any component module calls `customElements.define()`.
 */
import './forceCustomElementsPolyfill';
import '@webcomponents/custom-elements';
import './installSyncPolyfilledGlobals';
