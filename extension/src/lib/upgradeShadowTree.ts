/**
 * Synchronously upgrade the Custom Elements inside a component's Shadow
 * Root before the component starts assigning properties to them.
 *
 * Why: in the content script's isolated world the registry comes from the
 * `@webcomponents/custom-elements` polyfill (see `isolatedWorldElements.ts`),
 * which upgrades elements stamped into a Shadow Root LATER than native
 * Custom Elements would. A parent that sets `child.target = …` in its
 * `connectedCallback` before the child upgraded creates an OWN property on
 * the still-plain element; once the class is applied that own property
 * shadows the prototype setter forever. In real Chrome this left the
 * overlay's popover, sidebar and toolbar permanently deaf: clicking a page
 * element never opened the popover, the sidebar never listed annotations.
 *
 * `upgradeShadowTree(root)` forces the upgrade and then "re-plays" any such
 * shadowing own properties through the real setters (the standard
 * `_upgradeProperty` pattern), so it is safe to call even after the fact.
 */
export function upgradeShadowTree(root: ShadowRoot | DocumentFragment | null | undefined): void {
  if (!root) return;
  try {
    if (typeof customElements !== 'undefined' && typeof customElements.upgrade === 'function') {
      customElements.upgrade(root);
    }
  } catch {
    /* best-effort — never break the component's connect path */
  }
  let elements: Element[];
  try {
    elements = Array.from(root.querySelectorAll('*'));
  } catch {
    return;
  }
  for (const el of elements) {
    if (!el.localName.includes('-')) continue;
    replayShadowingProperties(el);
  }
}

/** Re-assign own properties that hide a prototype accessor with a setter. */
export function replayShadowingProperties(el: Element): void {
  const record = el as unknown as Record<string, unknown>;
  for (const key of Object.keys(el)) {
    if (key.startsWith('__CE_')) continue; // polyfill bookkeeping
    if (!hasPrototypeSetter(el, key)) continue;
    const value = record[key];
    delete record[key];
    record[key] = value;
  }
}

function hasPrototypeSetter(el: Element, key: string): boolean {
  let proto: object | null = Object.getPrototypeOf(el);
  while (proto && proto !== HTMLElement.prototype) {
    const desc = Object.getOwnPropertyDescriptor(proto, key);
    if (desc) return typeof desc.set === 'function';
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}
