// @vitest-environment jsdom
/**
 * Unit tests for HoverOutline (task 28.1).
 *
 * Validates Requirements 37.1, 37.2:
 *   - A single absolutely-positioned `<div class="fl-hover-outline">` lives
 *     inside the Shadow Root.
 *   - On `pointermove`, throttled with `requestAnimationFrame`, the outline
 *     element's `transform` / `width` / `height` come from
 *     `document.elementFromPoint(...).getBoundingClientRect()`.
 *   - Multiple `pointermove` events between rAF ticks coalesce into a
 *     single update — never more than one rAF callback in flight at a time.
 *   - `pointer-events: none` on the outline so it never intercepts clicks.
 *   - Elements inside the overlay's own shadow tree are skipped (the
 *     outline is hidden rather than redrawn).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HoverOutline } from './HoverOutline';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a HoverOutline whose rAF can be flushed deterministically. Mirrors
 * the pattern used by PinPositioner.test.ts so we never depend on jsdom's
 * real animation-frame timing.
 */
function makeOutline() {
  let pending: FrameRequestCallback[] = [];
  let nextHandle = 1;

  const raf = vi.fn((cb: FrameRequestCallback) => {
    const handle = nextHandle++;
    pending.push(cb);
    return handle;
  });

  const caf = vi.fn(() => {
    pending = [];
  });

  const flush = () => {
    const cbs = pending;
    pending = [];
    for (const cb of cbs) cb(performance.now());
  };

  const outline = new HoverOutline({
    requestAnimationFrame: raf,
    cancelAnimationFrame: caf,
  });

  return { outline, raf, caf, flush };
}

/**
 * Replace `document.elementFromPoint` with a lookup that returns whichever
 * element has been registered for the given coordinates. We avoid relying
 * on jsdom's layout engine (which always returns `<body>` and may even
 * leave `elementFromPoint` undefined).
 */
function stubElementFromPoint(map: Map<string, Element | null>): () => void {
  const docAny = document as Document & {
    elementFromPoint?: (x: number, y: number) => Element | null;
  };
  const original = docAny.elementFromPoint;
  docAny.elementFromPoint = ((x: number, y: number) => {
    return map.get(`${x},${y}`) ?? null;
  }) as typeof document.elementFromPoint;
  return () => {
    if (original) {
      docAny.elementFromPoint = original;
    } else {
      delete (docAny as { elementFromPoint?: unknown }).elementFromPoint;
    }
  };
}

