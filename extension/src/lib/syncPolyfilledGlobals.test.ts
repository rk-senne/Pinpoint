import { describe, expect, it } from 'vitest';

import { relaxDefinePrototypeCheck, syncPolyfilledGlobals } from './syncPolyfilledGlobals';

describe('syncPolyfilledGlobals', () => {
  it('is a no-op when window is the global (Chrome isolated world)', () => {
    const g: Record<string, unknown> = { HTMLElement: 'native' };
    expect(syncPolyfilledGlobals(g, g)).toEqual([]);
    expect(g.HTMLElement).toBe('native');
  });

  it('copies polyfilled bindings onto a distinct sandbox global (Firefox)', () => {
    const polyfilled = function HTMLElement() {};
    const registry = {};
    const win: Record<string, unknown> = { HTMLElement: polyfilled, customElements: registry, CustomElementRegistry: class {} };
    const sandbox: Record<string, unknown> = { HTMLElement: 'native-ctor' };
    const copied = syncPolyfilledGlobals(win, sandbox);
    expect(copied.sort()).toEqual(['CustomElementRegistry', 'HTMLElement', 'customElements']);
    expect(sandbox.HTMLElement).toBe(polyfilled);
    expect(sandbox.customElements).toBe(registry);
  });

  it('skips keys that are missing or already identical, and tolerates frozen targets', () => {
    const same = {};
    const win: Record<string, unknown> = { HTMLElement: same, customElements: undefined };
    const sandbox: Record<string, unknown> = { HTMLElement: same };
    expect(syncPolyfilledGlobals(win, sandbox)).toEqual([]);
    const frozen = Object.freeze({ HTMLElement: 'x' }) as Record<string, unknown>;
    expect(() => syncPolyfilledGlobals({ HTMLElement: 'y' }, frozen)).not.toThrow();
  });
});

describe('relaxDefinePrototypeCheck', () => {
  /** A stand-in for the sandbox `Object` so the real global is never touched. */
  function fakeObjectCtor(): ObjectConstructor {
    return function FakeObject() {} as unknown as ObjectConstructor;
  }
  // A "cross-compartment" prototype: an object that does NOT inherit from FakeObject.prototype.
  const foreignProto = Object.create(null) as object;

  it('makes `instanceof Object` an is-object test only while define() runs', () => {
    const Obj = fakeObjectCtor();
    const seen: boolean[] = [];
    const registry = {
      define(_name: unknown, ctor: unknown) {
        // What the polyfill does: `constructor.prototype instanceof Object`.
        seen.push((ctor as { prototype: unknown }).prototype instanceof (Obj as unknown as typeof Object));
        return 'defined';
      },
    };
    expect(foreignProto instanceof (Obj as unknown as typeof Object)).toBe(false);
    expect(relaxDefinePrototypeCheck(registry, Obj)).toBe(true);
    expect(registry.define('x-a', { prototype: foreignProto })).toBe('defined');
    expect(seen).toEqual([true]);
    // Removed again afterwards.
    expect(Object.prototype.hasOwnProperty.call(Obj, Symbol.hasInstance)).toBe(false);
    expect(foreignProto instanceof (Obj as unknown as typeof Object)).toBe(false);
  });

  it('still rejects non-objects, propagates errors and cleans up', () => {
    const Obj = fakeObjectCtor();
    const registry = {
      define(_n: unknown, ctor: unknown) {
        if (!((ctor as { prototype: unknown }).prototype instanceof (Obj as unknown as typeof Object))) {
          throw new TypeError("The custom element constructor's prototype is not an object.");
        }
      },
    };
    relaxDefinePrototypeCheck(registry, Obj);
    expect(() => registry.define('x-b', { prototype: 42 })).toThrow(/not an object/);
    expect(Object.prototype.hasOwnProperty.call(Obj, Symbol.hasInstance)).toBe(false);
  });

  it('is idempotent and tolerates a missing registry', () => {
    const registry = { define: () => undefined };
    expect(relaxDefinePrototypeCheck(registry, fakeObjectCtor())).toBe(true);
    const once = registry.define;
    expect(relaxDefinePrototypeCheck(registry, fakeObjectCtor())).toBe(false);
    expect(registry.define).toBe(once);
    expect(relaxDefinePrototypeCheck(null)).toBe(false);
    expect(relaxDefinePrototypeCheck(undefined)).toBe(false);
  });
});
