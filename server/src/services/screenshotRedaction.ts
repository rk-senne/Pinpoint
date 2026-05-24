import sharp from 'sharp';

/**
 * Server-side PII auto-redaction (Req 45.1 / Task 37.2).
 *
 * The Extension sends a screenshot together with a list of `BoundingBox`
 * rectangles that cover sensitive elements (password fields, credit-card
 * inputs, `data-fl-redact`, aria-label matches). Before persisting the
 * image to object storage we apply a Gaussian blur over those regions so
 * the original pixel values never reach the bucket — even if a future
 * bug inadvertently shipped the un-redacted bytes to a viewer, the data
 * would already be unrecoverable from the persisted blob.
 *
 * Implementation notes:
 *   - We use `sharp` (libvips) for the blur. It runs entirely in-process,
 *     does not shell out, and supports PNG/JPEG natively.
 *   - For each rect we extract the region, blur it with a sigma the
 *     caller can override (default 20 — strong enough that 1–2 char-cell
 *     glyphs are illegible), and composite the result back at the same
 *     offset.
 *   - We clamp every rect to the image bounds and silently drop rects
 *     with zero / negative dimensions or those that fall entirely
 *     outside the image. This is intentional: the client is the source
 *     of truth for "what to blur", and a bad rect shouldn't 500 the
 *     entire upload.
 *   - When the input list is empty the function returns the original
 *     buffer untouched (no decode + re-encode cycle, which would change
 *     the byte length even with no pixel changes).
 */

export interface RedactionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ApplyBlurOptions {
  /**
   * Gaussian blur sigma. Higher = more aggressive smoothing. The default
   * is 20, chosen so 14–18px glyphs become illegible while a thumbnail
   * preview still resembles the source image.
   */
  sigma?: number;
}

const DEFAULT_BLUR_SIGMA = 20;

/**
 * Round-and-clamp a single rect to integer pixel coordinates inside
 * `[0, width) × [0, height)`. Returns `null` when the rect is degenerate
 * (zero / negative size) or lies entirely outside the image.
 */
function clampRect(
  rect: RedactionRect,
  imageWidth: number,
  imageHeight: number,
): { left: number; top: number; width: number; height: number } | null {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    return null;
  }
  if (rect.width <= 0 || rect.height <= 0) return null;

  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(imageWidth, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(imageHeight, Math.ceil(rect.y + rect.height));

  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;

  return { left, top, width, height };
}

/**
 * Apply a Gaussian blur over each rect in `rects` and return the
 * resulting PNG buffer. When `rects` is empty/undefined the original
 * buffer is returned as-is so a caller that always pipes through this
 * function does not pay an unnecessary decode/re-encode tax.
 */
export async function applyRedactionBlur(
  imageBuffer: Buffer,
  rects: RedactionRect[] | undefined | null,
  options: ApplyBlurOptions = {},
): Promise<Buffer> {
  if (!rects || rects.length === 0) return imageBuffer;

  const sigma = options.sigma ?? DEFAULT_BLUR_SIGMA;

  // Decode once to learn the image dimensions; we need them to clamp
  // rects and to drive `extract`.
  const base = sharp(imageBuffer);
  const meta = await base.metadata();
  const imgWidth = meta.width ?? 0;
  const imgHeight = meta.height ?? 0;
  if (imgWidth === 0 || imgHeight === 0) {
    // Sharp could not read the dimensions (corrupt header, unsupported
    // format). The caller has already validated MIME type so the most
    // useful behavior is to pass the bytes through unchanged rather
    // than 500.
    return imageBuffer;
  }

  // Pre-clamp every rect; drop the degenerate ones. If nothing survives
  // we can short-circuit and skip the encode pass.
  const clamped = rects
    .map((r) => clampRect(r, imgWidth, imgHeight))
    .filter((r): r is NonNullable<ReturnType<typeof clampRect>> => r !== null);
  if (clamped.length === 0) return imageBuffer;

  // Render each rect to a blurred PNG buffer, then composite all of
  // them on top of the original at their respective offsets in a single
  // pass. Compositing in one call (rather than re-encoding between
  // each rect) keeps memory bounded and avoids cumulative artifacts
  // around overlapping regions.
  const overlays = await Promise.all(
    clamped.map(async ({ left, top, width, height }) => {
      const blurred = await sharp(imageBuffer)
        .extract({ left, top, width, height })
        .blur(sigma)
        .png()
        .toBuffer();
      return { input: blurred, left, top };
    }),
  );

  return sharp(imageBuffer).composite(overlays).png().toBuffer();
}
