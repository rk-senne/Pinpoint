// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { registerElement } from './registerElement';

describe('registerElement', () => {
  it('registers the canonical pp-* tag and the legacy fl-* alias for the same class', () => {
    class Probe extends HTMLElement {}
    registerElement('re-probe', Probe);
    expect(customElements.get('pp-re-probe')).toBe(Probe);
    expect(customElements.get('fl-re-probe')).toBeDefined();
  });

  it('is safe to call twice (no "already defined" throw)', () => {
    class Twice extends HTMLElement {}
    registerElement('re-twice', Twice);
    expect(() => registerElement('re-twice', Twice)).not.toThrow();
    expect(customElements.get('pp-re-twice')).toBe(Twice);
  });
});
