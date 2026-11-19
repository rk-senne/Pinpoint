/**
 * Mirror the globals the Custom Elements polyfill installs on `window` onto
 * the content script's real global object.
 *
 * Chrome's isolated world has `window === globalThis`, so the polyfill's
 * `window.HTMLElement = …` is what bare `HTMLElement` resolves to. Firefox
 * content scripts run in a sandbox whose global is NOT `window` (`window` is
 * an Xray wrapper of the page window): the polyfill's replacement lands as an
 * expando on that wrapper while a bare `class X extends HTMLElement` still
 * binds the sandbox's native `HTMLElement`, whose construction then fails with
 * "The custom element constructor's prototype is not an object".
 * Copying the replaced bindings onto the sandbox global fixes that and is a
 * no-op when `window === globalThis`.
 */
const POLYFILLED_GLOBALS = ['HTMLElement', 'CustomElementRegistry', 'customElements'] as const;

export function syncPolyfilledGlobals(
  win: Record<string, unknown>,
  glob: Record<string, unknown>,
): string[] {
  if (win === glob) return [];
  const copied: string[] = [];
  for (const key of POLYFILLED_GLOBALS) {
    if (win[key] === undefined || win[key] === glob[key]) continue;
    try {
      Object.defineProperty(glob, key, {
        value: win[key],
        configurable: true,
        writable: true,
        enumerable: false,
      });
      copied.push(key);
    } catch {
      /* non-configurable binding — nothing more we can do for this key */
    }
  }
  return copied;
}

/**
 * Firefox sandbox: the polyfill's `define()` rejects every class with
 * "The custom element constructor's prototype is not an object" because it
 * tests `constructor.prototype instanceof Object` against the SANDBOX's
 * `Object`, while a class extending `HTMLElement` inherits from the page
 * compartment's `Object.prototype` (via the Xray-wrapped `HTMLElement`).
 * Wrap `define` so that, only for the duration of the call, `instanceof
 * Object` means "is an object" (the check's intent). Nothing else changes and
 * the shim is removed again before `define` returns.
 */
export function relaxDefinePrototypeCheck(
  registry: { define: (...args: unknown[]) => unknown } | null | undefined,
  ObjectCtor: ObjectConstructor = Object,
): boolean {
  if (!registry || typeof registry.define !== 'function') return false;
  const original = registry.define;
  if ((original as { __ppRelaxed?: boolean }).__ppRelaxed) return false;
  const isObject = (v: unknown): boolean =>
    v !== null && (typeof v === 'object' || typeof v === 'function');
  const relaxed = function (this: unknown, ...args: unknown[]): unknown {
    const had = Object.prototype.hasOwnProperty.call(ObjectCtor, Symbol.hasInstance);
    if (!had) {
      Object.defineProperty(ObjectCtor, Symbol.hasInstance, { value: isObject, configurable: true });
    }
    try {
      return original.apply(this, args);
    } finally {
      if (!had) delete (ObjectCtor as unknown as Record<symbol, unknown>)[Symbol.hasInstance];
    }
  };
  (relaxed as { __ppRelaxed?: boolean }).__ppRelaxed = true;
  registry.define = relaxed;
  return true;
}
