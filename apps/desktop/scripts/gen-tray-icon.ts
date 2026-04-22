// One-off generator for the macOS menu-bar template icon.
// Run with: bun run scripts/gen-tray-icon.ts
//
// Outputs grayscale + alpha PNGs (color type 4). Template images on macOS only
// use the alpha channel — the OS substitutes black/white based on menu bar
// state — so we just paint solid black wherever the bubble exists.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// PNG CRC-32 (poly 0xEDB88320, reversed)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodeGrayAlphaPng(w: number, h: number, pixels: Uint8Array): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 4; // color type: grayscale + alpha
  // 10-12 default to 0 (compression, filter, interlace)

  const stride = w * 2;
  const raw = Buffer.alloc(h * (1 + stride));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + stride);
    raw[rowStart] = 0; // filter: None
    for (let i = 0; i < stride; i++) raw[rowStart + 1 + i] = pixels[y * stride + i]!;
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Paints a chat-bubble shape:
 *   - rounded square occupying the top ~78% of the canvas
 *   - small triangular tail pointing down-left at the bottom of the bubble
 * All pixels are pure black; only alpha varies (1px feathered edge).
 */
function drawBubble(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 2);

  const set = (x: number, y: number, alpha: number): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 2;
    if (alpha > px[o + 1]!) {
      px[o] = 0; // black
      px[o + 1] = alpha;
    }
  };

  // Bubble bounds
  const margin = Math.max(1, Math.round(size * 0.06));
  const bubbleH = Math.round(size * 0.78);
  const r = Math.max(2, Math.round(size * 0.22));
  const left = margin;
  const right = size - margin - 1;
  const top = margin;
  const bottom = top + bubbleH - 1;

  // Rounded rect fill with 1-px feathered edge
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const cx = x < left + r ? left + r : x > right - r ? right - r : x;
      const cy = y < top + r ? top + r : y > bottom - r ? bottom - r : y;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r - 0.5) set(x, y, 255);
      else if (d < r + 0.5) set(x, y, Math.round((r + 0.5 - d) * 255));
    }
  }

  // Tail: triangle hanging from lower-left of bubble
  const tailTipX = left + Math.round(size * 0.12);
  const tailRootX = left + Math.round(size * 0.34);
  const tailTopY = bottom;
  const tailBottomY = Math.min(size - 1, bottom + Math.round(size * 0.22));

  for (let y = tailTopY; y <= tailBottomY; y++) {
    const t = (y - tailTopY) / Math.max(1, tailBottomY - tailTopY);
    const xLeft = Math.round(tailRootX - (tailRootX - tailTipX) * t);
    const xRight = tailRootX;
    for (let x = xLeft; x <= xRight; x++) set(x, y, 255);
  }

  return px;
}

const outDir = resolve(import.meta.dir, '..', 'resources');
mkdirSync(outDir, { recursive: true });

writeFileSync(resolve(outDir, 'trayTemplate.png'), encodeGrayAlphaPng(16, 16, drawBubble(16)));
writeFileSync(resolve(outDir, 'trayTemplate@2x.png'), encodeGrayAlphaPng(32, 32, drawBubble(32)));

console.log('wrote', resolve(outDir, 'trayTemplate.png'));
console.log('wrote', resolve(outDir, 'trayTemplate@2x.png'));
