/**
 * `<fl-markup-editor>` — Web Component implementing the screenshot markup
 * editor used by the Extension popover when composing an annotation
 * (Requirement 35.1, task 26.1).
 *
 *   1. HTMLElement subclass with an open Shadow Root + `adoptStyles()` from
 *      the shared constructable stylesheet (design key decision #11, §35
 *      "CSP-Strict Resilience"). Falls back to a `<style>` element under
 *      jsdom when constructable stylesheets are unavailable.
 *   2. The Shadow Root hosts two stacked layers:
 *        - a `<canvas>` that paints the screenshot bitmap and any
 *          rasterized pixelate regions (`pixelate` is implemented as a
 *          box-average raster — average each `pixelSize × pixelSize` block
 *          of the source bitmap and paint the average back into the
 *          canvas). The canvas is the only place the `pixelate`
 *          primitive is materialised on-screen during editing because
 *          SVG has no equivalent shape.
 *        - a transparent `<svg>` overlay rendering the vector shapes
 *          (rectangles, arrows, freehand strokes). Pointer events are
 *          captured on the SVG so the host page below the popover never
 *          sees draw gestures.
 *   3. Five tools, exposed via the `tool` property + `data-tool` host
 *      attribute: `'rect' | 'arrow' | 'stroke' | 'pixelate' | 'blur'`. The
 *      first four produce `MarkupShape`s in the persisted Markup_Document
 *      JSON. The fifth — `'blur'` (Req 45.3, task 37.4) — paints
 *      privacy-redaction rectangles into a separate `redactionRects`
 *      list which the screenshot upload pipeline appends to whatever
 *      `computeRedactionRects()` returned automatically. Keeping the two
 *      lists separate means artistic markup never accidentally ends up
 *      in the server-side Gaussian-blur pass and vice versa. The matching
 *      toolbar buttons live inside the Shadow Root as well, so a host
 *      that simply mounts `<fl-markup-editor>` gets a fully usable editor
 *      without slotting any children.
 *   4. Properties:
 *        - `imageUrl`: string — the screenshot to mark up. When set the
 *          element loads the bitmap, sizes the canvas + svg viewport to
 *          the natural width/height of the image, and paints the
 *          starting frame.
 *        - `markupDocument`: `MarkupDocument` — the current vector overlay.
 *          Setting this replaces the stored shape list, repaints the
 *          canvas (so any rasterized pixelate regions reflect the new
 *          state), and re-renders the SVG layer. Reading it always
 *          returns the live document.
 *        - `color`: string (hex), `strokeWidth`: number, `pixelSize`: number
 *          control the next shape's appearance.
 *   5. Events:
 *        - `change` (`CustomEvent<{ markupDocument: MarkupDocument }>`,
 *          `bubbles: true`, `composed: true`) fires after every committed
 *          edit (a finished draw, an undo, or `markupDocument` being
 *          re-assigned externally is NOT echoed back — `change` only
 *          fires for user-initiated edits to avoid feedback loops with
 *          the host).
 *   6. Idempotent `customElements.define()` so HMR / repeated test imports
 *      do not throw "this name has already been used".
 *
 * Implements: Requirement 35.1.
 */
import { adoptStyles } from '../styles/sharedStyleSheet';
import { withBoundary } from '../lib/withBoundary';
import type { BoundingBox } from '../lib/redaction';
import type {
  MarkupColor,
  MarkupShape,
  MarkupDocument,
} from '@pinpoint/shared';

// Re-export the shared types so existing imports of these names from
// `<fl-markup-editor>` keep working without a second source of truth
// (`shared/src/types.ts` is canonical).
export type { MarkupColor, MarkupShape, MarkupDocument };

/** The five tools the editor supports. `blur` paints additional
 * privacy-redaction rectangles (Req 45.3, task 37.4) — distinct from
 * `pixelate`, which is artistic markup baked into the Markup_Document.
 * Blur rects are stored separately on the editor and surfaced via the
 * `redactionRects` getter so the screenshot upload pipeline can append
 * them to the server-side Gaussian-blur list.
 */
export type MarkupTool = 'rect' | 'arrow' | 'stroke' | 'pixelate' | 'blur';

/** Detail payload of the `change` `CustomEvent`. */
export interface MarkupChangeDetail {
  markupDocument: MarkupDocument;
  /**
   * User-painted privacy redaction rectangles (Req 45.3, task 37.4).
   * These accumulate independently from `markupDocument.shapes` and are
   * the same `BoundingBox` shape `computeRedactionRects()` emits, so the
   * screenshot upload pipeline can concatenate the two lists and ship a
   * single `redactionRects` field. Coordinates are editor-canvas pixels;
   * the host is responsible for scaling them to device-pixel space if
   * the bitmap was captured at a different DPR.
   */
  redactionRects: readonly BoundingBox[];
}

/** Returns a fresh, empty `Markup_Document`. */
export function emptyMarkupDocument(): MarkupDocument {
  return { version: 1, shapes: [] };
}

const DEFAULT_COLOR: MarkupColor = '#ef4444';
const DEFAULT_STROKE_WIDTH = 3;
const DEFAULT_PIXEL_SIZE = 12;
const SVG_NS = 'http://www.w3.org/2000/svg';
/**
 * Cap on the undo history depth (Req 35.3, task 26.3). The editor keeps
 * a snapshot of the previous `Markup_Document` every time the user
 * commits a shape; once the stack reaches this size the oldest snapshot
 * is dropped so a long drawing session cannot run away with memory.
 */
const UNDO_STACK_LIMIT = 50;

/**
 * Element-scoped CSS layered on top of the shared constructable
 * stylesheet. Owns layout for the canvas + svg sandwich and the small
 * tool/color toolbar; everything theme-related (severity palette, button
 * shapes) is inherited from the shared stylesheet.
 */
