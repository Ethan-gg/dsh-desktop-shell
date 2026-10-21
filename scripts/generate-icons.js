'use strict';

/**
 * Dependency-free PNG icon generator.
 *
 * The tray icon is a rounded blue tile with a white terminal prompt; the
 * window icon is the same artwork at 256px. Keeping the generator in-repo
 * avoids shipping opaque binary blobs or depending on an image toolchain.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mix(a, b, t) {
  return a + (b - a) * clamp(t, 0, 1);
}

function roundedRectAlpha(x, y, size, radius) {
  const cx = clamp(x, radius, size - radius);
  const cy = clamp(y, radius, size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return Math.hypot(dx, dy) <= radius ? 1 : 0;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const thickness = Math.max(1.8, size * 0.055);
  const scale = size / 32;

  const segments = [
    [10.0 * scale, 9.2 * scale, 16.0 * scale, 16.0 * scale],
    [16.0 * scale, 16.0 * scale, 10.0 * scale, 22.8 * scale],
    [18.0 * scale, 22.8 * scale, 23.0 * scale, 22.8 * scale],
  ];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;
      const alpha = roundedRectAlpha(px, py, size, radius);
      if (alpha === 0) {
        pixels[index + 3] = 0;
        continue;
      }

      const t = clamp((px + py) / (size * 2), 0, 1);
      let r = mix(31, 88, t);
      let g = mix(111, 166, t);
      let b = mix(235, 255, t);
      let a = 255;

      // Subtle inner highlight at the top.
      const highlight = Math.max(0, 1 - (px / size) * 0.6 - (py / size) * 1.2);
      r = mix(r, 255, highlight * 0.16);
      g = mix(g, 255, highlight * 0.16);
      b = mix(b, 255, highlight * 0.16);

      let ink = 0;
      for (const [x1, y1, x2, y2] of segments) {
        const distance = distanceToSegment(px, py, x1, y1, x2, y2);
        ink = Math.max(ink, clamp((thickness + 0.7 - distance) / 1.4, 0, 1));
      }
      if (ink > 0) {
        r = mix(r, 255, ink);
        g = mix(g, 255, ink);
        b = mix(b, 255, ink);
      }

      pixels[index] = Math.round(r);
      pixels[index + 1] = Math.round(g);
      pixels[index + 2] = Math.round(b);
      pixels[index + 3] = a;
    }
  }
  return pixels;
}

function main() {
  const root = path.resolve(__dirname, '..');
  const assets = path.join(root, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  for (const [name, size] of [['tray.png', 32], ['icon.png', 256]]) {
    const png = encodePng(size, size, drawIcon(size));
    const file = path.join(assets, name);
    fs.writeFileSync(file, png);
    console.log(`${file} (${png.length} bytes)`);
  }
  const ico = encodeIco([16, 24, 32, 48, 64, 128, 256]);
  const icoFile = path.join(assets, 'icon.ico');
  fs.writeFileSync(icoFile, ico);
  console.log(`${icoFile} (${ico.length} bytes)`);
}

function encodeIco(sizes) {
  const images = sizes.map((size) => ({ size, png: encodePng(size, size, drawIcon(size)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(images.length * 16);
  let offset = 6 + entries.length;
  images.forEach(({ size, png }, index) => {
    const at = index * 16;
    entries[at] = size >= 256 ? 0 : size;
    entries[at + 1] = size >= 256 ? 0 : size;
    entries[at + 2] = 0;
    entries[at + 3] = 0;
    entries.writeUInt16LE(1, at + 4);
    entries.writeUInt16LE(32, at + 6);
    entries.writeUInt32LE(png.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...images.map((image) => image.png)]);
}

if (require.main === module) main();

module.exports = { crc32, drawIcon, encodeIco, encodePng };
