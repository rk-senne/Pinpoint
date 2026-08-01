/**
 * Vitest setup for jsdom environments on Node v26+.
 *
 * Node v26 declares `localStorage` and `sessionStorage` as native globals but
 * they return `undefined` unless `--localstorage-file` is passed. This shadows
 * jsdom's implementation — jsdom sets a getter on the window but the native
 * global proxy intercepts the access first and returns `undefined`.
 *
 * Workaround: when jsdom is active, override the global `localStorage` and
 * `sessionStorage` with jsdom's internal Storage instances (`_localStorage`,
 * `_sessionStorage`).
 */
if (typeof window !== 'undefined') {
  const win = window as any;

  if (win._localStorage) {
    Object.defineProperty(globalThis, 'localStorage', {
      value: win._localStorage,
      writable: true,
      configurable: true,
    });
  }

  if (win._sessionStorage) {
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: win._sessionStorage,
      writable: true,
      configurable: true,
    });
  }
}
