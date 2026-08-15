#!/usr/bin/env node
// 生成应用图标源图（1024x1024 PNG）。用法: node scripts/gen-icon.mjs [out.png]
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const W = 1024, H = 1024;
const OUT = process.argv[2] || "shell/src-tauri/icons/icon-src.png";

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// ---- 像素 ----
// 圆角半径
const R = 190;
const rad = (x, y) => {
  const cx = Math.max(R, Math.min(W - R, x));
  const cy = Math.max(R, Math.min(H - R, y));
  return Math.hypot(x - cx, y - cy) <= R;
};
// 渐变斜条（左下→右上），中间留出 ">" 折线
const inBar = (x, y) => {
  const t = (x + y) / (W + H); // 0..1 对角线位置
  return t > 0.42 && t < 0.62;
};

const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  const rowStart = y * (1 + W * 4);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const i = rowStart + 1 + x * 4;
    const a = rad(x, y) ? 255 : 0;
    if (a === 0) { raw[i+3] = 0; continue; }
    let r, g, b;
    if (inBar(x, y)) {
      const t = (x + y) / (W + H);
      // 蓝→绿渐变
      r = Math.round(76 + (46 - 76) * t * 3);
      g = Math.round(154 + (160 - 154) * t * 3);
      b = Math.round(255 + (67 - 255) * t * 3);
    } else {
      r = 13; g = 17; b = 23;
    }
    raw[i] = r; raw[i+1] = g; raw[i+2] = b; raw[i+3] = a;
  }
}

// ---- 封装 PNG ----
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(OUT, png);
console.log("icon written:", OUT, png.length, "bytes");
