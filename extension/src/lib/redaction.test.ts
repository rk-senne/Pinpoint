// @vitest-environment jsdom
/**
 * Unit tests for `computeRedactionRects` (task 37.1, Req 45.1).
 *
 * Validates the four predicate branches and the `data-fl-no-redact`
 * opt-out:
 *
 *   - `<input type="password">` is included.
 *   - `data-fl-no-redact` (on the element OR an ancestor) suppresses
 *     the rect even when the element matches the predicate.
 *   - An element whose `aria-label` matches the supplied regex is
 *     included.
 *
 * Plus a couple of supporting checks for visibility filtering, dedupe,
 * the device-pixel-ratio scaling, and the wire-format serializer the
 * Popover passes to FormData.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type BoundingBox,
  computeRedactionRects,
  serializeRedactionRects,
} from './redaction';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Stamp a fixed bounding-client-rect onto an element so the redaction
 * scanner reads deterministic coordinates. jsdom returns a zero-rect by
 * default which would (correctly) be filtered as "not in layout".
 *
 * Mirrors the helper used by `HoverOutline.test.ts`.
 */
function setRect(
  element: Element,
  rect: { left: number; top: number; width: number; height: number },
): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () =>
      ({
        left: rect.left,
        top: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        width: rect.width,
        height: rect.height,
        x: rect.left,
        y: rect.top,
        toJSON() {
          return rect;
        },
      }) as DOMRect,
  });
}

