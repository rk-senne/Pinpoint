// Shared SVG renderer for `Markup_Document` JSON (Req 35.2 / Task 26.2).
//
// The screenshot detail views in both clients (extension popover details
// panel and dashboard `ProjectView` detail panel) overlay an SVG layer on
// top of the screenshot bitmap when a sibling `<key>.markup.json` is
// present. Centralising the render logic here keeps the two clients in
// sync — what gets persisted by `<fl-markup-editor>` matches what gets
// painted on view, byte-for-byte.

import type { MarkupDocument, MarkupShape } from './types.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Escape a string for safe interpolation into SVG attribute values.
 * Limited to the characters that have meaning inside attribute syntax
 * (`<`, `>`, `&`, single quote, double quote). Numbers / arrays handled
 * by callers.
 */
function escAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert a freehand `points` array to an SVG `path` `d` attribute. The
 * editor and the renderer share the same straight-segment chain so a
 * stroke painted in `<fl-markup-editor>` lays back down identically when
 * viewed.
 */
function pointsToPathD(points: ReadonlyArray<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x} ${points[i].y}`;
  }
  return d;
}

/**
 * Build the SVG fragment for a single shape (no `<svg>` wrapper). Useful
 * when a host wants to compose the shape list under a custom container.
 */
export function shapeToSvgString(shape: MarkupShape): string {
  if (shape.type === 'rect') {
    return (
      `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" ` +
      `fill="none" stroke="${escAttr(shape.color)}" stroke-width="${shape.strokeWidth}" ` +
      `data-shape="rect" />`
    );
  }
  if (shape.type === 'arrow') {
    return (
      `<line x1="${shape.x1}" y1="${shape.y1}" x2="${shape.x2}" y2="${shape.y2}" ` +
      `stroke="${escAttr(shape.color)}" stroke-width="${shape.strokeWidth}" ` +
      `marker-end="url(#fl-markup-arrowhead)" data-shape="arrow" />`
    );
  }
  if (shape.type === 'stroke') {
    return (
      `<path d="${pointsToPathD(shape.points)}" fill="none" ` +
      `stroke="${escAttr(shape.color)}" stroke-width="${shape.strokeWidth}" ` +
      `stroke-linecap="round" stroke-linejoin="round" data-shape="stroke" />`
    );
  }
  // Pixelate viewer is purely visual — a translucent dashed outline so
  // viewers can see where the rasterized pixelation lives on the
  // server-blurred bitmap. The bitmap itself is already pre-blurred by
  // the screenshot pipeline (sharp.blur over redaction rects); the
  // viewer-side outline matches the stand-in painted by
  // `<fl-markup-editor>` during editing.
  return (
    `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" ` +
    `fill="rgba(0, 0, 0, 0.05)" stroke="#1a1a1a" stroke-dasharray="4 2" stroke-width="1" ` +
    `data-shape="pixelate" />`
  );
}

/**
 * Build a complete `<svg>` overlay for a `MarkupDocument`. The viewBox
 * is sized to the supplied bitmap dimensions so the overlay scales with
 * the host's CSS layout while keeping the original pixel coordinates.
 *
 * @param doc      the persisted Markup_Document to render
 * @param width    natural width of the screenshot bitmap (pixels)
 * @param height   natural height of the screenshot bitmap (pixels)
 * @returns        a self-contained SVG string with arrowhead `<defs>`
 */
export function renderMarkupSvg(
  doc: MarkupDocument | null | undefined,
  width: number,
  height: number,
): string {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const viewBox = `0 0 ${w} ${h}`;
  const shapes = doc && Array.isArray(doc.shapes) ? doc.shapes : [];
  const body = shapes.map(shapeToSvgString).join('');
  return (
    `<svg xmlns="${SVG_NS}" viewBox="${viewBox}" width="${w}" height="${h}" ` +
    `class="fl-markup-overlay" preserveAspectRatio="none" aria-hidden="true">` +
    `<defs>` +
    `<marker id="fl-markup-arrowhead" viewBox="0 0 10 10" refX="8" refY="5" ` +
    `markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
    `<path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />` +
    `</marker>` +
    `</defs>` +
    body +
    `</svg>`
  );
}
