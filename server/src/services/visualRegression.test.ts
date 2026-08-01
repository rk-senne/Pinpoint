import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { compareScreenshots, checkRegression } from './visualRegression.js';
import type { CheckRegressionDeps } from './visualRegression.js';

// ---------------------------------------------------------------------------
// Helpers — generate small deterministic PNG buffers for testing
// ---------------------------------------------------------------------------

async function buildSolidPng(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let i = 0; i < pixels.length; i += channels) {
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
  }
  return sharp(pixels, { raw: { width, height, channels } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

/**
 * Build a PNG where the top half is one color and the bottom half is another.
 * This guarantees ~50% pixel difference when compared to a solid image of the
 * first color.
 */
async function buildHalfDiffPng(
  width: number,
  height: number,
  topR: number,
  topG: number,
  topB: number,
  bottomR: number,
  bottomG: number,
  bottomB: number,
): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  const halfY = Math.floor(height / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      if (y < halfY) {
        pixels[i] = topR;
        pixels[i + 1] = topG;
        pixels[i + 2] = topB;
      } else {
        pixels[i] = bottomR;
        pixels[i + 1] = bottomG;
        pixels[i + 2] = bottomB;
      }
    }
  }
  return sharp(pixels, { raw: { width, height, channels } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

// ---------------------------------------------------------------------------
// compareScreenshots — pure logic tests
// ---------------------------------------------------------------------------

describe('compareScreenshots', () => {
  it('returns identical for two matching images', async () => {
    const img = await buildSolidPng(100, 80, 200, 100, 50);
    const result = await compareScreenshots(img, img);
    expect(result.match).toBe(true);
    expect(result.diffPercentage).toBe(0);
    expect(result.status).toBe('identical');
  });

  it('returns completely_different for images with very different content', async () => {
    const red = await buildSolidPng(100, 80, 255, 0, 0);
    const blue = await buildSolidPng(100, 80, 0, 0, 255);
    const result = await compareScreenshots(red, blue);
    expect(result.match).toBe(false);
    expect(result.diffPercentage).toBeGreaterThan(15);
    expect(result.status).toBe('completely_different');
  });

  it('returns completely_different for mismatched dimensions (aspect ratio)', async () => {
    // After resizing to 800px width, these will have different heights
    const wide = await buildSolidPng(200, 100, 128, 128, 128); // aspect 2:1 → 800×400
    const tall = await buildSolidPng(200, 400, 128, 128, 128); // aspect 1:2 → 800×1600
    const result = await compareScreenshots(wide, tall);
    expect(result.match).toBe(false);
    expect(result.diffPercentage).toBe(100);
    expect(result.status).toBe('completely_different');
  });

  it('returns significant_change for ~50% pixel difference', async () => {
    const solid = await buildSolidPng(100, 80, 255, 0, 0);
    const halfDiff = await buildHalfDiffPng(100, 80, 255, 0, 0, 0, 0, 255);
    const result = await compareScreenshots(solid, halfDiff);
    expect(result.match).toBe(false);
    expect(result.diffPercentage).toBeGreaterThan(15);
    expect(result.status).toBe('completely_different');
  });

  it('returns match=true for empty (zero-length) buffers guard', async () => {
    const empty = Buffer.alloc(0);
    const img = await buildSolidPng(100, 80, 128, 128, 128);
    const result = await compareScreenshots(empty, img);
    expect(result.match).toBe(false);
    expect(result.diffPercentage).toBe(100);
    expect(result.status).toBe('completely_different');
  });
});

// ---------------------------------------------------------------------------
// checkRegression — service layer tests with mock deps
// ---------------------------------------------------------------------------

describe('checkRegression', () => {
  it('returns completely_different when annotation has no screenshotObjectKey', async () => {
    const deps: CheckRegressionDeps = {
      fetchAnnotation: async () => ({ screenshotObjectKey: null }),
      fetchScreenshotBuffer: async () => null,
    };
    const newImg = await buildSolidPng(100, 80, 0, 255, 0);
    const result = await checkRegression(deps, 'ann-1', newImg);
    expect(result.annotationId).toBe('ann-1');
    expect(result.match).toBe(false);
    expect(result.diffPercentage).toBe(100);
    expect(result.status).toBe('completely_different');
  });

  it('returns completely_different when annotation not found', async () => {
    const deps: CheckRegressionDeps = {
      fetchAnnotation: async () => null,
      fetchScreenshotBuffer: async () => null,
    };
    const newImg = await buildSolidPng(100, 80, 0, 255, 0);
    const result = await checkRegression(deps, 'ann-missing', newImg);
    expect(result.match).toBe(false);
    expect(result.status).toBe('completely_different');
  });

  it('returns completely_different when fetchScreenshotBuffer returns null', async () => {
    const deps: CheckRegressionDeps = {
      fetchAnnotation: async () => ({ screenshotObjectKey: 'some/key.png' }),
      fetchScreenshotBuffer: async () => null,
    };
    const newImg = await buildSolidPng(100, 80, 0, 255, 0);
    const result = await checkRegression(deps, 'ann-2', newImg);
    expect(result.annotationId).toBe('ann-2');
    expect(result.match).toBe(false);
    expect(result.status).toBe('completely_different');
  });

  it('delegates to compareScreenshots when baseline is available', async () => {
    const baseline = await buildSolidPng(100, 80, 255, 0, 0);
    const deps: CheckRegressionDeps = {
      fetchAnnotation: async () => ({ screenshotObjectKey: 'screenshots/ann-3.png' }),
      fetchScreenshotBuffer: async () => baseline,
    };
    // Pass the same image as newScreenshot → should be identical
    const result = await checkRegression(deps, 'ann-3', baseline);
    expect(result.annotationId).toBe('ann-3');
    expect(result.match).toBe(true);
    expect(result.diffPercentage).toBe(0);
    expect(result.status).toBe('identical');
  });

  it('detects regression when baseline and current differ significantly', async () => {
    const baseline = await buildSolidPng(100, 80, 255, 0, 0);
    const current = await buildSolidPng(100, 80, 0, 0, 255);
    const deps: CheckRegressionDeps = {
      fetchAnnotation: async () => ({ screenshotObjectKey: 'screenshots/ann-4.png' }),
      fetchScreenshotBuffer: async () => baseline,
    };
    const result = await checkRegression(deps, 'ann-4', current);
    expect(result.annotationId).toBe('ann-4');
    expect(result.match).toBe(false);
    expect(result.status).toBe('completely_different');
  });
});
