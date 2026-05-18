#!/usr/bin/env node
// Generates PNG icons from the transit favicon design using only built-in Node.js modules
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// CRC32 for PNG chunks
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[i] = c;
}
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(d.length);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, d])));
  return Buffer.concat([len, t, d, crcBuf]);
}

function createTransitIcon(size) {
  // Scale factor: SVG is 32x32 viewBox
  const s = size / 32;

  // RGBA pixel buffer
  const buf = new Uint8ClampedArray(size * size * 4); // all zeros (transparent)

  function blendPixel(px, py, r, g, b, a) {
    if (px < 0 || px >= size || py < 0 || py >= size) return;
    const i = (py * size + px) * 4;
    const srcA = a / 255;
    const dstA = buf[i + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA === 0) return;
    buf[i]     = Math.round((r * srcA + buf[i]     * dstA * (1 - srcA)) / outA);
    buf[i + 1] = Math.round((g * srcA + buf[i + 1] * dstA * (1 - srcA)) / outA);
    buf[i + 2] = Math.round((b * srcA + buf[i + 2] * dstA * (1 - srcA)) / outA);
    buf[i + 3] = Math.round(outA * 255);
  }

  function fillCircle(cx, cy, r, col, opacity = 1) {
    const [R, G, B] = col;
    const A = Math.round(opacity * 255);
    const scx = cx * s, scy = cy * s, sr = r * s;
    const x0 = Math.floor(scx - sr - 1), x1 = Math.ceil(scx + sr + 1);
    const y0 = Math.floor(scy - sr - 1), y1 = Math.ceil(scy + sr + 1);
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const d = Math.hypot(px - scx, py - scy);
        if (d <= sr) {
          blendPixel(px, py, R, G, B, A);
        } else if (d <= sr + 1) {
          // Anti-alias edge
          const aa = Math.round((1 - (d - sr)) * A);
          blendPixel(px, py, R, G, B, aa);
        }
      }
    }
  }

  function strokeCircle(cx, cy, r, sw, col, opacity = 1) {
    const [R, G, B] = col;
    const A = Math.round(opacity * 255);
    const scx = cx * s, scy = cy * s, sr = r * s, ssw = sw * s / 2;
    const outer = sr + ssw, inner = sr - ssw;
    const x0 = Math.floor(scx - outer - 1), x1 = Math.ceil(scx + outer + 1);
    const y0 = Math.floor(scy - outer - 1), y1 = Math.ceil(scy + outer + 1);
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const d = Math.hypot(px - scx, py - scy);
        if (d >= inner && d <= outer) {
          blendPixel(px, py, R, G, B, A);
        } else if (d < inner && d >= inner - 1) {
          const aa = Math.round((d - (inner - 1)) * A);
          blendPixel(px, py, R, G, B, aa);
        } else if (d > outer && d <= outer + 1) {
          const aa = Math.round((1 - (d - outer)) * A);
          blendPixel(px, py, R, G, B, aa);
        }
      }
    }
  }

  // --- Render the icon layers (matching favicon.svg) ---

  // 1. Background circle #1e293b
  fillCircle(16, 16, 16, [30, 41, 59]);

  // 2. Outer dashed ring #6366f1 opacity 0.5 (render as solid stroke)
  strokeCircle(16, 16, 11, 1.5, [99, 102, 241], 0.5);

  // 3. Inner dashed ring #22c55e opacity 0.6
  strokeCircle(16, 16, 6, 1.5, [34, 197, 94], 0.6);

  // 4. Top stop #22c55e
  fillCircle(16, 7, 2, [34, 197, 94]);

  // 5. Right stop #eab308
  fillCircle(23, 21, 2, [234, 179, 8]);

  // 6. Left stop #f97316
  fillCircle(9, 21, 2, [249, 115, 22]);

  // 7. Center white dot
  fillCircle(16, 16, 2.5, [255, 255, 255]);

  // --- Build PNG ---
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Scanlines with filter byte 0 (None) per row
  const raw = Buffer.allocUnsafe(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = y * (size * 4 + 1) + 1 + x * 4;
      raw[dst]     = buf[src];
      raw[dst + 1] = buf[src + 1];
      raw[dst + 2] = buf[src + 2];
      raw[dst + 3] = buf[src + 3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'public');

const sizes = [
  { size: 192, name: 'pwa-192x192.png' },
  { size: 512, name: 'pwa-512x512.png' },
  { size: 180, name: 'apple-touch-icon.png' },
];

for (const { size, name } of sizes) {
  const png = createTransitIcon(size);
  fs.writeFileSync(path.join(outDir, name), png);
  console.log(`Generated ${name} (${size}x${size})`);
}
