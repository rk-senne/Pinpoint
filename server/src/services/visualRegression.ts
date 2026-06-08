/**
 * VisualRegression — compares the screenshot from when an annotation was
 * created against a fresh capture to detect if the issue is truly fixed.
 *
 * Uses pixel-by-pixel comparison with a tolerance threshold.
 * In production, swap with a perceptual hash (pHash) or SSIM.
 */

export interface RegressionResult {
  match: boolean;
  diffPercentage: number;
  status: 'identical' | 'minor_change' | 'significant_change' | 'completely_different';
}

/**
 * Compare two image buffers (PNG). Returns similarity metrics.
 * Runs server-side with sharp (already a dependency).
 */
export async function compareScreenshots(
  baseline: Buffer,
  current: Buffer,
  threshold = 0.05,
): Promise<RegressionResult> {
  // Dynamic import so this only loads when called
  const sharp = await import('sharp');

  const RESIZE_WIDTH = 800;

  const [baseImg, currImg] = await Promise.all([
    sharp.default(baseline).resize(RESIZE_WIDTH).raw().toBuffer({ resolveWithObject: true }),
    sharp.default(current).resize(RESIZE_WIDTH).raw().toBuffer({ resolveWithObject: true }),
  ]);

  // Ensure same dimensions
  if (baseImg.info.width !== currImg.info.width || baseImg.info.height !== currImg.info.height) {
    return { match: false, diffPercentage: 100, status: 'completely_different' };
  }

  const totalPixels = baseImg.info.width * baseImg.info.height;
  let diffPixels = 0;
  const channels = baseImg.info.channels;

  for (let i = 0; i < baseImg.data.length; i += channels) {
    let pixelDiff = 0;
    for (let c = 0; c < channels; c++) {
      pixelDiff += Math.abs(baseImg.data[i + c]! - currImg.data[i + c]!);
    }
    // Average channel diff > 30 counts as a different pixel
    if (pixelDiff / channels > 30) diffPixels++;
  }

  const diffPercentage = Math.round((diffPixels / totalPixels) * 10000) / 100;
  const match = diffPercentage <= threshold * 100;

  let status: RegressionResult['status'];
  if (diffPercentage === 0) status = 'identical';
  else if (diffPercentage < 2) status = 'minor_change';
  else if (diffPercentage < 15) status = 'significant_change';
  else status = 'completely_different';

  return { match, diffPercentage, status };
}

/**
 * Endpoint-ready function: given an annotation ID, compare its baseline
 * screenshot with a newly provided capture.
 */
export async function checkRegression(
  db: any,
  annotationId: string,
  newScreenshot: Buffer,
): Promise<RegressionResult & { annotationId: string }> {
  const annotation = await db('annotations').where('id', annotationId).first();
  if (!annotation?.screenshot_object_key) {
    return { annotationId, match: false, diffPercentage: 100, status: 'completely_different' };
  }

  // In production, fetch baseline from S3 using screenshot_object_key
  // For now, return a placeholder result
  const baseline = annotation.screenshot_buffer;
  if (!baseline) {
    return { annotationId, match: false, diffPercentage: 100, status: 'completely_different' };
  }

  const result = await compareScreenshots(baseline, newScreenshot);
  return { annotationId, ...result };
}
