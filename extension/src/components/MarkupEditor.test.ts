// @vitest-environment jsdom
/**
 * Unit tests for `<fl-markup-editor>` (Requirement 35.1, task 26.1).
 *
 * Validates:
 *   - Custom Element subclass of HTMLElement with an open Shadow Root
 *   - Adopts the shared stylesheet (or appends a `<style>` fallback) so
 *     theme variables are in scope (design key decision #11)
 *   - Renders a `<canvas>` and a transparent `<svg>` overlay inside the
 *     Shadow Root, plus a toolbar with the four tools
 *   - Pointer drag in each tool produces the matching `MarkupShape` and
 *     dispatches a bubbling, composed `change` `CustomEvent` whose detail
 *     payload contains the updated `Markup_Document`
 *   - Setting the `markupDocument` property externally re-renders the SVG
 *     layer and does NOT echo a `change` event
 *   - `undo()` removes the most recent shape and dispatches `change`
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import './MarkupEditor';
import type {
  FlMarkupEditor,
  MarkupChangeDetail,
  MarkupDocument,
} from './MarkupEditor';
import type { BoundingBox } from '../lib/redaction';

beforeAll(() => {
  expect(customElements.get('fl-markup-editor')).toBeDefined();
});

function createEditor(): FlMarkupEditor {
  const el = document.createElement('fl-markup-editor') as FlMarkupEditor;
  document.body.appendChild(el);
  return el;
}

/**
 * Dispatch a `PointerEvent` (or fall back to a plain `Event` carrying the
 * coordinates jsdom understands). The editor's `pointerdown` handler reads
 * `clientX/clientY` first and falls back to the bare `offsetX/offsetY`
 * fields when `getBoundingClientRect()` returns a zero rect (which jsdom
 * does for elements that have not been laid out). Both paths are covered.
 */
function firePointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX: number; clientY: number; pointerId?: number },
): void {
  const pointerId = init.pointerId ?? 1;
  const evt = new PointerEvent(type, {
    bubbles: true,
    composed: true,
    cancelable: true,
    pointerId,
    clientX: init.clientX,
    clientY: init.clientY,
    button: 0,
    pointerType: 'mouse',
  });
  // jsdom's PointerEvent does not implement offsetX/offsetY natively. Patch
  // them on so the editor's zero-rect fallback path can read them when
  // tests run before layout.
  Object.defineProperty(evt, 'offsetX', { value: init.clientX });
  Object.defineProperty(evt, 'offsetY', { value: init.clientY });
  target.dispatchEvent(evt);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('<fl-markup-editor>', () => {
  it('is a Custom Element subclass of HTMLElement with an open Shadow Root', () => {
    const el = createEditor();
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el.shadowRoot).not.toBeNull();
    expect(el.shadowRoot?.mode).toBe('open');
  });

  it('renders a canvas + transparent svg overlay inside the Shadow Root', () => {
    const el = createEditor();
    const canvas = el.shadowRoot!.querySelector('canvas.fl-markup-canvas');
    const svg = el.shadowRoot!.querySelector('svg.fl-markup-svg');
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(svg).not.toBeNull();
    // The SVG layer must lay over the canvas (position: absolute) so
    // pointer events on the overlay don't pass through to the host page.
    expect(svg!.classList.contains('fl-markup-svg')).toBe(true);
  });

  it('exposes the five tools as toolbar buttons', () => {
    const el = createEditor();
    const tools = Array.from(
      el.shadowRoot!.querySelectorAll<HTMLButtonElement>(
        'button.fl-markup-tool-btn',
      ),
    ).map((b) => b.dataset.tool);
    expect(tools).toEqual(['rect', 'arrow', 'stroke', 'pixelate', 'blur']);
  });

  it('adopts the shared stylesheet (or falls back to a <style> element)', () => {
    const el = createEditor();
    const root = el.shadowRoot!;
    const hasAdopted =
      Array.isArray(root.adoptedStyleSheets) && root.adoptedStyleSheets.length > 0;
    const hasFallbackStyle = root.querySelector('style') !== null;
    expect(hasAdopted || hasFallbackStyle).toBe(true);
  });

  it('starts with an empty Markup_Document', () => {
    const el = createEditor();
    expect(el.markupDocument).toEqual({ version: 1, shapes: [] });
  });

  it('selecting a tool reflects to the data-tool host attribute', () => {
    const el = createEditor();
    el.tool = 'arrow';
    expect(el.tool).toBe('arrow');
    expect(el.dataset.tool).toBe('arrow');
    const arrowBtn = el.shadowRoot!.querySelector<HTMLButtonElement>(
      'button[data-tool="arrow"]',
    )!;
    expect(arrowBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('produces a rect shape and a change event when dragging in rect mode', () => {
    const el = createEditor();
    el.tool = 'rect';
    el.color = '#ff0000';
    el.strokeWidth = 4;

    const seen: MarkupChangeDetail[] = [];
    el.addEventListener('change', (e) => {
      seen.push((e as CustomEvent<MarkupChangeDetail>).detail);
    });

    const svg = el.shadowRoot!.querySelector('svg.fl-markup-svg')!;
    firePointer(svg, 'pointerdown', { clientX: 10, clientY: 20 });
    firePointer(svg, 'pointermove', { clientX: 50, clientY: 80 });
    firePointer(svg, 'pointerup', { clientX: 50, clientY: 80 });

    expect(el.markupDocument.shapes).toEqual([
      {
        type: 'rect',
        x: 10,
        y: 20,
        width: 40,
        height: 60,
        color: '#ff0000',
        strokeWidth: 4,
      },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0].markupDocument).toEqual(el.markupDocument);
  });

  it('produces an arrow shape with the correct endpoints in arrow mode', () => {
    const el = createEditor();
    el.tool = 'arrow';
    el.color = '#0000ff';
    el.strokeWidth = 2;

    const svg = el.shadowRoot!.querySelector('svg.fl-markup-svg')!;
    firePointer(svg, 'pointerdown', { clientX: 5, clientY: 5 });
    firePointer(svg, 'pointermove', { clientX: 100, clientY: 80 });
    firePointer(svg, 'pointerup', { clientX: 100, clientY: 80 });

    expect(el.markupDocument.shapes).toEqual([
      {
        type: 'arrow',
        x1: 5,
        y1: 5,
        x2: 100,
        y2: 80,
        color: '#0000ff',
        strokeWidth: 2,
      },
    ]);
  });

  it('captures a freehand stroke as a list of points', () => {
    const el = createEditor();
    el.tool = 'stroke';
    el.color = '#00aa00';
    el.strokeWidth = 3;

    const svg = el.shadowRoot!.querySelector('svg.fl-markup-svg')!;
    firePointer(svg, 'pointerdown', { clientX: 10, clientY: 10 });
    firePointer(svg, 'pointermove', { clientX: 12, clientY: 14 });
    firePointer(svg, 'pointermove', { clientX: 18, clientY: 22 });
    firePointer(svg, 'pointerup', { clientX: 18, clientY: 22 });

    const shape = el.markupDocument.shapes[0];
    expect(shape.type).toBe('stroke');
    if (shape.type === 'stroke') {
      expect(shape.points).toEqual([
        { x: 10, y: 10 },
        { x: 12, y: 14 },
        { x: 18, y: 22 },
      ]);
      expect(shape.color).toBe('#00aa00');
      expect(shape.strokeWidth).toBe(3);
    }
  });

  it('captures a pixelate region with the configured pixelSize', () => {
    const el = createEditor();
    el.tool = 'pixelate';
    el.pixelSize = 16;

    const svg = el.shadowRoot!.querySelector('svg.fl-markup-svg')!;
    firePointer(svg, 'pointerdown', { clientX: 100, clientY: 100 });
    firePointer(svg, 'pointermove', { clientX: 220, clientY: 160 });
    firePointer(svg, 'pointerup', { clientX: 220, clientY: 160 });

    expect(el.markupDocument.shapes).toEqual([
      {
        type: 'pixelate',
        x: 100,
        y: 100,
        width: 120,
        height: 60,
        pixelSize: 16,
      },
    ]);
  });

  it('change event is bubbling and composed so it crosses the Shadow Root', () => {
    const el = createEditor();
    el.tool = 'rect';

    let event: CustomEvent<MarkupChangeDetail> | null = null;
    document.body.addEventListener('change', (e) => {
      event = e as CustomEvent<MarkupChangeDetail>;
    });

    const svg = el.shadowRoot!.querySelector('svg.fl-markup-svg')!;
    firePointer(svg, 'pointerdown', { clientX: 0, clientY: 0 });
    firePointer(svg, 'pointermove', { clientX: 10, clientY: 10 });
    firePointer(svg, 'pointerup', { clientX: 10, clientY: 10 });

    expect(event).not.toBeNull();
    expect(event!.bubbles).toBe(true);
    expect(event!.composed).toBe(true);
    expect(event!.detail.markupDocument.shapes).toHaveLength(1);
  });

  it('renders SVG children matching the shape list', () => {
    const el = createEditor();
    const doc: MarkupDocument = {
      version: 1,
      shapes: [
        {
          type: 'rect',
          x: 1,
          y: 2,
          width: 3,
          height: 4,
          color: '#abcdef',
          strokeWidth: 2,
        },
        {
          type: 'arrow',
          x1: 0,
          y1: 0,
          x2: 5,
          y2: 5,
          color: '#000000',
          strokeWidth: 1,
        },
      ],
    };
    el.markupDocument = doc;

    const rect = el.shadowRoot!.querySelector('svg.fl-markup-svg rect[data-shape="rect"]');
    const arrow = el.shadowRoot!.querySelector('svg.fl-markup-svg line[data-shape="arrow"]');
    expect(rect).not.toBeNull();
    expect(rect!.getAttribute('x')).toBe('1');
    expect(rect!.getAttribute('width')).toBe('3');
    expect(rect!.getAttribute('stroke')).toBe('#abcdef');
    expect(arrow).not.toBeNull();
    expect(arrow!.getAttribute('marker-end')).toBe('url(#fl-markup-arrowhead)');
  });

  it('setting markupDocument externally does NOT dispatch a change event', () => {
    const el = createEditor();
    let count = 0;
    el.addEventListener('change', () => {
      count += 1;
    });

    el.markupDocument = {
      version: 1,
      shapes: [
        {
          type: 'rect',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          color: '#ff0000',
          strokeWidth: 1,
        },
      ],
    };
    expect(count).toBe(0);
  });

  it('drops malformed shapes from externally-assigned documents', () => {
    const el = createEditor();
    el.markupDocument = {
      version: 1,
      shapes: [
        // valid
        {
          type: 'rect',
          x: 0,
          y: 0,
          width: 5,
          height: 5,
          color: '#000',
          strokeWidth: 1,
        },
        // missing required fields — should be dropped
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'rect' } as any,
      ],
    };
    expect(el.markupDocument.shapes).toHaveLength(1);
  });

  it('undo() pops the last shape and dispatches a change event', () => {
    const el = createEditor();
    el.tool = 'rect';
    const svg = el.shadowRoot!.querySelector('svg.fl-markup-svg')!;
    firePointer(svg, 'pointerdown', { clientX: 0, clientY: 0 });
    firePointer(svg, 'pointermove', { clientX: 10, clientY: 10 });
    firePointer(svg, 'pointerup', { clientX: 10, clientY: 10 });
    firePointer(svg, 'pointerdown', { clientX: 20, clientY: 20 });
    firePointer(svg, 'pointermove', { clientX: 30, clientY: 30 });
    firePointer(svg, 'pointerup', { clientX: 30, clientY: 30 });

    expect(el.markupDocument.shapes).toHaveLength(2);

    let lastChange: MarkupChangeDetail | null = null;
    el.addEventListener('change', (e) => {
      lastChange = (e as CustomEvent<MarkupChangeDetail>).detail;
    });

    expect(el.undo()).toBe(true);
    expect(el.markupDocument.shapes).toHaveLength(1);
    expect(lastChange).not.toBeNull();
    expect(lastChange!.markupDocument.shapes).toHaveLength(1);
  });

  it('undo() returns false when there is nothing to undo', () => {
    const el = createEditor();
    expect(el.undo()).toBe(false);
  });

  it('clicking the toolbar undo button removes the most recent shape', () => {
    const el = createEditor();
    el.tool = 'rect';
    const svg = el.shadowRoot!.querySelector('svg.fl-markup-svg')!;
    firePointer(svg, 'pointerdown', { clientX: 0, clientY: 0 });
    firePointer(svg, 'pointermove', { clientX: 5, clientY: 5 });
    firePointer(svg, 'pointerup', { clientX: 5, clientY: 5 });
    expect(el.markupDocument.shapes).toHaveLength(1);

    const undoBtn = el.shadowRoot!.querySelector<HTMLButtonElement>(
      'button.fl-markup-undo-btn',
    )!;
    undoBtn.click();
    expect(el.markupDocument.shapes).toHaveLength(0);
  });

  it('a click without a drag does not produce a shape', () => {
    const el = createEditor();
    el.tool = 'rect';
    const svg = el.shadowRoot!.querySelector('svg.fl-markup-svg')!;
    firePointer(svg, 'pointerdown', { clientX: 50, clientY: 50 });
    firePointer(svg, 'pointerup', { clientX: 50, clientY: 50 });
    expect(el.markupDocument.shapes).toHaveLength(0);
  });

  it('setting imageUrl to a new value triggers an image load without throwing', () => {
    const el = createEditor();
    expect(() => {
      el.imageUrl = 'data:image/png;base64,AAAA';
    }).not.toThrow();
    expect(el.imageUrl).toBe('data:image/png;base64,AAAA');
    // Re-assigning the same URL is a no-op (early-return); reading reflects.
    el.imageUrl = 'data:image/png;base64,AAAA';
    expect(el.imageUrl).toBe('data:image/png;base64,AAAA');
  });

  // ------------------------------------------------------------------
  // Task 26.3 — undo via an operation stack (Requirement 35.3)
  // ------------------------------------------------------------------

  /** Helper: draw a rect by firing the three-step pointer dance. */
  function drawRect(
    el: FlMarkupEditor,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): void {
    el.tool = 'rect';
    const svg = el.shadowRoot!.querySelector('svg.fl-markup-svg')!;
    firePointer(svg, 'pointerdown', { clientX: x1, clientY: y1 });
    firePointer(svg, 'pointermove', { clientX: x2, clientY: y2 });
    firePointer(svg, 'pointerup', { clientX: x2, clientY: y2 });
  }

  it('undo() walks back through every drawn shape and is a no-op once empty', () => {
    const el = createEditor();
    drawRect(el, 0, 0, 10, 10);
    drawRect(el, 20, 20, 30, 30);
    drawRect(el, 40, 40, 50, 50);
    expect(el.markupDocument.shapes).toHaveLength(3);

    expect(el.undo()).toBe(true);
    expect(el.markupDocument.shapes).toHaveLength(2);
    expect(el.undo()).toBe(true);
    expect(el.markupDocument.shapes).toHaveLength(1);
    expect(el.undo()).toBe(true);
    expect(el.markupDocument.shapes).toHaveLength(0);

    // No-op once the stack is empty (Req 35.3 — Cmd+Z on an empty
    // editor must not throw or fire spurious change events).
    let extraChanges = 0;
    el.addEventListener('change', () => {
      extraChanges += 1;
    });
    expect(el.undo()).toBe(false);
    expect(el.markupDocument.shapes).toHaveLength(0);
    expect(extraChanges).toBe(0);
  });

  it('externally assigning markupDocument clears the undo history', () => {
    const el = createEditor();
    drawRect(el, 0, 0, 10, 10);
    drawRect(el, 20, 20, 30, 30);
    expect(el.markupDocument.shapes).toHaveLength(2);

    // Host-driven hydration. The user must not be able to undo back
    // through changes they didn't make (task 26.3 spec).
    el.markupDocument = {
      version: 1,
      shapes: [
        {
          type: 'rect',
          x: 1,
          y: 1,
          width: 9,
          height: 9,
          color: '#123456',
          strokeWidth: 2,
        },
      ],
    };
    expect(el.markupDocument.shapes).toHaveLength(1);

    expect(el.undo()).toBe(false);
    // Document is unchanged — undo() bailed because the stack is empty.
    expect(el.markupDocument.shapes).toHaveLength(1);
    expect(el.markupDocument.shapes[0]).toMatchObject({ x: 1, y: 1 });
  });

  it('Cmd+Z on the stage triggers undo', () => {
    const el = createEditor();
    drawRect(el, 0, 0, 10, 10);
    drawRect(el, 20, 20, 30, 30);
    expect(el.markupDocument.shapes).toHaveLength(2);

    const stage = el.shadowRoot!.querySelector('.fl-markup-stage')!;
    stage.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(el.markupDocument.shapes).toHaveLength(1);

    // Ctrl+Z works too (non-mac users).
    stage.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(el.markupDocument.shapes).toHaveLength(0);

    // Shift+Cmd+Z is reserved for redo (out of scope for 26.3) and
    // must NOT fire an undo.
    drawRect(el, 5, 5, 6, 6);
    stage.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(el.markupDocument.shapes).toHaveLength(1);
  });

  it('undo stack is capped at 50 entries (oldest dropped)', () => {
    const el = createEditor();
    // Draw 51 shapes. The first commit's snapshot is the empty doc;
    // once the 52nd commit fires, that initial snapshot is evicted, so
    // even with an extreme number of undo() calls we cannot get back
    // below the first surviving entry.
    for (let i = 0; i < 51; i++) {
      drawRect(el, i, 0, i + 1, 5);
    }
    expect(el.markupDocument.shapes).toHaveLength(51);

    let undid = 0;
    for (let i = 0; i < 60; i++) {
      if (el.undo()) undid += 1;
    }
    // At most 50 undos succeeded — the cap.
    expect(undid).toBe(50);
    // We can never get back to an empty document because the snapshot
    // representing the empty starting state was evicted.
    expect(el.markupDocument.shapes.length).toBeGreaterThanOrEqual(1);
    expect(el.markupDocument.shapes).toHaveLength(1);
  });

  // ------------------------------------------------------------------
  // Task 37.4 — privacy "Blur" tool, separate from artistic markup
  // (Requirement 45.3). Painting a blur rect produces a BoundingBox in
  // the `redactionRects` getter, multiple rects accumulate, and undo
  // walks back through them via the same Cmd+Z stack as markup shapes.
  // ------------------------------------------------------------------

  /** Helper: paint a blur rect by switching tool and firing a drag. */
  function drawBlur(
    el: FlMarkupEditor,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): void {
    el.tool = 'blur';
    const svg = el.shadowRoot!.querySelector('svg.fl-markup-svg')!;
    firePointer(svg, 'pointerdown', { clientX: x1, clientY: y1 });
    firePointer(svg, 'pointermove', { clientX: x2, clientY: y2 });
    firePointer(svg, 'pointerup', { clientX: x2, clientY: y2 });
  }

  it('exposes a "blur" tool button distinct from "pixelate"', () => {
    const el = createEditor();
    const blur = el.shadowRoot!.querySelector(
      'button.fl-markup-tool-btn[data-tool="blur"]',
    );
    const pixelate = el.shadowRoot!.querySelector(
      'button.fl-markup-tool-btn[data-tool="pixelate"]',
    );
    expect(blur).not.toBeNull();
    expect(pixelate).not.toBeNull();
    expect(blur).not.toBe(pixelate);
  });

  it('starts with an empty redactionRects list', () => {
    const el = createEditor();
    expect(el.redactionRects).toEqual([]);
  });

  it('painting a blur rect appends a BoundingBox to redactionRects (Req 45.3)', () => {
    const el = createEditor();
    drawBlur(el, 10, 20, 50, 80);

    // The blur rect uses the abbreviated `w`/`h` field names that
    // computeRedactionRects emits, so the upload pipeline can
    // concatenate the two arrays without translation.
    expect(el.redactionRects).toEqual([{ x: 10, y: 20, w: 40, h: 60 }]);

    // Critically, the blur rect must NOT show up in the artistic
    // markup document — that goes to S3 as a sibling JSON file and
    // re-renders on view, while redaction rects are server-side
    // Gaussian-blurred into the bitmap and discarded.
    expect(el.markupDocument.shapes).toEqual([]);
  });

  it('emits a change event whose detail.redactionRects mirrors the list', () => {
    const el = createEditor();
    const seen: MarkupChangeDetail[] = [];
    el.addEventListener('change', (e) => {
      seen.push((e as CustomEvent<MarkupChangeDetail>).detail);
    });
    drawBlur(el, 0, 0, 30, 30);
    expect(seen).toHaveLength(1);
    expect(seen[0].redactionRects).toEqual([{ x: 0, y: 0, w: 30, h: 30 }]);
    expect(seen[0].markupDocument.shapes).toEqual([]);
  });

  it('multiple blur rects accumulate in order', () => {
    const el = createEditor();
    drawBlur(el, 0, 0, 10, 10);
    drawBlur(el, 100, 100, 150, 200);
    drawBlur(el, 50, 50, 60, 60);

    expect(el.redactionRects).toEqual([
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 100, y: 100, w: 50, h: 100 },
      { x: 50, y: 50, w: 10, h: 10 },
    ]);
  });

  it('redactionRects getter returns a defensive copy', () => {
    const el = createEditor();
    drawBlur(el, 0, 0, 10, 10);
    const copy = el.redactionRects as BoundingBox[];
    // Mutating the returned array must not bleed back into the editor.
    copy.push({ x: 999, y: 999, w: 5, h: 5 });
    expect(el.redactionRects).toEqual([{ x: 0, y: 0, w: 10, h: 10 }]);
  });

  it('undo() walks back through blur rects via the same stack as shapes (task 26.3 + 37.4)', () => {
    const el = createEditor();
    drawBlur(el, 0, 0, 10, 10);
    drawBlur(el, 20, 20, 40, 50);
    expect(el.redactionRects).toHaveLength(2);

    expect(el.undo()).toBe(true);
    expect(el.redactionRects).toEqual([{ x: 0, y: 0, w: 10, h: 10 }]);

    expect(el.undo()).toBe(true);
    expect(el.redactionRects).toEqual([]);

    // Stack is empty → further undo() is a no-op.
    expect(el.undo()).toBe(false);
    expect(el.redactionRects).toEqual([]);
  });

  it('undo() over a mixed history of markup shapes and blur rects walks back in commit order', () => {
    const el = createEditor();
    drawRect(el, 0, 0, 10, 10);
    drawBlur(el, 20, 20, 30, 30);
    drawRect(el, 40, 40, 50, 50);

    expect(el.markupDocument.shapes).toHaveLength(2);
    expect(el.redactionRects).toHaveLength(1);

    // Undo the second rect — markup list shrinks, blur list unchanged.
    expect(el.undo()).toBe(true);
    expect(el.markupDocument.shapes).toHaveLength(1);
    expect(el.redactionRects).toHaveLength(1);

    // Undo the blur — blur list shrinks, markup list unchanged.
    expect(el.undo()).toBe(true);
    expect(el.markupDocument.shapes).toHaveLength(1);
    expect(el.redactionRects).toHaveLength(0);

    // Undo the first rect — markup list back to empty.
    expect(el.undo()).toBe(true);
    expect(el.markupDocument.shapes).toHaveLength(0);
    expect(el.redactionRects).toHaveLength(0);
  });

  it('renders a translucent SVG overlay (data-shape="blur") for each redaction rect', () => {
    const el = createEditor();
    drawBlur(el, 5, 6, 25, 36);
    drawBlur(el, 100, 110, 150, 160);

    const overlays = el.shadowRoot!.querySelectorAll(
      'svg.fl-markup-svg rect[data-shape="blur"]',
    );
    expect(overlays).toHaveLength(2);
    const first = overlays[0];
    expect(first.getAttribute('x')).toBe('5');
    expect(first.getAttribute('y')).toBe('6');
    expect(first.getAttribute('width')).toBe('20');
    expect(first.getAttribute('height')).toBe('30');
    // Distinct from artistic shapes — translucent dark fill.
    expect(first.getAttribute('fill')).toBe('rgba(0, 0, 0, 0.35)');
  });

  it('a click without a drag in blur mode does not create a redaction rect', () => {
    const el = createEditor();
    el.tool = 'blur';
    const svg = el.shadowRoot!.querySelector('svg.fl-markup-svg')!;
    firePointer(svg, 'pointerdown', { clientX: 50, clientY: 50 });
    firePointer(svg, 'pointerup', { clientX: 50, clientY: 50 });
    expect(el.redactionRects).toEqual([]);
  });

  it('Cmd+Z undoes a blur rect (Req 45.3 keyboard shortcut)', () => {
    const el = createEditor();
    drawBlur(el, 0, 0, 10, 10);
    drawBlur(el, 20, 20, 40, 40);
    expect(el.redactionRects).toHaveLength(2);

    const stage = el.shadowRoot!.querySelector('.fl-markup-stage')!;
    stage.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(el.redactionRects).toHaveLength(1);
  });
});
