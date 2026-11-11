// Draws the Drone Sim app icon (a top-down drone) into build/icon.png. No dependencies.
// Run: node tools/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 3; // supersampling for smooth edges

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function inRoundRect(x, y, cx, cy, w, h, r) {
  const dx = Math.abs(x - cx) - (w / 2 - r);
  const dy = Math.abs(y - cy) - (h / 2 - r);
  if (dx <= 0 || dy <= 0) return Math.abs(x - cx) <= w / 2 && Math.abs(y - cy) <= h / 2;
  return dx * dx + dy * dy <= r * r;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** Colour of the top-most shape at (x, y) in 0..256 space, or null if transparent. */
function shade(x, y) {
  if (!inRoundRect(x, y, 128, 128, 240, 240, 54)) return null;
  const c = 128;
  const arm = 66;
  const tips = [[c - arm, c - arm], [c + arm, c - arm], [c - arm, c + arm], [c + arm, c + arm]];
  // nose light
  if (inRoundRect(x, y, c, 96, 26, 10, 4)) return hex('#34ff7a');
  // body
  if (inRoundRect(x, y, c, c, 58, 48, 16)) return y < 120 ? hex('#ffa15c') : hex('#ff8a3d');
  // rotor hubs
  for (const [tx, ty] of tips) if (Math.hypot(x - tx, y - ty) <= 8) return hex('#12304a');
  // rotors
  for (const [tx, ty] of tips) {
    const d = Math.hypot(x - tx, y - ty);
    if (d <= 33) return d > 28 ? hex('#7fe3ff') : hex('#35d0ff');
  }
  // arms
  for (const [tx, ty] of tips) if (distToSegment(x, y, c, c, tx, ty) <= 5.5) return hex('#dfe6f2');
  // background gradient
  const k = y / 256;
  const top = hex('#1f3158'), bottom = hex('#0a101e');
  return top.map((v, i) => Math.round(v + (bottom[i] - v) * k));
}

function crcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC = crcTable();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const col = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (col) { r += col[0]; g += col[1]; b += col[2]; a += 1; }
      }
    }
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    if (a > 0) {
      raw[o] = Math.round(r / a);
      raw[o + 1] = Math.round(g / a);
      raw[o + 2] = Math.round(b / a);
      raw[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
