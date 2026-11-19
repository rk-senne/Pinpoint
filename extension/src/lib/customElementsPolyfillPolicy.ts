/**
 * Decides whether the content script must install the
 * `@webcomponents/custom-elements` polyfill even though a native
 * `window.customElements` exists.
 *
 * Chrome: the isolated world has `customElements === null`, so the polyfill
 * installs itself (no policy needed).
 *
 * Firefox: content scripts DO get a `customElements` object, and
 * `define()` / `get()` succeed, but elements created from the extension
 * sandbox are never upgraded (neither `createElement`, nor clones appended
 * to a Shadow Root, nor `appendChild`) — the registry is bound to the page's
 * global, which cannot run the extension's constructors. Every overlay
 * element then stays a plain `HTMLElement` (no private fields, no setters)
 * and the overlay never mounts. Verified in Firefox 150 with
 * `e2e/firefox/run.mjs`. Forcing the polyfill gives the sandbox its own
 * registry, exactly like Chrome's isolated world.
 */
export function shouldForceCustomElementsPolyfill(userAgent: string | undefined): boolean {
  return typeof userAgent === 'string' && /\bFirefox\/\d/.test(userAgent);
}
