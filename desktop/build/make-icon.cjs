/**
 * 生成应用图标：512x512 渐变底 + 棱镜三角，写出一张 PNG，再包成 .ico。
 * 不依赖任何图像库：PNG 用 node:zlib 的 deflate 手写（IHDR/IDAT/IEND + CRC32），
 * ICO 直接内嵌 PNG（Vista+ 支持 PNG-in-ICO）。
 */
const { deflateSync } = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 512;

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------- PNG 编码 ---------- */
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 渲染：对角渐变 + 棱镜三角 ---------- */
const mix = (a, b, t) => Math.round(a + (b - a) * t);
const COLORS = [
  [111, 227, 255], // cyan
  [167, 139, 250], // violet
  [255, 134, 200], // pink
];

function gradientAt(u) {
  const seg = u * (COLORS.length - 1);
  const i = Math.min(COLORS.length - 2, Math.floor(seg));
  const t = seg - i;
  const a = COLORS[i];
  const b = COLORS[i + 1];
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

// 三角形顶点
const TRI = [
  [256, 128],
  [424, 384],
  [88, 384],
];
const triArea = Math.abs(
  (TRI[1][0] - TRI[0][0]) * (TRI[2][1] - TRI[0][1]) - (TRI[2][0] - TRI[0][0]) * (TRI[1][1] - TRI[0][1]),
) / 2;
function inTriangle(x, y) {
  const area = (p, q, r) => Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
  const total = area(TRI[0], TRI[1], TRI[2]);
  const a = area([x, y], TRI[1], TRI[2]);
  const b = area(TRI[0], [x, y], TRI[2]);
  const c = area(TRI[0], TRI[1], [x, y]);
  return Math.abs(total - (a + b + c)) < 0.5;
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const idx = (y * SIZE + x) * 4;
    const [r, g, b] = gradientAt((x + y) / (2 * (SIZE - 1)));
    rgba[idx] = r;
    rgba[idx + 1] = g;
    rgba[idx + 2] = b;
    rgba[idx + 3] = 255;
  }
}
// 三角：半透明深色填充 + 顶部高光
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    if (!inTriangle(x, y)) continue;
    const idx = (y * SIZE + x) * 4;
    const depth = (y - TRI[0][1]) / (TRI[1][1] - TRI[0][1]); // 0 顶部 ~ 1 底部
    const dark = [10, 14, 28];
    const alpha = 0.82;
    rgba[idx] = Math.round(rgba[idx] * (1 - alpha) + dark[0] * alpha);
    rgba[idx + 1] = Math.round(rgba[idx + 1] * (1 - alpha) + dark[1] * alpha);
    rgba[idx + 2] = Math.round(rgba[idx + 2] * (1 - alpha) + dark[2] * alpha);
    // 顶部一条光带（像玻璃高光）
    if (depth < 0.18) {
      const t = depth / 0.18;
      const light = [255, 255, 255];
      const la = (1 - t) * 0.5;
      rgba[idx] = Math.round(rgba[idx] * (1 - la) + light[0] * la);
      rgba[idx + 1] = Math.round(rgba[idx + 1] * (1 - la) + light[1] * la);
      rgba[idx + 2] = Math.round(rgba[idx + 2] * (1 - la) + light[2] * la);
    }
  }
}
// 三角中间一条贯穿横线（呼应 icon.svg 的设计）
const lineY = 300;
for (let x = 88; x <= 424; x += 1) {
  const idx = (lineY * SIZE + x) * 4;
  rgba[idx] = 111;
  rgba[idx + 1] = 227;
  rgba[idx + 2] = 255;
}

/* ---------- 写出 PNG 与 ICO ---------- */
const png = encodePng(SIZE, SIZE, rgba);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);

// ICO 头：ICONDIR + 一个 ICONDIRENTRY，内嵌 PNG
const ico = Buffer.alloc(6 + 16 + png.length);
ico.writeUInt16LE(0, 0); // reserved
ico.writeUInt16LE(1, 2); // type: icon
ico.writeUInt16LE(1, 4); // count
ico[6] = 0;              // width: 0 => 256
ico[7] = 0;              // height: 0 => 256
ico[8] = 0;              // palette
ico[9] = 0;              // reserved
ico.writeUInt16LE(1, 10);   // planes
ico.writeUInt16LE(32, 12);  // bpp
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);  // offset to image data
png.copy(ico, 22);
fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico);

console.log('图标已生成：build/icon.png (512×512) + build/icon.ico');
