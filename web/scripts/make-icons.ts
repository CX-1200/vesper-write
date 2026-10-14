// Generates the PWA icons in public/icons/ (no image tools or dependencies:
// a tiny PNG encoder on top of node:zlib). Run: node scripts/make-icons.ts
// The design: an evening star (Vesper) — a warm planet with a soft glow.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Rgb = [number, number, number];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size: number, rgb: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour (opaque)
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * size * 3, size * 3).copy(raw, y * (size * 3 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array())]);
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const BG_TOP: Rgb = [24, 30, 46];
const BG_BOTTOM: Rgb = [12, 14, 20];
const GOLD_LIGHT: Rgb = [255, 214, 130];
const GOLD_DARK: Rgb = [214, 128, 30];
const GLOW: Rgb = [240, 170, 70];

/** Colour at (u, v) in [0, 1]². `scale` shrinks the artwork into the maskable safe zone. */
function shade(u: number, v: number, scale: number): Rgb {
  let c = mix(BG_TOP, BG_BOTTOM, v);
  const cx = 0.5;
  const cy = 0.53;
  const r = 0.2 * scale;
  const dx = u - cx;
  const dy = v - cy;
  const d = Math.hypot(dx, dy);
  // soft glow around the planet
  const g = Math.pow(clamp(1 - (d - r) / (r * 1.6)), 2.2) * 0.45;
  c = mix(c, GLOW, d > r ? g : 0);
  if (d <= r) {
    // lit from the upper left
    const t = clamp(0.5 - (dx * 0.6 + dy * 0.8) / r / 1.6);
    c = mix(GOLD_DARK, GOLD_LIGHT, t);
  }
  // a small four-pointed sparkle at the upper right
  const sx = u - (cx + 0.24 * scale);
  const sy = v - (cy - 0.25 * scale);
  const arm = 0.085 * scale;
  const w = 0.012 * scale;
  const star = clamp(1 - Math.abs(sx) / w - Math.abs(sy) / arm) + clamp(1 - Math.abs(sy) / w - Math.abs(sx) / arm);
  c = mix(c, [255, 240, 205], clamp(star));
  return c;
}

function render(size: number, scale: number): Uint8Array {
  const S = 4; // 4×4 supersampling for smooth edges
  const out = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const [cr, cg, cb] = shade((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size, scale);
          r += cr;
          g += cg;
          b += cb;
        }
      }
      const i = (y * size + x) * 3;
      out[i] = Math.round(r / (S * S));
      out[i + 1] = Math.round(g / (S * S));
      out[i + 2] = Math.round(b / (S * S));
    }
  }
  return out;
}

const dir = join(import.meta.dirname, '..', 'public', 'icons');
mkdirSync(dir, { recursive: true });
const icons: Array<[string, number, number]> = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['apple-touch-icon.png', 180, 1],
  // maskable: launchers may crop to a circle of 80% diameter, so keep the art inside it
  ['icon-maskable-512.png', 512, 0.78],
];
for (const [name, size, scale] of icons) {
  writeFileSync(join(dir, name), png(size, render(size, scale)));
  console.log(`wrote public/icons/${name}`);
}
