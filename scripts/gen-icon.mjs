// Generates media/icon.png (128x128, RGBA) with no external deps.
// Glyph: a sideways-T (vertical trunk + one horizontal arm), with "+" above the
// arm (added) and "−" below it (removed). Crisp thin strokes, auto-centered.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const W = 128;
const H = 128;
const buf = new Uint8Array(W * H * 4); // RGBA

const COL = {
  bg: [31, 38, 48, 255], // dark slate
  fork: [230, 237, 243, 255], // light gray
  add: [63, 185, 80, 255], // green
  del: [248, 81, 73, 255] // red
};

function px(x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = c[3];
}

// --- glyph defined in local coords, centered at the end ---
const S = 6; // stroke width (thin, crisp)
const h = S / 2;

/** rect by center line: vertical or horizontal bar. */
const rects = [];
function vbar(cx, y0, y1, col) {
  rects.push({ x0: cx - h, x1: cx + h, y0, y1, col });
}
function hbar(cy, x0, x1, col) {
  rects.push({ x0, x1, y0: cy - h, y1: cy + h, col });
}

const mid = 0;
const trunkX = 0;
const armEnd = 52;
const signX = 40;
const signHalf = 12; // half-length of +/- bars
const signOff = 22; // vertical distance of +/- from the arm

// trunk (vertical) + single arm (horizontal) = sideways T
vbar(trunkX, mid - 36, mid + 36, COL.fork);
hbar(mid, trunkX, armEnd, COL.fork);

// plus above the arm
hbar(mid - signOff, signX - signHalf, signX + signHalf, COL.add);
vbar(signX, mid - signOff - signHalf, mid - signOff + signHalf, COL.add);

// minus below the arm
hbar(mid + signOff, signX - signHalf, signX + signHalf, COL.del);

// --- compute bbox and center into the canvas ---
let minX = Infinity,
  minY = Infinity,
  maxX = -Infinity,
  maxY = -Infinity;
for (const r of rects) {
  minX = Math.min(minX, r.x0);
  minY = Math.min(minY, r.y0);
  maxX = Math.max(maxX, r.x1);
  maxY = Math.max(maxY, r.y1);
}
const dx = (W - (maxX - minX)) / 2 - minX;
const dy = (H - (maxY - minY)) / 2 - minY;

// --- rounded background tile ---
const r = 26;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let inside = true;
    if (x < r && y < r) inside = Math.hypot(x - r, y - r) <= r;
    else if (x >= W - r && y < r) inside = Math.hypot(x - (W - r), y - r) <= r;
    else if (x < r && y >= H - r) inside = Math.hypot(x - r, y - (H - r)) <= r;
    else if (x >= W - r && y >= H - r)
      inside = Math.hypot(x - (W - r), y - (H - r)) <= r;
    if (inside) px(x, y, COL.bg);
  }
}

// --- draw crisp glyph rects ---
for (const rc of rects) {
  const x0 = Math.round(rc.x0 + dx);
  const x1 = Math.round(rc.x1 + dx);
  const y0 = Math.round(rc.y0 + dy);
  const y1 = Math.round(rc.y1 + dy);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px(x, y, rc.col);
}

// --- PNG encode ---
function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  Buffer.from(buf.buffer, y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
}
const idat = deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0))
]);
mkdirSync(new URL("../media/", import.meta.url), { recursive: true });
writeFileSync(new URL("../media/icon.png", import.meta.url), png);
console.log("wrote media/icon.png", png.length, "bytes");