/**
 * Stamp a fixed bounding-client-rect onto an element so the outline reads
 * deterministic coordinates. jsdom always returns a zero-rect by default.
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

function pointerMoveAt(x: number, y: number): void {
  const event = new Event('pointermove', { bubbles: true });
  Object.assign(event, { clientX: x, clientY: y });
  document.dispatchEvent(event);
}

afterEach(() => {
  document.body.replaceChildren();
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('HoverOutline', () => {
  describe('shape', () => {
    it('owns a single `<div class="fl-hover-outline">` element', () => {
      const { outline } = makeOutline();
      expect(outline.element.tagName).toBe('DIV');
      expect(outline.element.className).toBe('fl-hover-outline');
    });

    it('uses pointer-events: none and position: fixed (Req 37.2)', () => {
      const { outline } = makeOutline();
      expect(outline.element.style.pointerEvents).toBe('none');
      expect(outline.element.style.position).toBe('fixed');
    });

    it('starts hidden until a pointermove resolves a target', () => {
      const { outline } = makeOutline();
      expect(outline.element.style.display).toBe('none');
    });

    it('attach() inserts the outline into the supplied parent', () => {
      const { outline } = makeOutline();
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      outline.attach(parent);
      expect(parent.contains(outline.element)).toBe(true);
    });

    it('attach() is idempotent — repeated calls do not stack outlines', () => {
      const { outline } = makeOutline();
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      outline.attach(parent);
      outline.attach(parent);

      expect(parent.querySelectorAll('.fl-hover-outline')).toHaveLength(1);
    });

    it('attach() throws after dispose()', () => {
      const { outline } = makeOutline();
      outline.dispose();
      expect(() => outline.attach(document.body)).toThrow();
    });
  });

  describe('rAF-throttled update from elementFromPoint (Req 37.1, 37.2)', () => {
    it('writes transform/width/height from the resolved element on the next rAF tick', () => {
      const { outline, flush } = makeOutline();
      const target = document.createElement('section');
      document.body.appendChild(target);
      setRect(target, { left: 100, top: 200, width: 300, height: 50 });

      const restore = stubElementFromPoint(new Map([['10,20', target]]));
      outline.attach(document.body);

      pointerMoveAt(10, 20);
      flush();

      expect(outline.element.style.display).toBe('block');
      expect(outline.element.style.transform).toBe('translate3d(100px, 200px, 0)');
      expect(outline.element.style.width).toBe('300px');
      expect(outline.element.style.height).toBe('50px');
      restore();
    });

    it('coalesces a burst of pointermove events into a single rAF tick', () => {
      const { outline, raf, flush } = makeOutline();
      const target = document.createElement('section');
      document.body.appendChild(target);
      setRect(target, { left: 1, top: 2, width: 3, height: 4 });

      const map = new Map<string, Element | null>([
        ['1,1', target],
        ['2,2', target],
        ['3,3', target],
      ]);
      const restore = stubElementFromPoint(map);
      outline.attach(document.body);

      raf.mockClear();
      pointerMoveAt(1, 1);
      pointerMoveAt(2, 2);
      pointerMoveAt(3, 3);
      expect(raf).toHaveBeenCalledTimes(1);

      flush();
      // Final tick uses the *latest* event's coords.
      expect(outline.element.style.transform).toBe('translate3d(1px, 2px, 0)');
      restore();
    });

    it('schedules a fresh rAF after the previous tick fired', () => {
      const { outline, raf, flush } = makeOutline();
      const a = document.createElement('section');
      const b = document.createElement('section');
      document.body.append(a, b);
      setRect(a, { left: 1, top: 1, width: 1, height: 1 });
      setRect(b, { left: 9, top: 9, width: 9, height: 9 });

      const restore = stubElementFromPoint(
        new Map<string, Element>([
          ['1,1', a],
          ['9,9', b],
        ]),
      );
      outline.attach(document.body);

      raf.mockClear();
      pointerMoveAt(1, 1);
      flush();
      expect(outline.element.style.transform).toBe('translate3d(1px, 1px, 0)');

      pointerMoveAt(9, 9);
      flush();
      expect(outline.element.style.transform).toBe('translate3d(9px, 9px, 0)');
      expect(raf).toHaveBeenCalledTimes(2);
      restore();
    });
  });

  describe('skip elements inside the overlay\'s own shadow tree (task 28.1)', () => {
    it('hides the outline when the resolved element is the overlay shadow host itself', () => {
      const { outline, flush } = makeOutline();
      const overlayHost = document.createElement('div');
      overlayHost.id = 'pinpoint-shadow-host';
      document.body.appendChild(overlayHost);
      setRect(overlayHost, { left: 0, top: 0, width: 0, height: 0 });

      const restore = stubElementFromPoint(new Map([['5,5', overlayHost]]));
      outline.attach(document.body, overlayHost);

      pointerMoveAt(5, 5);
      flush();

      expect(outline.element.style.display).toBe('none');
      restore();
    });

    it('hides the outline for descendants of the overlay shadow host', () => {
      const { outline, flush } = makeOutline();
      const overlayHost = document.createElement('div');
      const inner = document.createElement('span');
      overlayHost.appendChild(inner);
      document.body.appendChild(overlayHost);
      setRect(inner, { left: 0, top: 0, width: 10, height: 10 });

      const restore = stubElementFromPoint(new Map([['5,5', inner]]));
      outline.attach(document.body, overlayHost);

      pointerMoveAt(5, 5);
      flush();

      expect(outline.element.style.display).toBe('none');
      restore();
    });

    it('hides the outline for any element marked with [data-pinpoint]', () => {
      const { outline, flush } = makeOutline();
      const decoy = document.createElement('div');
      decoy.setAttribute('data-pinpoint', 'pin');
      document.body.appendChild(decoy);
      setRect(decoy, { left: 0, top: 0, width: 10, height: 10 });

      const restore = stubElementFromPoint(new Map([['5,5', decoy]]));
      outline.attach(document.body); // no overlay host supplied — fallback path

      pointerMoveAt(5, 5);
      flush();

      expect(outline.element.style.display).toBe('none');
      restore();
    });

    it('shows the outline for plain host-page elements unrelated to the overlay', () => {
      const { outline, flush } = makeOutline();
      const overlayHost = document.createElement('div');
      const target = document.createElement('article');
      document.body.append(overlayHost, target);
      setRect(target, { left: 7, top: 8, width: 9, height: 10 });

      const restore = stubElementFromPoint(new Map([['5,5', target]]));
      outline.attach(document.body, overlayHost);

      pointerMoveAt(5, 5);
      flush();

      expect(outline.element.style.display).toBe('block');
      expect(outline.element.style.transform).toBe('translate3d(7px, 8px, 0)');
      restore();
    });
  });

  describe('robustness', () => {
    it('hides the outline when elementFromPoint returns null', () => {
      const { outline, flush } = makeOutline();
      const target = document.createElement('div');
      document.body.appendChild(target);
      setRect(target, { left: 1, top: 1, width: 1, height: 1 });
      const restore = stubElementFromPoint(new Map([['5,5', target]]));
      outline.attach(document.body);

      pointerMoveAt(5, 5);
      flush();
      expect(outline.element.style.display).toBe('block');

      pointerMoveAt(99, 99); // not in the map → null
      flush();
      expect(outline.element.style.display).toBe('none');
      restore();
    });

    it('hides the outline when the resolved element has a zero-size rect', () => {
      const { outline, flush } = makeOutline();
      const target = document.createElement('div');
      document.body.appendChild(target);
      setRect(target, { left: 0, top: 0, width: 0, height: 0 });
      const restore = stubElementFromPoint(new Map([['5,5', target]]));
      outline.attach(document.body);

      pointerMoveAt(5, 5);
      flush();
      expect(outline.element.style.display).toBe('none');
      restore();
    });

    it('does not throw when elementFromPoint itself throws', () => {
      const { outline, flush } = makeOutline();
      const docAny = document as Document & {
        elementFromPoint?: (x: number, y: number) => Element | null;
      };
      const original = docAny.elementFromPoint;
      docAny.elementFromPoint = (() => {
        throw new Error('boom');
      }) as typeof document.elementFromPoint;
      outline.attach(document.body);

      expect(() => {
        pointerMoveAt(5, 5);
        flush();
      }).not.toThrow();
      expect(outline.element.style.display).toBe('none');
      if (original) {
        docAny.elementFromPoint = original;
      } else {
        delete (docAny as { elementFromPoint?: unknown }).elementFromPoint;
      }
    });
  });

  describe('hidden state (Req 37.3 hook for task 28.2)', () => {
    it('setHidden(true) hides the outline and drops pending updates', () => {
      const { outline, flush, raf } = makeOutline();
      const target = document.createElement('div');
      document.body.appendChild(target);
      setRect(target, { left: 7, top: 8, width: 9, height: 10 });
      const restore = stubElementFromPoint(new Map([['5,5', target]]));
      outline.attach(document.body);

      pointerMoveAt(5, 5);
      outline.setHidden(true);
      flush();

      expect(outline.element.style.display).toBe('none');

      // Subsequent pointermoves are ignored while hidden — no rAF is
      // scheduled and the display stays `none`.
      raf.mockClear();
      pointerMoveAt(5, 5);
      expect(raf).not.toHaveBeenCalled();
      expect(outline.element.style.display).toBe('none');

      restore();
    });

    it('setHidden(false) re-enables drawing on the next pointermove', () => {
      const { outline, flush } = makeOutline();
      const target = document.createElement('div');
      document.body.appendChild(target);
      setRect(target, { left: 1, top: 2, width: 3, height: 4 });
      const restore = stubElementFromPoint(new Map([['5,5', target]]));
      outline.attach(document.body);

      outline.setHidden(true);
      outline.setHidden(false);

      pointerMoveAt(5, 5);
      flush();

      expect(outline.element.style.display).toBe('block');
      restore();
    });
  });

  describe('lifecycle', () => {
    it('dispose() removes the outline element and stops listening', () => {
      const { outline, raf } = makeOutline();
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      outline.attach(parent);
      expect(parent.contains(outline.element)).toBe(true);

      outline.dispose();
      expect(parent.contains(outline.element)).toBe(false);

      raf.mockClear();
      pointerMoveAt(5, 5);
      expect(raf).not.toHaveBeenCalled();
    });

    it('dispose() is idempotent', () => {
      const { outline } = makeOutline();
      outline.attach(document.body);
      outline.dispose();
      expect(() => outline.dispose()).not.toThrow();
    });

    it('cancels a pending rAF on dispose', () => {
      const { outline, caf } = makeOutline();
      const target = document.createElement('div');
      document.body.appendChild(target);
      setRect(target, { left: 0, top: 0, width: 1, height: 1 });
      const restore = stubElementFromPoint(new Map([['5,5', target]]));
      outline.attach(document.body);

      pointerMoveAt(5, 5);
      expect(outline.rafScheduled).toBe(true);
      outline.dispose();
      expect(caf).toHaveBeenCalled();
      restore();
    });
  });
});
