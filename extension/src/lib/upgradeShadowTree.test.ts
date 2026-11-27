// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { replayShadowingProperties, upgradeShadowTree } from './upgradeShadowTree';

class PpUpgradeProbe extends HTMLElement {
  seen: unknown[] = [];
  #value: unknown = null;
  get value(): unknown {
    return this.#value;
  }
  set value(v: unknown) {
    this.#value = v;
    this.seen.push(v);
  }
}

describe('upgradeShadowTree', () => {
  it('re-plays an own property that shadows a prototype setter', () => {
    const el = document.createElement('pp-upgrade-probe-a');
    // Assigned while the element is still un-upgraded → own data property.
    (el as unknown as { value: unknown }).value = 'early';
    expect(Object.keys(el)).toContain('value');

    customElements.define('pp-upgrade-probe-a', class extends PpUpgradeProbe {});
    customElements.upgrade(el);
    // The own property still hides the setter after a plain upgrade…
    expect((el as PpUpgradeProbe).seen).toEqual([]);

    replayShadowingProperties(el);
    expect(Object.keys(el)).not.toContain('value');
    expect((el as PpUpgradeProbe).seen).toEqual(['early']);
    expect((el as PpUpgradeProbe).value).toBe('early');
  });

  it('upgrades elements inside a shadow root and fixes their shadowed properties', () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const child = document.createElement('pp-upgrade-probe-b');
    root.appendChild(child);
    (child as unknown as { value: unknown }).value = 42;
    customElements.define('pp-upgrade-probe-b', class extends PpUpgradeProbe {});

    upgradeShadowTree(root);
    expect((child as PpUpgradeProbe).value).toBe(42);
    expect((child as PpUpgradeProbe).seen).toEqual([42]);
  });

  it('leaves plain own properties without a setter untouched and tolerates null', () => {
    const el = document.createElement('pp-upgrade-probe-c');
    (el as unknown as { extra: number }).extra = 1;
    customElements.define('pp-upgrade-probe-c', class extends PpUpgradeProbe {});
    customElements.upgrade(el);
    replayShadowingProperties(el);
    expect((el as unknown as { extra: number }).extra).toBe(1);
    expect(() => upgradeShadowTree(null)).not.toThrow();
  });
});
