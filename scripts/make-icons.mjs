#!/usr/bin/env node
// Generates the PWA icons from the original 8×8 pixel mark. No dependencies: a tiny PNG encoder on node:zlib.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'apps/web/public/icons';
mkdirSync(out, { recursive: true });

const MARK = ['..pppp..', '.pyyyyp.', 'pyyyyyyp', 'pywyywyp', 'pykyykyp', 'pyyyyyyp', '.pykkyp.', '..pppp..'];
const COL = { p: [255, 62, 154, 255], y: [255, 210, 63, 255], w: [255, 255, 255, 255], k: [26, 20, 38, 255] };
const BG = [13, 11, 20, 255];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** mark occupies `frac` of the icon, centred, on a solid background (or transparent). */
function icon(size, frac, { bg = BG, mono = false, frame = false } = {}) {
  const cell = Math.floor((size * frac) / 8);
  const off = Math.floor((size - cell * 8) / 2);
  const fw = Math.max(2, Math.round(size / 32));
  return png(size, (x, y) => {
    const cx = Math.floor((x - off) / cell), cy = Math.floor((y - off) / cell);
    const ch = x >= off && y >= off && cx < 8 && cy < 8 ? MARK[cy][cx] : '.';
    if (ch !== '.') return mono ? (ch === 'k' || ch === 'w' ? [0, 0, 0, 0] : [255, 255, 255, 255]) : COL[ch];
    if (frame && (x < fw || y < fw || x >= size - fw || y >= size - fw)) return COL.p;
    return bg;
  });
}

const files = {
  'favicon-32.png': icon(32, 1, { bg: [0, 0, 0, 0] }),
  'apple-touch-icon.png': icon(180, 0.7),
  'icon-192.png': icon(192, 0.75, { frame: true }),
  'icon-512.png': icon(512, 0.75, { frame: true }),
  'maskable-512.png': icon(512, 0.5),
  'badge-72.png': icon(72, 0.9, { bg: [0, 0, 0, 0], mono: true }),
};
for (const [name, buf] of Object.entries(files)) writeFileSync(join(out, name), buf);
console.log(`wrote ${Object.keys(files).length} icons to ${out}`);
