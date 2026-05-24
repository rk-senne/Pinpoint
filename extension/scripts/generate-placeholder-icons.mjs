// Generate placeholder PNG icons (16x16, 48x48, 128x128) for the FeedbackLoop
// browser extension. Produces valid PNG bytes using only Node.js built-ins
// (no external dependencies).
//
// The icons are a flat solid FeedbackLoop-blue square; this is sufficient for
// MV3 manifest validation and packaging until a designed icon replaces it.

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
const iconsDir = resolve(__dirname, "..", "icons");

// FeedbackLoop-themed brand color (indigo/blue).
const COLOR = { r: 79, g: 70, b: 229, a: 255 };

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
 * Build a valid RGBA PNG of the given size filled with COLOR.
 */
function buildPng(size) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width, height, bit depth=8, color type=6 (RGBA), compression=0,
  // filter=0, interlace=0.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Raw image data: each row prefixed with a filter byte (0 = None),
  // followed by RGBA pixels.
  const rowBytes = 1 + size * 4;
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x += 1) {
      const px = rowStart + 1 + x * 4;
      raw[px] = COLOR.r;
      raw[px + 1] = COLOR.g;
      raw[px + 2] = COLOR.b;
      raw[px + 3] = COLOR.a;
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

mkdirSync(iconsDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png = buildPng(size);
  const outPath = resolve(iconsDir, `icon${size}.png`);
  writeFileSync(outPath, png);
  console.log(`Wrote ${outPath} (${png.length} bytes)`);
}