/** Force `window.devicePixelRatio` to a known value for the test run. */
function setDevicePixelRatio(value: number): () => void {
  const original = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value,
  });
  return () => {
    if (original) {
      Object.defineProperty(window, 'devicePixelRatio', original);
    } else {
      // The default jsdom global stays writable; restoring to 1 keeps
      // sibling tests deterministic.
      Object.defineProperty(window, 'devicePixelRatio', {
        configurable: true,
        value: 1,
      });
    }
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* computeRedactionRects                                                      */
/* -------------------------------------------------------------------------- */

describe('computeRedactionRects', () => {
  it('returns a rect for an `<input type="password">` (Req 45.1)', () => {
    const restore = setDevicePixelRatio(1);
    try {
      const input = document.createElement('input');
      input.type = 'password';
      setRect(input, { left: 10, top: 20, width: 200, height: 32 });
      document.body.appendChild(input);

      const rects = computeRedactionRects();

      expect(rects).toHaveLength(1);
      expect(rects[0]).toEqual<BoundingBox>({
        x: 10,
        y: 20,
        w: 200,
        h: 32,
      });
    } finally {
      restore();
    }
  });

  it('returns a rect for an `<input autocomplete="cc-number">` (Req 45.1)', () => {
    const restore = setDevicePixelRatio(1);
    try {
      const input = document.createElement('input');
      input.setAttribute('autocomplete', 'cc-number');
      setRect(input, { left: 5, top: 5, width: 240, height: 40 });
      document.body.appendChild(input);

      const rects = computeRedactionRects();

      expect(rects).toHaveLength(1);
      expect(rects[0]).toEqual<BoundingBox>({ x: 5, y: 5, w: 240, h: 40 });
    } finally {
      restore();
    }
  });

  it('returns a rect for an element with `data-fl-redact` (Req 45.1)', () => {
    const restore = setDevicePixelRatio(1);
    try {
      const span = document.createElement('span');
      span.setAttribute('data-fl-redact', '');
      span.textContent = 'sensitive';
      setRect(span, { left: 0, top: 0, width: 50, height: 16 });
      document.body.appendChild(span);

      const rects = computeRedactionRects();

      expect(rects).toHaveLength(1);
      expect(rects[0]).toEqual<BoundingBox>({ x: 0, y: 0, w: 50, h: 16 });
    } finally {
      restore();
    }
  });

  it('returns no rect when `data-fl-no-redact` opts out a password input (Req 45.2)', () => {
    const restore = setDevicePixelRatio(1);
    try {
      const input = document.createElement('input');
      input.type = 'password';
      input.setAttribute('data-fl-no-redact', '');
      setRect(input, { left: 10, top: 20, width: 200, height: 32 });
      document.body.appendChild(input);

      const rects = computeRedactionRects();

      expect(rects).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('honours `data-fl-no-redact` on an ancestor (subtree opt-out)', () => {
    const restore = setDevicePixelRatio(1);
    try {
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-fl-no-redact', '');
      const input = document.createElement('input');
      input.type = 'password';
      setRect(input, { left: 0, top: 0, width: 100, height: 20 });
      wrapper.appendChild(input);
      document.body.appendChild(wrapper);

      const rects = computeRedactionRects();

      expect(rects).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('honours `data-fl-no-redact` on an ancestor of an aria-label match (Req 45.2)', () => {
    const restore = setDevicePixelRatio(1);
    try {
      const wrapper = document.createElement('section');
      wrapper.setAttribute('data-fl-no-redact', '');
      const div = document.createElement('div');
      div.setAttribute('aria-label', 'Credit card number');
      setRect(div, { left: 0, top: 0, width: 180, height: 24 });
      wrapper.appendChild(div);
      document.body.appendChild(wrapper);

      const rects = computeRedactionRects(document, {
        ariaLabelRegex: /credit\s*card/i,
      });

      expect(rects).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('honours `data-fl-no-redact` on an ancestor of a `cc-*` autocomplete input (Req 45.2)', () => {
    const restore = setDevicePixelRatio(1);
    try {
      const wrapper = document.createElement('form');
      wrapper.setAttribute('data-fl-no-redact', '');
      const input = document.createElement('input');
      input.setAttribute('autocomplete', 'cc-number');
      setRect(input, { left: 0, top: 0, width: 240, height: 40 });
      wrapper.appendChild(input);
      document.body.appendChild(wrapper);

      const rects = computeRedactionRects();

      expect(rects).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('does NOT propagate `data-fl-no-redact` upward — a descendant opt-out cannot cancel an ancestor rect (Req 45.2)', () => {
    // Sanity: the opt-out walks the element and its ancestors via
    // `closest()`, NOT its descendants. An outer element that itself
    // matches the predicate (here: `data-fl-redact`) must still emit a
    // rect even when an inner child carries `data-fl-no-redact`.
    const restore = setDevicePixelRatio(1);
    try {
      const outer = document.createElement('div');
      outer.setAttribute('data-fl-redact', '');
      setRect(outer, { left: 1, top: 2, width: 100, height: 20 });

      const inner = document.createElement('span');
      inner.setAttribute('data-fl-no-redact', '');
      inner.textContent = 'safe';
      outer.appendChild(inner);

      document.body.appendChild(outer);

      const rects = computeRedactionRects();

      expect(rects).toHaveLength(1);
      expect(rects[0]).toEqual<BoundingBox>({ x: 1, y: 2, w: 100, h: 20 });
    } finally {
      restore();
    }
  });

  it('returns a rect for `aria-label="Credit card number"` matching the supplied regex (Req 45.1)', () => {
    const restore = setDevicePixelRatio(1);
    try {
      const div = document.createElement('div');
      div.setAttribute('aria-label', 'Credit card number');
      setRect(div, { left: 30, top: 40, width: 180, height: 24 });
      document.body.appendChild(div);

      const rects = computeRedactionRects(document, {
        ariaLabelRegex: /credit\s*card/i,
      });

      expect(rects).toHaveLength(1);
      expect(rects[0]).toEqual<BoundingBox>({ x: 30, y: 40, w: 180, h: 24 });
    } finally {
      restore();
    }
  });

  it('does NOT match aria-labels when no regex is supplied', () => {
    const restore = setDevicePixelRatio(1);
    try {
      const div = document.createElement('div');
      div.setAttribute('aria-label', 'Credit card number');
      setRect(div, { left: 0, top: 0, width: 100, height: 20 });
      document.body.appendChild(div);

      const rects = computeRedactionRects();

      expect(rects).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('skips invisible elements (zero width or zero height)', () => {
    const restore = setDevicePixelRatio(1);
    try {
      const zeroWidth = document.createElement('input');
      zeroWidth.type = 'password';
      setRect(zeroWidth, { left: 0, top: 0, width: 0, height: 32 });
      document.body.appendChild(zeroWidth);

      const zeroHeight = document.createElement('input');
      zeroHeight.type = 'password';
      setRect(zeroHeight, { left: 0, top: 0, width: 100, height: 0 });
      document.body.appendChild(zeroHeight);

      const rects = computeRedactionRects();

      expect(rects).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('scales rects by `window.devicePixelRatio` and rounds to integers', () => {
    const restore = setDevicePixelRatio(2);
    try {
      const input = document.createElement('input');
      input.type = 'password';
      setRect(input, { left: 10.4, top: 20.6, width: 100.5, height: 32.2 });
      document.body.appendChild(input);

      const rects = computeRedactionRects();

      expect(rects).toHaveLength(1);
      // 10.4 * 2 = 20.8 → 21; 20.6 * 2 = 41.2 → 41
      // 100.5 * 2 = 201; 32.2 * 2 = 64.4 → 64
      expect(rects[0]).toEqual<BoundingBox>({ x: 21, y: 41, w: 201, h: 64 });
    } finally {
      restore();
    }
  });

  it('de-duplicates an element matched by multiple predicate branches', () => {
    const restore = setDevicePixelRatio(1);
    try {
      // Both the password-input branch AND the data-fl-redact branch
      // would match this single element. The result MUST contain a
      // single rect — the server should not blur the same pixels twice.
      const input = document.createElement('input');
      input.type = 'password';
      input.setAttribute('data-fl-redact', '');
      setRect(input, { left: 1, top: 2, width: 3, height: 4 });
      document.body.appendChild(input);

      const rects = computeRedactionRects();

      expect(rects).toHaveLength(1);
      expect(rects[0]).toEqual<BoundingBox>({ x: 1, y: 2, w: 3, h: 4 });
    } finally {
      restore();
    }
  });

  it('returns an empty array when no element matches the predicate (no-PII fast path)', () => {
    const restore = setDevicePixelRatio(1);
    try {
      const input = document.createElement('input');
      input.type = 'text';
      setRect(input, { left: 0, top: 0, width: 200, height: 32 });
      document.body.appendChild(input);

      const rects = computeRedactionRects(document, { ariaLabelRegex: /never/ });

      expect(rects).toEqual([]);
    } finally {
      restore();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* serializeRedactionRects                                                    */
/* -------------------------------------------------------------------------- */

describe('serializeRedactionRects', () => {
  it('renames `w`/`h` to `width`/`height` to match the server schema', () => {
    const rects: BoundingBox[] = [
      { x: 10, y: 20, w: 100, h: 30 },
      { x: 0, y: 0, w: 5, h: 5 },
    ];

    const json = serializeRedactionRects(rects);
    expect(JSON.parse(json)).toEqual([
      { x: 10, y: 20, width: 100, height: 30 },
      { x: 0, y: 0, width: 5, height: 5 },
    ]);
  });

  it('returns "[]" for an empty array (server no-blur fast path)', () => {
    expect(serializeRedactionRects([])).toBe('[]');
  });
});
