import { describe, expect, it } from 'vitest';

import { shouldForceCustomElementsPolyfill } from './customElementsPolyfillPolicy';

describe('shouldForceCustomElementsPolyfill', () => {
  it('forces the polyfill on Firefox (desktop, Android, Nightly)', () => {
    expect(shouldForceCustomElementsPolyfill('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0')).toBe(true);
    expect(shouldForceCustomElementsPolyfill('Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0')).toBe(true);
  });
  it('leaves Chromium-family browsers alone', () => {
    expect(shouldForceCustomElementsPolyfill('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36')).toBe(false);
    expect(shouldForceCustomElementsPolyfill('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36 Edg/149.0')).toBe(false);
  });
  it('is false for missing / odd input', () => {
    expect(shouldForceCustomElementsPolyfill(undefined)).toBe(false);
    expect(shouldForceCustomElementsPolyfill('')).toBe(false);
    expect(shouldForceCustomElementsPolyfill('FirefoxLike')).toBe(false);
  });
});
