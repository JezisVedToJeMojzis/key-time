// Generate the PWA PNG icons from the same key design as icons/icon.svg.
//
// Android Chrome and iOS don't reliably use an SVG manifest icon for the home
// screen — without PNGs they fall back to an auto-generated letter icon. This
// script renders the key into PNGs (zero dependencies: just zlib + supersampled
// anti-aliasing) so every phone shows the real logo.
//
//   npm run gen-icons
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public', 'icons');

// Brand + key geometry, in the 512×512 space used by icon.svg.
const INDIGO = [0x4f, 0x46, 0xe5];
const WHITE = [0xff, 0xff, 0xff];
const HW = 34 / 2; // half of the SVG stroke width
const BOW = { cx: 150, cy: 256, r: 78 };
const SEGS = [
  [228, 256, 408, 256], // shaft
  [360, 256, 360, 312], // tooth 1
  [408, 256, 408, 300], // tooth 2
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Signed distance to the stroked key (negative = inside the white stroke).
function keySdf(x, y) {
  // bow: a stroked ring
  const ring = Math.abs(Math.hypot(x - BOW.cx, y - BOW.cy) - BOW.r) - HW;
  let best = ring;
  for (const [ax, ay, bx, by] of SEGS) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / len2, 0, 1);
    const px = ax + t * dx, py = ay + t * dy;
    best = Math.min(best, Math.hypot(x - px, y - py) - HW); // capsule = round caps/joins
  }
  return best;
}

// Signed distance to a rounded rectangle centred in the 512 box.
function roundRectSdf(x, y, half, radius) {
  const qx = Math.abs(x - 256) - (half - radius);
  const qy = Math.abs(y - 256) - (half - radius);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
}

// Render one icon to an RGBA buffer. `mode` is 'rounded' (transparent corners,
// for Android "any") or 'square' (fully opaque, for maskable + Apple touch).
function render(size, { mode = 'rounded', keyScale = 1 } = {}) {
  const SS = 4; // supersampling factor per axis
  const buf = Buffer.alloc(size * size * 4);
  const toSvg = (p) => ((p + 0.5) / size) * 512; // pixel-centre → 512 space
  const radius = mode === 'square' ? 0 : 96;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCov = 0, keyCov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const X = toSvg(x + (sx + 0.5) / SS - 0.5);
          const Y = toSvg(y + (sy + 0.5) / SS - 0.5);
          const inBg =
            mode === 'square' ? true
            : mode === 'badge' ? false // transparent background (silhouette)
            : roundRectSdf(X, Y, 256, radius) <= 0;
          if (inBg) bgCov++;
          // Scale the key about the centre (used to inset the maskable variant).
          const kx = 256 + (X - 256) / keyScale;
          const ky = 256 + (Y - 256) / keyScale;
          if (keySdf(kx, ky) <= 0) keyCov++;
        }
      }
      const n = SS * SS;
      const bgA = bgCov / n;          // 0..1
      const keyA = keyCov / n;        // 0..1
      // Composite: white key over the indigo background.
      const outA = keyA + bgA * (1 - keyA);
      const i = (y * size + x) * 4;
      if (outA <= 0) {
        buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0;
      } else {
        for (let c = 0; c < 3; c++) {
          buf[i + c] = Math.round(
            (WHITE[c] * keyA + INDIGO[c] * bgA * (1 - keyA)) / outA
          );
        }
        buf[i + 3] = Math.round(outA * 255);
      }
    }
  }
  return buf;
}

// --- Minimal PNG encoder (8-bit RGBA, color type 6) ----------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // no filter
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const targets = [
  ['icon-192.png', 192, { mode: 'rounded' }],
  ['icon-512.png', 512, { mode: 'rounded' }],
  ['icon-maskable-512.png', 512, { mode: 'square', keyScale: 0.7 }], // safe-zone inset
  ['apple-touch-icon.png', 180, { mode: 'square' }],
  ['icon-badge.png', 96, { mode: 'badge' }], // monochrome notification badge (transparent bg)
];

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, opts] of targets) {
  const png = encodePng(render(size, opts), size);
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`wrote ${name} (${size}×${size}, ${png.length} bytes)`);
}
console.log('done');
