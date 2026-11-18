// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { adoptStyles } from './sharedStyleSheet';

describe('adoptStyles', () => {
  it('falls back to a <style> element when the adoptedStyleSheets setter throws (Firefox Xray wrapper)', () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    Object.defineProperty(root, 'adoptedStyleSheets', {
      configurable: true,
      get: () => [],
      set: () => {
        throw new Error('Accessing from Xray wrapper is not supported.');
      },
    });
    // Force the constructable-sheet branch even where jsdom lacks it.
    if (!('adoptedStyleSheets' in Document.prototype)) {
      Object.defineProperty(Document.prototype, 'adoptedStyleSheets', { configurable: true, value: [] });
    }
    expect(() => adoptStyles(root)).not.toThrow();
    const style = root.querySelector('style');
    expect(style).not.toBeNull();
    expect(style!.textContent!.length).toBeGreaterThan(0);
  });
});