const MARKUP_EDITOR_CSS = `
:host {
  display: block;
  position: relative;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  color: #1a1a1a;
}
.fl-markup-toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.fl-markup-toolbar button.fl-markup-tool-btn {
  background: #f5f5f5;
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  color: #1a1a1a;
}
.fl-markup-toolbar button.fl-markup-tool-btn[aria-pressed="true"] {
  background: #1a1a1a;
  color: #fff;
  border-color: #1a1a1a;
}
.fl-markup-toolbar input.fl-markup-color {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}
.fl-markup-toolbar input.fl-markup-stroke-width {
  width: 56px;
  font-family: inherit;
  font-size: 12px;
  padding: 2px 4px;
  border: 1px solid #ddd;
  border-radius: 6px;
}
.fl-markup-stage {
  position: relative;
  display: inline-block;
  border: 1px solid #ddd;
  border-radius: 6px;
  overflow: hidden;
  background: #f5f5f5;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}
.fl-markup-stage canvas.fl-markup-canvas,
.fl-markup-stage svg.fl-markup-svg {
  display: block;
}
.fl-markup-stage svg.fl-markup-svg {
  position: absolute;
  inset: 0;
  background: transparent;
  cursor: crosshair;
}
.fl-markup-stage svg.fl-markup-svg[data-tool="pixelate"] {
  cursor: cell;
}
.fl-markup-stage svg.fl-markup-svg[data-tool="blur"] {
  cursor: cell;
}
`;

const TEMPLATE = (() => {
  const t = document.createElement('template');
  t.innerHTML = `
    <style>${MARKUP_EDITOR_CSS}</style>
    <div class="fl-markup-toolbar" part="toolbar" role="toolbar" aria-label="Markup tools">
      <button type="button" class="fl-markup-tool-btn" data-tool="rect"
        aria-pressed="false" title="Rectangle">▭ Rect</button>
      <button type="button" class="fl-markup-tool-btn" data-tool="arrow"
        aria-pressed="false" title="Arrow">↗ Arrow</button>
      <button type="button" class="fl-markup-tool-btn" data-tool="stroke"
        aria-pressed="false" title="Freehand">✎ Draw</button>
      <button type="button" class="fl-markup-tool-btn" data-tool="pixelate"
        aria-pressed="false" title="Pixelate">▦ Pixelate</button>
      <button type="button" class="fl-markup-tool-btn" data-tool="blur"
        aria-pressed="false" title="Blur (privacy)">⊘ Blur</button>
      <input type="color" class="fl-markup-color" aria-label="Stroke color" value="${DEFAULT_COLOR}" />
      <input type="number" class="fl-markup-stroke-width" aria-label="Stroke width"
        min="1" max="32" step="1" value="${DEFAULT_STROKE_WIDTH}" />
      <button type="button" class="fl-btn fl-btn-secondary fl-markup-undo-btn"
        data-action="undo" title="Undo last shape">Undo</button>
    </div>
    <div class="fl-markup-stage" part="stage">
      <canvas class="fl-markup-canvas" part="canvas"></canvas>
      <svg class="fl-markup-svg" part="svg" xmlns="${SVG_NS}">
        <defs>
          <marker
            id="fl-markup-arrowhead"
            viewBox="0 0 10 10"
            refX="8" refY="5"
            markerWidth="6" markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
          </marker>
        </defs>
      </svg>
    </div>
  `;
  return t;
})();

/**
 * Box-average pixelate ("rasterized box blur"): for every
 * `pixelSize × pixelSize` block inside `(x, y, width, height)` that lies
 * within the canvas, compute the mean RGBA of the source pixels in the
 * block and paint that single color back over the block. This mirrors the
 * server-side `sharp.blur(15)` per-rect fallback used during PII
 * redaction (design §Markup_Document Storage) but is computed entirely on
 * the client so the editor can preview pixelation immediately.
 */
function rasterizePixelateRegion(
  ctx: CanvasRenderingContext2D,
  region: { x: number; y: number; width: number; height: number; pixelSize: number },
): void {
  const canvas = ctx.canvas;
  const cw = canvas.width;
  const ch = canvas.height;
  if (cw === 0 || ch === 0) return;
  const pixelSize = Math.max(1, Math.floor(region.pixelSize));
  // Clamp the region into canvas bounds so we never sample outside the
  // bitmap. Width/height guarded against negative drag deltas by Math.abs
  // upstream — defensive clamp here keeps the helper standalone.
  const x = Math.max(0, Math.floor(region.x));
  const y = Math.max(0, Math.floor(region.y));
  const w = Math.max(0, Math.min(cw - x, Math.floor(region.width)));
  const h = Math.max(0, Math.min(ch - y, Math.floor(region.height)));
  if (w === 0 || h === 0) return;

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(x, y, w, h);
  } catch {
    // jsdom's CanvasRenderingContext2D throws on getImageData when no
    // bitmap has been painted. Treat this as a no-op so the editor still
    // records the shape; the server-side renderer will produce the
    // canonical pixelation on view (design §Markup_Document Storage).
    return;
  }
  const data = imageData.data;

  for (let by = 0; by < h; by += pixelSize) {
    for (let bx = 0; bx < w; bx += pixelSize) {
      const blockW = Math.min(pixelSize, w - bx);
      const blockH = Math.min(pixelSize, h - by);
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let yy = 0; yy < blockH; yy++) {
        for (let xx = 0; xx < blockW; xx++) {
          const idx = ((by + yy) * w + (bx + xx)) * 4;
          r += data[idx];
          g += data[idx + 1];
          b += data[idx + 2];
          a += data[idx + 3];
          count++;
        }
      }
      if (count === 0) continue;
      const ar = Math.round(r / count);
      const ag = Math.round(g / count);
      const ab = Math.round(b / count);
      const aa = Math.round(a / count);
      ctx.fillStyle = `rgba(${ar}, ${ag}, ${ab}, ${aa / 255})`;
      ctx.fillRect(x + bx, y + by, blockW, blockH);
    }
  }
}

export class FlMarkupEditor extends HTMLElement {
  static readonly tagName = 'fl-markup-editor';

