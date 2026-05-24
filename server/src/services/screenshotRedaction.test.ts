import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { applyRedactionBlur } from './screenshotRedaction.js';

// Build a deterministic test PNG: a 100×60 image. The left half (x<50)
// is solid red. The right half is a fine 1-pixel vertical-stripe pattern
// (alternating green/blue) so a blur applied to the right half produces
// pixel values that differ from the original — uniform-color regions
// would blur back to themselves and obscure the test signal.
async function buildTestPng(): Promise<Buffer> {
  const width = 100;
  const height = 60;
  const channels = 4;
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      if (x < width / 2) {
        // Solid red on the left.
        pixels[i + 0] = 255;
        pixels[i + 1] = 0;
        pixels[i + 2] = 0;
      } else if (x % 2 === 0) {
        // Even columns on the right: green.
        pixels[i + 0] = 0;
        pixels[i + 1] = 255;
        pixels[i + 2] = 0;
      } else {
        // Odd columns on the right: blue.
        pixels[i + 0] = 0;
        pixels[i + 1] = 0;
        pixels[i + 2] = 255;
      }
      pixels[i + 3] = 255;
    }
  }
  return sharp(pixels, {
    raw: { width, height, channels: 4 },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

/**
 * Decode a PNG to raw RGBA so we can compare pixel regions byte-for-byte
 * across the original and the blurred output.
 */
async function rawPixels(buf: Buffer): Promise<{
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

describe('applyRedactionBlur', () => {
  it('returns the original buffer unchanged when rects is empty', async () => {
    const png = await buildTestPng();
    const out = await applyRedactionBlur(png, []);
    expect(out).toBe(png); // same reference: no decode/re-encode
  });

  it('returns the original buffer unchanged when rects is undefined', async () => {
    const png = await buildTestPng();
    const out = await applyRedactionBlur(png, undefined);
    expect(out).toBe(png);
  });

  it('blurs only inside the supplied rect', async () => {
    const png = await buildTestPng();
    // Cover the right half (the green region) only.
    const out = await applyRedactionBlur(
      png,
      [{ x: 50, y: 0, width: 50, height: 60 }],
      { sigma: 10 },
    );

    // The output must be a different image than the original — blurring
    // a 50×60 region of solid green against the red border will change
    // pixel values along the seam.
    expect(out.equals(png)).toBe(false);

    const original = await rawPixels(png);
    const blurred = await rawPixels(out);

    expect(blurred.width).toBe(original.width);
    expect(blurred.height).toBe(original.height);
    expect(blurred.channels).toBe(original.channels);

    // Pixels strictly inside the left half (well clear of the seam)
    // must be byte-identical: nothing outside the rect should change.
    const stride = original.width * original.channels;
    for (let y = 0; y < original.height; y++) {
      for (let x = 0; x < 30; x++) {
        const i = y * stride + x * original.channels;
        expect(blurred.data[i + 0]).toBe(original.data[i + 0]);
        expect(blurred.data[i + 1]).toBe(original.data[i + 1]);
        expect(blurred.data[i + 2]).toBe(original.data[i + 2]);
      }
    }

    // Pixels deep inside the blurred rect should differ from the
    // original (the green region picks up red bleed from the seam).
    let differingPixelsInsideRect = 0;
    for (let y = 0; y < original.height; y++) {
      for (let x = 50; x < original.width; x++) {
        const i = y * stride + x * original.channels;
        if (
          blurred.data[i + 0] !== original.data[i + 0] ||
          blurred.data[i + 1] !== original.data[i + 1] ||
          blurred.data[i + 2] !== original.data[i + 2]
        ) {
          differingPixelsInsideRect++;
        }
      }
    }
    expect(differingPixelsInsideRect).toBeGreaterThan(0);
  });

  it('clamps a rect that overflows the image bounds', async () => {
    const png = await buildTestPng();
    // A rect that starts inside the image but extends well past the
    // right and bottom edges. Without clamping, sharp.extract would
    // throw "extract_area: bad extract area".
    const out = await applyRedactionBlur(png, [
      { x: 80, y: 40, width: 10000, height: 10000 },
    ]);
    expect(out.length).toBeGreaterThan(0);
  });

  it('drops degenerate rects (zero / negative dimensions, NaN, fully off-image)', async () => {
    const png = await buildTestPng();
    const out = await applyRedactionBlur(png, [
      { x: 0, y: 0, width: 0, height: 50 },
      { x: 0, y: 0, width: 50, height: -1 },
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      { x: 1000, y: 1000, width: 10, height: 10 }, // entirely off-image
    ]);
    // All rects were degenerate after clamping: returns the original
    // buffer unchanged (no decode/re-encode).
    expect(out).toBe(png);
  });

  it('applies multiple rects in a single composite pass', async () => {
    const png = await buildTestPng();
    const out = await applyRedactionBlur(png, [
      { x: 0, y: 0, width: 20, height: 20 },
      { x: 80, y: 40, width: 20, height: 20 },
    ]);
    expect(out.equals(png)).toBe(false);

    const original = await rawPixels(png);
    const blurred = await rawPixels(out);

    // A pixel in the middle of the image (well outside both rects) is
    // unchanged.
    const stride = original.width * original.channels;
    const midIdx = 30 * stride + 30 * original.channels;
    expect(blurred.data[midIdx + 0]).toBe(original.data[midIdx + 0]);
    expect(blurred.data[midIdx + 1]).toBe(original.data[midIdx + 1]);
    expect(blurred.data[midIdx + 2]).toBe(original.data[midIdx + 2]);
  });
});
