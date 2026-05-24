// Generate placeholder PNG screenshots (1280x800) for the FeedbackLoop
// Chrome Web Store listing. Produces valid PNG bytes using only Node.js
// built-ins (no external dependencies), mirroring the strategy used by
// `generate-placeholder-icons.mjs`.
//
// Each screenshot is a flat solid color square sized 1280x800. This is
// sufficient for Web Store submission validation (the dashboard checks
// dimensions and file type) until designed marketing screenshots replace
// them.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

// CRC32 table + computation (per the PNG spec, polynomial 0xedb88320).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const screenshotsDir = resolve(__dirname, "..", "store", "screenshots");

// Three FeedbackLoop-themed colors so reviewers can tell the screenshots
// apart even before they are replaced with real captures. Names mirror
// the design.md filenames.
const SCREENSHOTS = [
  { name: "01-overlay-on-page.png", color: { r: 79, g: 70, b: 229 } },
  { name: "02-popover-with-screenshot.png", color: { r: 16, g: 185, b: 129 } },
  { name: "03-sidebar-with-resolved.png", color: { r: 244, g: 114, b: 182 } },
];

const WIDTH = 1280;
const HEIGHT = 800;

/**
 * Build a single PNG chunk: length (4) + type (4) + data + CRC (4).
 */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Build a valid RGBA PNG of the given dimensions filled with the given color.
 */
function buildPng(width, height, color) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width, height, bit depth=8, color type=6 (RGBA), compression=0,
  // filter=0, interlace=0.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Raw image data: each row prefixed with a filter byte (0 = None),
  // followed by RGBA pixels.
  const rowBytes = 1 + width * 4;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < width; x += 1) {
      const px = rowStart + 1 + x * 4;
      raw[px] = color.r;
      raw[px + 1] = color.g;
      raw[px + 2] = color.b;
      raw[px + 3] = 255;
    }
  }

  const idatData = deflateSync(raw);

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(screenshotsDir, { recursive: true });

for (const { name, color } of SCREENSHOTS) {
  const png = buildPng(WIDTH, HEIGHT, color);
  const outPath = resolve(screenshotsDir, name);
  writeFileSync(outPath, png);
  console.log(`Wrote ${outPath} (${png.length} bytes)`);
}