  // --- Public-property backing fields ---
  #imageUrl: string | null = null;
  #markupDocument: MarkupDocument = emptyMarkupDocument();
  #tool: MarkupTool = 'rect';
  #color: MarkupColor = DEFAULT_COLOR;
  #strokeWidth = DEFAULT_STROKE_WIDTH;
  #pixelSize = DEFAULT_PIXEL_SIZE;
  /**
   * User-painted privacy redaction rectangles (Req 45.3, task 37.4).
   *
   * Stored separately from `#markupDocument.shapes` so the artistic
   * markup (which is persisted as the sibling Markup_Document JSON) and
   * the privacy redaction list (which is appended to
   * `computeRedactionRects()` output and shipped as `redactionRects`
   * on the screenshot upload) never bleed into each other. The two
   * lists share a coordinate system — editor-canvas pixels — but a
   * different lifetime: the markup persists across views, the
   * redaction rects only need to live until the upload completes.
   *
   * Use the public `redactionRects` getter to read them; pushes happen
   * via the `blur` tool's pointer-up path, which also snapshots to the
   * undo stack so an accidental drag can be undone (task 26.3).
   */
  #redactionRects: BoundingBox[] = [];

  // --- Internal drawing state ---
  #image: HTMLImageElement | null = null;
  #imageReady = false;
  #naturalWidth = 0;
  #naturalHeight = 0;
  /** True while a pointer drag is in progress. */
  #drawing = false;
  /** Pointer-down position in canvas coordinates. */
  #drawStart: { x: number; y: number } | null = null;
  /** Live point list for the in-progress freehand stroke. */
  #strokePoints: Array<{ x: number; y: number }> | null = null;
  /** SVG element representing the in-progress shape, removed on commit. */
  #previewEl: SVGElement | null = null;
  /** Pointer id captured for the current drag; released on commit. */
  #activePointerId: number | null = null;
  /**
   * Snapshot-based undo history (Req 35.3, task 26.3). Each entry is a
   * full pair of `{ markupDocument, redactionRects }` representing the
   * state *before* a user-driven commit. `undo()` pops the most recent
   * snapshot and restores it.
   *
   * We keep snapshots (rather than per-shape "append" operations) so a
   * single primitive — replace `#markupDocument` + `#redactionRects` — can
   * roll back any mutation we might add later (e.g. clear-all). Capped at
   * `UNDO_STACK_LIMIT` to bound memory; oldest entries are evicted.
   *
   * The pair includes both the markup document AND the redaction rect
   * list so a `blur` tool drag (Req 45.3, task 37.4) can be undone the
   * same way as a `rect`/`arrow`/`stroke`/`pixelate` shape — Cmd+Z
   * walks back through every committed edit regardless of which list
   * it landed in.
   *
   * Externally driven assignment (`markupDocument = …`) clears the
   * stack so the user cannot undo back through host-driven changes
   * they didn't make (e.g. hydration from saved JSON).
   */
  #undoStack: Array<{
    markupDocument: MarkupDocument;
    redactionRects: BoundingBox[];
  }> = [];

  // --- Shadow-tree references ---
  #toolbar!: HTMLElement;
  #toolButtons!: HTMLButtonElement[];
  #colorInput!: HTMLInputElement;
  #strokeWidthInput!: HTMLInputElement;
  #undoBtn!: HTMLButtonElement;
  #stage!: HTMLElement;
  #canvas!: HTMLCanvasElement;
  #svg!: SVGSVGElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    adoptStyles(root);
    root.appendChild(TEMPLATE.content.cloneNode(true));

    this.#toolbar = root.querySelector('.fl-markup-toolbar') as HTMLElement;
    this.#toolButtons = Array.from(
      root.querySelectorAll<HTMLButtonElement>('button.fl-markup-tool-btn'),
    );
    this.#colorInput = root.querySelector(
      'input.fl-markup-color',
    ) as HTMLInputElement;
    this.#strokeWidthInput = root.querySelector(
      'input.fl-markup-stroke-width',
    ) as HTMLInputElement;
    this.#undoBtn = root.querySelector(
      'button.fl-markup-undo-btn',
    ) as HTMLButtonElement;
    this.#stage = root.querySelector('.fl-markup-stage') as HTMLElement;
    this.#canvas = root.querySelector('canvas.fl-markup-canvas') as HTMLCanvasElement;
    this.#svg = root.querySelector('svg.fl-markup-svg') as SVGSVGElement;
  }

  connectedCallback(): void {
    if (!this.hasAttribute('data-pinpoint')) {
      this.setAttribute('data-pinpoint', 'markup-editor');
    }
    for (const btn of this.#toolButtons) {
      btn.addEventListener('click', this.#onToolButtonClick);
    }
    this.#colorInput.addEventListener('input', this.#onColorInput);
    this.#strokeWidthInput.addEventListener('input', this.#onStrokeWidthInput);
    this.#undoBtn.addEventListener('click', this.#onUndoClick);
    this.#svg.addEventListener('pointerdown', this.#onPointerDown);
    this.#svg.addEventListener('pointermove', this.#onPointerMove);
    this.#svg.addEventListener('pointerup', this.#onPointerUp);
    this.#svg.addEventListener('pointercancel', this.#onPointerUp);
    // `Cmd/Ctrl+Z` undo (Req 35.3, task 26.3). The listener lives on the
    // stage rather than the host so it only fires while the user is
    // focused on the editor, not on whatever else is in the popover.
    // `tabindex` makes the stage focusable so it can receive keydowns.
    if (!this.#stage.hasAttribute('tabindex')) {
      this.#stage.setAttribute('tabindex', '0');
    }
    this.#stage.addEventListener('keydown', this.#onKeyDown);

    this.#renderToolButtons();
    this.#colorInput.value = this.#color;
    this.#strokeWidthInput.value = String(this.#strokeWidth);
    this.#applyToolAttribute();
  }

  disconnectedCallback(): void {
    for (const btn of this.#toolButtons) {
      btn.removeEventListener('click', this.#onToolButtonClick);
    }
    this.#colorInput.removeEventListener('input', this.#onColorInput);
    this.#strokeWidthInput.removeEventListener('input', this.#onStrokeWidthInput);
    this.#undoBtn.removeEventListener('click', this.#onUndoClick);
    this.#svg.removeEventListener('pointerdown', this.#onPointerDown);
    this.#svg.removeEventListener('pointermove', this.#onPointerMove);
    this.#svg.removeEventListener('pointerup', this.#onPointerUp);
    this.#svg.removeEventListener('pointercancel', this.#onPointerUp);
    this.#stage.removeEventListener('keydown', this.#onKeyDown);
    this.#cancelInProgressShape();
  }

  // --- Public properties ---------------------------------------------------

  /** URL of the screenshot that the markup is layered on top of. */
  get imageUrl(): string | null {
    return this.#imageUrl;
  }

  set imageUrl(next: string | null | undefined) {
    const value = next ?? null;
    if (value === this.#imageUrl) return;
    this.#imageUrl = value;
    this.#cancelInProgressShape();
    this.#loadImage();
  }

  /**
   * The current `Markup_Document`. Reading returns the live JSON; setting
   * replaces the shape list, repaints the canvas, and re-renders the SVG
   * overlay. External assignment does NOT dispatch `change` so the host
   * can hydrate the editor without echoes.
   */
  get markupDocument(): MarkupDocument {
    return this.#markupDocument;
  }

  set markupDocument(next: MarkupDocument | null | undefined) {
    this.#markupDocument = normalizeMarkupDocument(next);
    // External assignment is host-driven (e.g. hydration from saved
    // JSON) so the user must not be able to undo back through changes
    // they didn't make (Req 35.3 / task 26.3).
    this.#undoStack = [];
    this.#cancelInProgressShape();
    this.#repaintCanvas();
    this.#renderSvgShapes();
  }

  /** Active drawing tool. Setting reflects to the `data-tool` host attribute. */
  get tool(): MarkupTool {
    return this.#tool;
  }

  set tool(next: MarkupTool | null | undefined) {
    const value = (next ?? 'rect') as MarkupTool;
    if (!isMarkupTool(value)) return;
    this.#tool = value;
    this.#renderToolButtons();
    this.#applyToolAttribute();
  }

  /** Stroke color (hex) used for the next shape. */
  get color(): MarkupColor {
    return this.#color;
  }

  set color(next: MarkupColor | null | undefined) {
    if (!next) return;
    this.#color = next;
    if (this.#colorInput.value !== next) this.#colorInput.value = next;
  }

  /** Stroke width (px) used for the next shape. */
  get strokeWidth(): number {
    return this.#strokeWidth;
  }

  set strokeWidth(next: number | null | undefined) {
    const value = typeof next === 'number' && Number.isFinite(next) ? next : NaN;
    if (Number.isNaN(value) || value <= 0) return;
    this.#strokeWidth = value;
    if (this.#strokeWidthInput.value !== String(value)) {
      this.#strokeWidthInput.value = String(value);
    }
  }

  /** Block size (px) used for the next pixelate region. */
  get pixelSize(): number {
    return this.#pixelSize;
  }

  set pixelSize(next: number | null | undefined) {
    const value = typeof next === 'number' && Number.isFinite(next) ? next : NaN;
    if (Number.isNaN(value) || value <= 0) return;
    this.#pixelSize = Math.floor(value);
  }

  /**
   * The list of user-painted privacy redaction rectangles (Req 45.3,
   * task 37.4). Coordinates are in editor-canvas pixels using the same
   * `BoundingBox` shape `computeRedactionRects()` emits, so the
   * screenshot upload pipeline can concatenate the two arrays before
   * passing them to `serializeRedactionRects()`.
   *
   * Reading returns a defensive copy so a caller iterating the list
   * while the user keeps drawing cannot accidentally mutate the
   * editor's internal state. The list is empty by default and persists
   * across `markupDocument` assignments — the markup document and the
   * redaction list have independent lifecycles (one is artistic markup
   * baked into the persisted Markup_Document JSON, the other is a
   * privacy hint that only needs to live until the upload completes).
   */
  get redactionRects(): readonly BoundingBox[] {
    return this.#redactionRects.slice();
  }

  /**
   * Undo the most recent committed edit (Req 35.3, task 26.3). Pops a
   * snapshot off the internal undo stack and restores it as the new
   * `markupDocument`, then dispatches a `change` event so hosts can
   * react. Returns `true` when something was undone, `false` when the
   * stack is empty (e.g. the user keeps hitting Cmd+Z after the
   * editor is empty — no-op rather than throw).
   *
   * Public so a host (e.g. the popover or a keyboard shortcut) can
   * wire its own undo affordance without going through the toolbar
   * button.
   */
  undo(): boolean {
    const previous = this.#undoStack.pop();
    if (!previous) return false;
    this.#markupDocument = previous.markupDocument;
    this.#redactionRects = previous.redactionRects;
    this.#repaintCanvas();
    this.#renderSvgShapes();
    this.#renderRedactionRects();
    this.#dispatchChange();
    return true;
  }

  /**
   * Render the editor's current state to a single PNG blob — the canvas
   * (bitmap + rasterized pixelate regions) with the SVG vector overlay
   * baked in. Used by `save()` and exposed for hosts that want to
   * preview the rendered output without uploading.
   *
   * Implementation note: we serialise the SVG layer with
   * `XMLSerializer`, draw it on top of a copy of the source canvas via
   * an `Image` whose `src` is a `data:image/svg+xml` URL, then read the
   * resulting bitmap back as a PNG blob. This keeps the renderer in the
   * browser (no server-side compositing) and matches the canonical SVG
   * the viewer paints when reading the persisted Markup_Document.
   */
  async toPngBlob(): Promise<Blob | null> {
    const width = this.#canvas.width;
    const height = this.#canvas.height;
    if (width === 0 || height === 0) return null;

    // Stage canvas: copy of the source bitmap + rasterized pixelate.
    const composite = document.createElement('canvas');
    composite.width = width;
    composite.height = height;
    const ctx = composite.getContext('2d');
    if (!ctx) return null;

    try {
      ctx.drawImage(this.#canvas, 0, 0);
    } catch {
      // Treat any draw failure (jsdom, security exceptions) as "blank
      // composite" rather than throwing so the caller can still ship the
      // markup JSON without a bitmap.
    }

    // Bake the SVG overlay on top.
    if (typeof XMLSerializer !== 'undefined') {
      try {
        const svgClone = this.#svg.cloneNode(true) as SVGSVGElement;
        svgClone.setAttribute('xmlns', SVG_NS);
        svgClone.setAttribute('width', String(width));
        svgClone.setAttribute('height', String(height));
        const xml = new XMLSerializer().serializeToString(svgClone);
        const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
        const svgUrl = URL.createObjectURL(svgBlob);
        try {
          await new Promise<void>((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              try {
                ctx.drawImage(img, 0, 0, width, height);
                resolve();
              } catch (err) {
                reject(err);
              }
            };
            img.onerror = () => reject(new Error('Failed to rasterise markup SVG'));
            img.src = svgUrl;
          });
        } finally {
          URL.revokeObjectURL(svgUrl);
        }
      } catch {
        // SVG bake failed (e.g. jsdom without canvas SVG support). The
        // canvas still has the bitmap + raster pixelate, which is the
        // most important content; the viewer-side renderer can recompose
        // the vector layer from the persisted Markup_Document.
      }
    }

    return await new Promise<Blob | null>((resolve) => {
      if (typeof composite.toBlob === 'function') {
        composite.toBlob((blob) => resolve(blob), 'image/png');
      } else {
        // jsdom / older runtimes lack `toBlob`. Fall back to `toDataURL`
        // and decode manually.
        try {
          const dataUrl = composite.toDataURL('image/png');
          const base64 = dataUrl.split(',')[1] ?? '';
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          resolve(new Blob([bytes], { type: 'image/png' }));
        } catch {
          resolve(null);
        }
      }
    });
  }

  /**
   * Persist the rendered PNG and the underlying Markup_Document JSON to
   * the server's screenshot endpoint (Req 35.2 / Task 26.2). The two are
   * uploaded in a single multipart request so they land on sibling S3
   * objects (`<key>.png` + `<key>.markup.json`) atomically from the
   * client's perspective.
   *
   * The host supplies the upload function so this component does not
   * need to know about auth flows (extension uses bearer tokens,
   * dashboard uses cookies + CSRF). The function receives the multipart
   * `FormData` and returns whatever the server's response shape is.
   */
  async save(uploader: (form: FormData) => Promise<unknown>): Promise<unknown> {
    const blob = await this.toPngBlob();
    const form = new FormData();
    if (blob) {
      form.append('image', blob, 'screenshot.png');
    }
    form.append('markupDocument', JSON.stringify(this.#markupDocument));
    return uploader(form);
  }

  // --- Image loading -------------------------------------------------------

  #loadImage(): void {
    this.#imageReady = false;
    if (!this.#imageUrl) {
      this.#image = null;
      this.#naturalWidth = 0;
      this.#naturalHeight = 0;
      this.#sizeStage(0, 0);
      this.#repaintCanvas();
      this.#renderSvgShapes();
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    img.addEventListener('load', () => {
      // Guard against late loads after `imageUrl` was changed again.
      if (img.src !== this.#image?.src && this.#image !== img) return;
      this.#imageReady = true;
      this.#naturalWidth = img.naturalWidth || img.width;
      this.#naturalHeight = img.naturalHeight || img.height;
      this.#sizeStage(this.#naturalWidth, this.#naturalHeight);
      this.#repaintCanvas();
      this.#renderSvgShapes();
    });
    img.addEventListener('error', () => {
      // Drop the broken bitmap; keep the SVG layer usable so users can
      // still see / undo their existing shapes.
      this.#imageReady = false;
    });
    this.#image = img;
    img.src = this.#imageUrl;
  }

  #sizeStage(width: number, height: number): void {
    this.#canvas.width = width;
    this.#canvas.height = height;
    this.#canvas.style.width = `${width}px`;
    this.#canvas.style.height = `${height}px`;
    this.#svg.setAttribute('width', String(width));
    this.#svg.setAttribute('height', String(height));
    this.#svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.#stage.style.width = `${width}px`;
    this.#stage.style.height = `${height}px`;
  }

  // --- Canvas painting -----------------------------------------------------

  #repaintCanvas(): void {
    const ctx = this.#canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    if (this.#imageReady && this.#image) {
      try {
        ctx.drawImage(this.#image, 0, 0);
      } catch {
        // Some test runners (jsdom) throw when drawing a never-painted
        // image; ignore so we still raster pixelate regions and leave
        // the SVG layer intact.
      }
    }
    for (const shape of this.#markupDocument.shapes) {
      if (shape.type === 'pixelate') {
        rasterizePixelateRegion(ctx, shape);
      }
    }
  }

  // --- SVG layer rendering -------------------------------------------------

  #renderSvgShapes(): void {
    // Remove every previously-rendered shape. We intentionally keep the
    // `<defs>` (arrowhead marker) and any in-progress preview node.
    for (const child of Array.from(this.#svg.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'defs') continue;
      if (child === this.#previewEl) continue;
      this.#svg.removeChild(child);
    }
    for (const shape of this.#markupDocument.shapes) {
      const el = this.#shapeToSvgElement(shape);
      if (el) this.#svg.appendChild(el);
    }
    // Privacy redaction rectangles (Req 45.3, task 37.4) live in their
    // own SVG layer atop the markup shapes. They render as a translucent
    // dark overlay so the user can see at a glance which regions will be
    // server-side Gaussian-blurred — distinct from the lighter
    // `pixelate` outline (which is artistic markup baked into the
    // Markup_Document).
    for (const rect of this.#redactionRects) {
      const el = this.#redactionRectToSvgElement(rect);
      this.#svg.appendChild(el);
    }
  }

  /**
   * Re-render only the privacy redaction overlay (Req 45.3, task 37.4).
   * Used after the user commits a `blur` rect so we do not have to
   * re-walk the (potentially long) markup shape list. Calls the full
   * `#renderSvgShapes()` so the layer ordering stays correct (markup
   * underneath, redaction overlay on top).
   */
  #renderRedactionRects(): void {
    this.#renderSvgShapes();
  }

  /**
   * Build the SVG node for a privacy redaction rectangle. The element
   * carries `data-shape="blur"` so tests and DOM-based hosts can filter
   * it apart from artistic markup shapes.
   */
  #redactionRectToSvgElement(rect: BoundingBox): SVGElement {
    const el = document.createElementNS(SVG_NS, 'rect');
    el.setAttribute('x', String(rect.x));
    el.setAttribute('y', String(rect.y));
    el.setAttribute('width', String(rect.w));
    el.setAttribute('height', String(rect.h));
    el.setAttribute('fill', 'rgba(0, 0, 0, 0.35)');
    el.setAttribute('stroke', '#1a1a1a');
    el.setAttribute('stroke-dasharray', '4 2');
    el.setAttribute('stroke-width', '1');
    el.setAttribute('data-shape', 'blur');
    return el;
  }

  #shapeToSvgElement(shape: MarkupShape): SVGElement | null {
    if (shape.type === 'rect') {
      const el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', String(shape.x));
      el.setAttribute('y', String(shape.y));
      el.setAttribute('width', String(shape.width));
      el.setAttribute('height', String(shape.height));
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', shape.color);
      el.setAttribute('stroke-width', String(shape.strokeWidth));
      el.setAttribute('data-shape', 'rect');
      return el;
    }
    if (shape.type === 'arrow') {
      const el = document.createElementNS(SVG_NS, 'line');
      el.setAttribute('x1', String(shape.x1));
      el.setAttribute('y1', String(shape.y1));
      el.setAttribute('x2', String(shape.x2));
      el.setAttribute('y2', String(shape.y2));
      el.setAttribute('stroke', shape.color);
      el.setAttribute('stroke-width', String(shape.strokeWidth));
      el.setAttribute('marker-end', 'url(#fl-markup-arrowhead)');
      el.setAttribute('data-shape', 'arrow');
      return el;
    }
    if (shape.type === 'stroke') {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', pointsToPathD(shape.points));
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', shape.color);
      el.setAttribute('stroke-width', String(shape.strokeWidth));
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-linejoin', 'round');
      el.setAttribute('data-shape', 'stroke');
      return el;
    }
    // For pixelate the SVG layer renders a translucent outline so the user
    // can see where the rasterized pixelation lives on the canvas. The
    // canvas itself owns the actual pixelation paint.
    if (shape.type === 'pixelate') {
      const el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', String(shape.x));
      el.setAttribute('y', String(shape.y));
      el.setAttribute('width', String(shape.width));
      el.setAttribute('height', String(shape.height));
      el.setAttribute('fill', 'rgba(0, 0, 0, 0.05)');
      el.setAttribute('stroke', '#1a1a1a');
      el.setAttribute('stroke-dasharray', '4 2');
      el.setAttribute('stroke-width', '1');
      el.setAttribute('data-shape', 'pixelate');
      return el;
    }
    return null;
  }

  // --- Toolbar handlers ----------------------------------------------------

  #onToolButtonClick = (e: MouseEvent): void => {
    const btn = e.currentTarget as HTMLButtonElement;
    const value = btn.dataset.tool as MarkupTool | undefined;
    if (!value || !isMarkupTool(value)) return;
    this.tool = value;
  };

  #onColorInput = (): void => {
    this.#color = this.#colorInput.value || DEFAULT_COLOR;
  };

  #onStrokeWidthInput = (): void => {
    const parsed = Number(this.#strokeWidthInput.value);
    if (Number.isFinite(parsed) && parsed > 0) {
      this.#strokeWidth = parsed;
    }
  };

  #onUndoClick = (): void => {
    this.undo();
  };

  /**
   * Cmd/Ctrl+Z keyboard shortcut for undo (Req 35.3, task 26.3).
   * Shift+Cmd+Z is intentionally ignored — that conventionally maps to
   * "redo", which is out of scope for 26.3.
   */
  #onKeyDown = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.undo();
    }
  };

  #renderToolButtons(): void {
    for (const btn of this.#toolButtons) {
      const value = btn.dataset.tool as MarkupTool | undefined;
      const active = value === this.#tool;
      btn.setAttribute('aria-pressed', String(active));
      btn.classList.toggle('active', active);
    }
  }

  #applyToolAttribute(): void {
    this.dataset.tool = this.#tool;
    this.#svg.dataset.tool = this.#tool;
  }

  // --- Pointer-driven drawing ---------------------------------------------

  #onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const point = this.#eventToCanvasPoint(e);
    if (!point) return;
    this.#drawing = true;
    this.#drawStart = point;
    this.#activePointerId = e.pointerId;
    try {
      this.#svg.setPointerCapture(e.pointerId);
    } catch {
      /* setPointerCapture not supported in some test runners */
    }
    e.preventDefault();

    if (this.#tool === 'rect' || this.#tool === 'pixelate' || this.#tool === 'blur') {
      const el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', String(point.x));
      el.setAttribute('y', String(point.y));
      el.setAttribute('width', '0');
      el.setAttribute('height', '0');
      // Preview fill/stroke per tool. The blur tool gets a translucent
      // dark overlay so users can see at a glance which area will be
      // server-side Gaussian-blurred (Req 45.3, task 37.4) — distinct
      // from `pixelate` which paints a much fainter outline because
      // the canvas itself shows the rasterized pixelation.
      let fill: string;
      if (this.#tool === 'pixelate') fill = 'rgba(0,0,0,0.1)';
      else if (this.#tool === 'blur') fill = 'rgba(0,0,0,0.35)';
      else fill = 'none';
      el.setAttribute('fill', fill);
      let stroke: string;
      if (this.#tool === 'pixelate') stroke = '#1a1a1a';
      else if (this.#tool === 'blur') stroke = '#1a1a1a';
      else stroke = this.#color;
      el.setAttribute('stroke', stroke);
      el.setAttribute(
        'stroke-width',
        String(
          this.#tool === 'pixelate' || this.#tool === 'blur'
            ? 1
            : this.#strokeWidth,
        ),
      );
      if (this.#tool === 'pixelate' || this.#tool === 'blur') {
        el.setAttribute('stroke-dasharray', '4 2');
      }
      el.setAttribute('data-preview', this.#tool);
      this.#svg.appendChild(el);
      this.#previewEl = el;
    } else if (this.#tool === 'arrow') {
      const el = document.createElementNS(SVG_NS, 'line');
      el.setAttribute('x1', String(point.x));
      el.setAttribute('y1', String(point.y));
      el.setAttribute('x2', String(point.x));
      el.setAttribute('y2', String(point.y));
      el.setAttribute('stroke', this.#color);
      el.setAttribute('stroke-width', String(this.#strokeWidth));
      el.setAttribute('marker-end', 'url(#fl-markup-arrowhead)');
      el.setAttribute('data-preview', 'arrow');
      this.#svg.appendChild(el);
      this.#previewEl = el;
    } else if (this.#tool === 'stroke') {
      this.#strokePoints = [point];
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', pointsToPathD(this.#strokePoints));
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', this.#color);
      el.setAttribute('stroke-width', String(this.#strokeWidth));
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-linejoin', 'round');
      el.setAttribute('data-preview', 'stroke');
      this.#svg.appendChild(el);
      this.#previewEl = el;
    }
  };

  #onPointerMove = (e: PointerEvent): void => {
    if (!this.#drawing || !this.#drawStart || !this.#previewEl) return;
    if (
      this.#activePointerId !== null &&
      e.pointerId !== this.#activePointerId
    ) {
      return;
    }
    const point = this.#eventToCanvasPoint(e);
    if (!point) return;
    if (this.#tool === 'rect' || this.#tool === 'pixelate' || this.#tool === 'blur') {
      const x = Math.min(this.#drawStart.x, point.x);
      const y = Math.min(this.#drawStart.y, point.y);
      const width = Math.abs(point.x - this.#drawStart.x);
      const height = Math.abs(point.y - this.#drawStart.y);
      this.#previewEl.setAttribute('x', String(x));
      this.#previewEl.setAttribute('y', String(y));
      this.#previewEl.setAttribute('width', String(width));
      this.#previewEl.setAttribute('height', String(height));
    } else if (this.#tool === 'arrow') {
      this.#previewEl.setAttribute('x2', String(point.x));
      this.#previewEl.setAttribute('y2', String(point.y));
    } else if (this.#tool === 'stroke' && this.#strokePoints) {
      this.#strokePoints.push(point);
      this.#previewEl.setAttribute('d', pointsToPathD(this.#strokePoints));
    }
  };

  #onPointerUp = (e: PointerEvent): void => {
    if (!this.#drawing || !this.#drawStart) {
      this.#cancelInProgressShape();
      return;
    }
    if (
      this.#activePointerId !== null &&
      e.pointerId !== this.#activePointerId
    ) {
      return;
    }
    const point = this.#eventToCanvasPoint(e) ?? this.#drawStart;
    let shape: MarkupShape | null = null;
    /**
     * Set when the committed gesture is a privacy-redaction rect
     * (Req 45.3, task 37.4). The blur tool does NOT produce a
     * `MarkupShape` — those are baked into the persisted
     * Markup_Document — so we route the gesture into a separate field
     * which the upload pipeline appends to `computeRedactionRects()`.
     */
    let blurRect: BoundingBox | null = null;
    if (this.#tool === 'rect') {
      const x = Math.min(this.#drawStart.x, point.x);
      const y = Math.min(this.#drawStart.y, point.y);
      const width = Math.abs(point.x - this.#drawStart.x);
      const height = Math.abs(point.y - this.#drawStart.y);
      if (width > 0 && height > 0) {
        shape = {
          type: 'rect',
          x,
          y,
          width,
          height,
          color: this.#color,
          strokeWidth: this.#strokeWidth,
        };
      }
    } else if (this.#tool === 'pixelate') {
      const x = Math.min(this.#drawStart.x, point.x);
      const y = Math.min(this.#drawStart.y, point.y);
      const width = Math.abs(point.x - this.#drawStart.x);
      const height = Math.abs(point.y - this.#drawStart.y);
      if (width > 0 && height > 0) {
        shape = {
          type: 'pixelate',
          x,
          y,
          width,
          height,
          pixelSize: this.#pixelSize,
        };
      }
    } else if (this.#tool === 'blur') {
      const x = Math.min(this.#drawStart.x, point.x);
      const y = Math.min(this.#drawStart.y, point.y);
      const width = Math.abs(point.x - this.#drawStart.x);
      const height = Math.abs(point.y - this.#drawStart.y);
      if (width > 0 && height > 0) {
        // BoundingBox uses the abbreviated `w`/`h` field names that
        // `computeRedactionRects()` emits (`extension/src/lib/redaction.ts`),
        // so the upload pipeline can concatenate the two arrays without
        // a translation step. `serializeRedactionRects()` renames to
        // `width`/`height` on the wire.
        blurRect = {
          x: Math.round(x),
          y: Math.round(y),
          w: Math.round(width),
          h: Math.round(height),
        };
      }
    } else if (this.#tool === 'arrow') {
      if (
        this.#drawStart.x !== point.x ||
        this.#drawStart.y !== point.y
      ) {
        shape = {
          type: 'arrow',
          x1: this.#drawStart.x,
          y1: this.#drawStart.y,
          x2: point.x,
          y2: point.y,
          color: this.#color,
          strokeWidth: this.#strokeWidth,
        };
      }
    } else if (this.#tool === 'stroke' && this.#strokePoints) {
      if (this.#strokePoints.length >= 2) {
        shape = {
          type: 'stroke',
          points: this.#strokePoints.slice(),
          color: this.#color,
          strokeWidth: this.#strokeWidth,
        };
      }
    }

    this.#cancelInProgressShape();
    if (shape) {
      // Snapshot the document *before* committing so `undo()` can
      // restore it (Req 35.3, task 26.3). Cap the stack at
      // `UNDO_STACK_LIMIT` to avoid runaway memory on long sessions.
      this.#pushUndoSnapshot(this.#markupDocument, this.#redactionRects);
      this.#markupDocument = {
        version: 1,
        shapes: [...this.#markupDocument.shapes, shape],
      };
      this.#repaintCanvas();
      this.#renderSvgShapes();
      this.#dispatchChange();
    } else if (blurRect) {
      // Privacy-redaction rect (Req 45.3, task 37.4). Same snapshot
      // discipline so Cmd+Z walks back through the blur drag like any
      // other commit. Note the snapshot includes BOTH the markup
      // document and the redaction list so the undo stack stays
      // homogeneous regardless of which kind of edit was made.
      this.#pushUndoSnapshot(this.#markupDocument, this.#redactionRects);
      this.#redactionRects = [...this.#redactionRects, blurRect];
      this.#renderRedactionRects();
      this.#dispatchChange();
    }
  };

  /**
   * Translate a `PointerEvent` into canvas-space coordinates. Uses the
   * SVG element's bounding rect so the math stays correct when the host
   * applies CSS scaling (the canvas + SVG are sized to the natural
   * dimensions of the bitmap; the `<svg>` viewBox keeps coordinates in
   * pixel space regardless).
   */
  #eventToCanvasPoint(e: PointerEvent): { x: number; y: number } | null {
    const rect = this.#svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      // Tests under jsdom return a zero rect; fall back to the raw
      // offsetX/offsetY which jsdom does populate from MouseEventInit.
      const ox = (e as PointerEvent & { offsetX?: number }).offsetX;
      const oy = (e as PointerEvent & { offsetY?: number }).offsetY;
      if (typeof ox === 'number' && typeof oy === 'number') {
        return { x: ox, y: oy };
      }
      return null;
    }
    const scaleX = this.#canvas.width === 0 ? 1 : this.#canvas.width / rect.width;
    const scaleY = this.#canvas.height === 0 ? 1 : this.#canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  #cancelInProgressShape(): void {
    if (this.#previewEl && this.#previewEl.parentNode) {
      this.#previewEl.parentNode.removeChild(this.#previewEl);
    }
    this.#previewEl = null;
    this.#drawing = false;
    this.#drawStart = null;
    this.#strokePoints = null;
    if (this.#activePointerId !== null) {
      try {
        this.#svg.releasePointerCapture(this.#activePointerId);
      } catch {
        /* ignore — capture may already have ended */
      }
      this.#activePointerId = null;
    }
  }

  #dispatchChange(): void {
    this.dispatchEvent(
      new CustomEvent<MarkupChangeDetail>('change', {
        detail: {
          markupDocument: this.#markupDocument,
          redactionRects: this.#redactionRects.slice(),
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Push a snapshot of the current `Markup_Document` and redaction-rect
   * list onto the undo stack, evicting the oldest entry once the stack
   * reaches `UNDO_STACK_LIMIT`. The snapshot copies the shape and rect
   * arrays so subsequent mutations to `#markupDocument` or
   * `#redactionRects` do not retroactively alter the preserved state.
   * (Req 35.3, task 26.3; extended for Req 45.3, task 37.4.)
   */
  #pushUndoSnapshot(
    doc: MarkupDocument,
    rects: readonly BoundingBox[],
  ): void {
    this.#undoStack.push({
      markupDocument: { version: 1, shapes: doc.shapes.slice() },
      redactionRects: rects.slice(),
    });
    if (this.#undoStack.length > UNDO_STACK_LIMIT) {
      this.#undoStack.splice(0, this.#undoStack.length - UNDO_STACK_LIMIT);
    }
  }
}

function isMarkupTool(value: string): value is MarkupTool {
  return (
    value === 'rect' ||
    value === 'arrow' ||
    value === 'stroke' ||
    value === 'pixelate' ||
    value === 'blur'
  );
}

function pointsToPathD(points: ReadonlyArray<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x} ${points[i].y}`;
  }
  return d;
}

/**
 * Defensive normaliser used by the `markupDocument` setter: drops anything
 * that does not look like a `MarkupShape` so a bad payload from the host
 * cannot crash the renderer.
 */
function normalizeMarkupDocument(
  raw: MarkupDocument | null | undefined,
): MarkupDocument {
  if (!raw || typeof raw !== 'object') return emptyMarkupDocument();
  const shapes = Array.isArray(raw.shapes) ? raw.shapes : [];
  const cleaned: MarkupShape[] = [];
  for (const shape of shapes) {
    if (!shape || typeof shape !== 'object') continue;
    if (shape.type === 'rect' || shape.type === 'pixelate') {
      if (
        typeof shape.x === 'number' &&
        typeof shape.y === 'number' &&
        typeof shape.width === 'number' &&
        typeof shape.height === 'number'
      ) {
        cleaned.push(shape);
      }
    } else if (shape.type === 'arrow') {
      if (
        typeof shape.x1 === 'number' &&
        typeof shape.y1 === 'number' &&
        typeof shape.x2 === 'number' &&
        typeof shape.y2 === 'number'
      ) {
        cleaned.push(shape);
      }
    } else if (shape.type === 'stroke') {
      if (Array.isArray(shape.points)) {
        cleaned.push(shape);
      }
    }
  }
  return { version: 1, shapes: cleaned };
}

if (
  typeof customElements !== 'undefined' &&
  !customElements.get('fl-markup-editor')
) {
  withBoundary(FlMarkupEditor.prototype, 'connectedCallback');
  withBoundary(FlMarkupEditor.prototype, 'disconnectedCallback');
  customElements.define('fl-markup-editor', FlMarkupEditor);
}

declare global {
  interface HTMLElementTagNameMap {
    'fl-markup-editor': FlMarkupEditor;
  }
  interface HTMLElementEventMap {
    // Note: the native 'change' event already exists; we re-declare the
    // CustomEvent shape so listeners on `<fl-markup-editor>` get the
    // markup-specific detail typing. Listeners on other elements still
    // see the original `Event` type.
    'change': CustomEvent<MarkupChangeDetail>;
  }
}
