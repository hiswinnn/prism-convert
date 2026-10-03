/**
 * 图片模块测试。
 * Node 环境走纯 JS 路径（api.env === 'node'），因此这里能对像素逐点断言；
 * 浏览器专属能力用 @napi-rs/canvas 冒充浏览器画布来回归「编码走 canvas」这条分支，
 * 真机（Edge/Chrome）仍需复跑一次，见文件末尾的说明。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zlibSync, unzlibSync } from 'fflate';

import { createApi } from './helpers/api-stub.mjs';
import {
  convert,
  decodeBmp,
  decodeIco,
  decodePng,
  decodePnm,
  encodeIco,
  encodePng,
  getCanvas,
  meta,
  resizeBilinear,
} from '../src/core/image.js';
import { ConversionError } from '../src/core/errors.js';

/* ------------------------------------------------------------------ *
 * fixture 现场构造（不提交二进制大文件）
 * ------------------------------------------------------------------ */

/** 2×2 分块的 4×4 测试图：每块颜色相同，缩放后的期望值是手算得出来的 */
function blockPattern() {
  const width = 4;
  const height = 4;
  const data = new Uint8ClampedArray(width * height * 4);
  const values = [
    [10, 20],
    [30, 40],
  ];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = values[y >> 1][x >> 1];
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function buildBmp(width, height, rgba, { bitCount = 24 } = {}) {
  const bytesPerPixel = bitCount / 8;
  const rowSize = Math.floor((bitCount * width + 31) / 32) * 4;
  const pixelSize = rowSize * height;
  const out = new Uint8Array(54 + pixelSize);
  const view = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(2, out.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, bitCount, true);
  view.setUint32(34, pixelSize, true);
  for (let y = 0; y < height; y += 1) {
    const srcRow = height - 1 - y;
    let offset = 54 + y * rowSize;
    for (let x = 0; x < width; x += 1) {
      const s = (srcRow * width + x) * 4;
      out[offset] = rgba[s + 2];
      out[offset + 1] = rgba[s + 1];
      out[offset + 2] = rgba[s];
      if (bitCount === 32) out[offset + 3] = rgba[s + 3];
      offset += bytesPerPixel;
    }
  }
  return out;
}

function buildPnm(width, height, rgba, { color = true, ascii = false } = {}) {
  const header = `${color ? (ascii ? 'P3' : 'P6') : (ascii ? 'P2' : 'P5')}\n${width} ${height}\n255\n`;
  const headerBytes = new TextEncoder().encode(header);
  if (ascii) {
    const values = [];
    for (let i = 0; i < width * height; i += 1) {
      values.push(rgba[i * 4]);
      if (color) values.push(rgba[i * 4 + 1], rgba[i * 4 + 2]);
    }
    const body = new TextEncoder().encode(`${values.join(' ')}\n`);
    const out = new Uint8Array(headerBytes.length + body.length);
    out.set(headerBytes);
    out.set(body, headerBytes.length);
    return out;
  }
  const samples = width * height * (color ? 3 : 1);
  const out = new Uint8Array(headerBytes.length + samples);
  out.set(headerBytes);
  let offset = headerBytes.length;
  for (let i = 0; i < width * height; i += 1) {
    out[offset] = rgba[i * 4];
    offset += 1;
    if (color) {
      out[offset] = rgba[i * 4 + 1];
      out[offset + 1] = rgba[i * 4 + 2];
      offset += 2;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * PNG 结构解析（测试自带，不复用模块实现，避免同错同对）
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function parsePng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assert.deepEqual([...bytes.subarray(0, 8)], signature, 'PNG 签名不正确');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  const idat = [];
  let header = null;
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    const storedCrc = view.getUint32(offset + 8 + length);
    assert.equal(crc32(bytes.subarray(offset + 4, offset + 8 + length)), storedCrc, `${type} 块的 CRC 不正确`);
    chunks.push(type);
    if (type === 'IHDR') {
      header = {
        width: view.getUint32(offset + 8),
        height: view.getUint32(offset + 12),
        bitDepth: payload[8],
        colorType: payload[9],
        interlace: payload[12],
      };
    }
    if (type === 'IDAT') idat.push(payload);
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return { chunks, header, idat: concatBytes(idat) };
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** 按 PNG 规范自己还原扫描行，用来验证编码器产出的 IDAT 是真能解的 */
function unfilter(raw, width, height, channels) {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[offset];
    offset += 1;
    const line = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i += 1) {
      const x = raw[offset + i];
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      const base = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? ((a + b) >> 1) : paeth(a, b, c);
      line[i] = (x + base) & 0xff;
    }
    offset += stride;
    prev = line;
  }
  return out;
}

function pngToRgba(bytes) {
  const { header, idat } = parsePng(bytes);
  const channels = header.colorType === 6 ? 4 : 3;
  const pixels = unfilter(unzlibSync(idat), header.width, header.height, channels);
  if (channels === 4) return { ...header, data: pixels };
  const rgba = new Uint8ClampedArray(header.width * header.height * 4);
  for (let i = 0; i < header.width * header.height; i += 1) {
    rgba[i * 4] = pixels[i * 3];
    rgba[i * 4 + 1] = pixels[i * 3 + 1];
    rgba[i * 4 + 2] = pixels[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return { ...header, data: rgba };
}

/** 第三方解码器交叉验证（@napi-rs/canvas 存在时才跑，不存在就跳过） */
async function loadExternalDecoder() {
  try {
    return await import('@napi-rs/canvas');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 元数据与纯 JS 解码
 * ------------------------------------------------------------------ */

test('meta 契约：id / 输入输出格式 / 选项默认值完整', () => {
  assert.equal(meta.id, 'image');
  assert.equal(meta.category, 'image');
  assert.ok(meta.from.includes('heic'));
  assert.ok(meta.to.includes('png'));
  assert.equal(meta.options.length, 5);
  for (const option of meta.options) {
    assert.ok(option.key && option.type && option.label, `选项 ${option.key} 缺少必要字段`);
    assert.ok(option.default !== undefined, `选项 ${option.key} 缺少默认值`);
  }
});

test('24 位 BMP 解码：像素与 Alpha 填充正确', () => {
  const pattern = blockPattern();
  const image = decodeBmp(buildBmp(pattern.width, pattern.height, pattern.data));
  assert.equal(image.width, 4);
  assert.equal(image.height, 4);
  assert.equal(image.data.length, 4 * 4 * 4);
  for (let i = 0; i < 16; i += 1) {
    assert.equal(image.data[i * 4], pattern.data[i * 4], `第 ${i} 个像素的 R 通道不一致`);
    assert.equal(image.data[i * 4 + 3], 255, 'BMP 无 Alpha 通道时必须填不透明');
  }
});

test('32 位 BMP：Alpha 全 0 视为不透明，存在非 0 时保留透明', () => {
  const opaque = new Uint8ClampedArray(4 * 4);
  opaque.set([1, 2, 3, 0]);
  const image = decodeBmp(buildBmp(1, 1, opaque, { bitCount: 32 }));
  assert.equal(image.data[3], 255, '32 位 BI_RGB 的 A=0 是 Windows 约定，必须当不透明处理');

  const transparent = new Uint8ClampedArray([1, 2, 3, 0, 4, 5, 6, 128]);
  const mixed = decodeBmp(buildBmp(2, 1, transparent, { bitCount: 32 }));
  assert.equal(mixed.data[3], 0);
  assert.equal(mixed.data[7], 128);
});

test('PNM 解码：P5 / P6 / P3 都能解出同一张图', () => {
  const pattern = blockPattern();
  const expected = (i) => pattern.data[i * 4];
  for (const options of [{}, { ascii: true }]) {
    const p6 = decodePnm(buildPnm(4, 4, pattern.data, { ...options, color: true }));
    assert.equal(p6.width, 4);
    for (let i = 0; i < 16; i += 1) assert.equal(p6.data[i * 4], expected(i), `P6${options.ascii ? '(ascii)' : ''} 第 ${i} 像素不一致`);

    const p5 = decodePnm(buildPnm(4, 4, pattern.data, { ...options, color: false }));
    for (let i = 0; i < 16; i += 1) assert.equal(p5.data[i * 4], expected(i), `P5 第 ${i} 像素不一致`);
  }
});

test('PNG 编码：签名 / IHDR / CRC 正确，IDAT 解压后像素逐点一致', () => {
  const pattern = blockPattern();
  const png = encodePng(pattern, { zlibSync });
  const parsed = parsePng(png);
  assert.deepEqual(parsed.chunks.slice(0, 3), ['IHDR', 'IDAT', 'IEND']);
  assert.equal(parsed.header.width, 4);
  assert.equal(parsed.header.height, 4);
  assert.equal(parsed.header.bitDepth, 8);
  assert.equal(parsed.header.colorType, 6);
  assert.equal(parsed.header.interlace, 0);

  const decoded = pngToRgba(png);
  assert.deepEqual([...decoded.data], [...pattern.data], 'IDAT 还原出的像素与原始像素不一致');
});

test('PNG 编码：RGB（colorType=2）输出与原图颜色一致', () => {
  const pattern = blockPattern();
  const png = encodePng(pattern, { zlibSync, colorType: 2 });
  const parsed = parsePng(png);
  assert.equal(parsed.header.colorType, 2);
  const decoded = pngToRgba(png);
  for (let i = 0; i < 16; i += 1) {
    assert.deepEqual(
      [...decoded.data.subarray(i * 4, i * 4 + 3)],
      [...pattern.data.subarray(i * 4, i * 4 + 3)],
    );
  }
});

test('PNG 自解码（纯 JS）：能解回自己编码的图', () => {
  const pattern = blockPattern();
  const png = encodePng(pattern, { zlibSync });
  const decoded = decodePng(png, { unzlibSync });
  assert.equal(decoded.width, 4);
  assert.deepEqual([...decoded.data], [...pattern.data]);
});

test('PNG 解码：拒绝损坏与不支持的变体', () => {
  assert.throws(
    () => decodePng(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8), { unzlibSync }),
    (err) => err instanceof ConversionError && err.code === 'IMAGE_DECODE_FAILED',
  );
  const png = encodePng(blockPattern(), { zlibSync });
  // 截断 IDAT：压缩流不完整必须报错，而不是给出半张图
  assert.throws(
    () => decodePng(png.subarray(0, Math.floor(png.length / 2)), { unzlibSync }),
    (err) => err instanceof ConversionError,
  );
});

test('双线性缩放：2×2 分块图缩到一半后每块颜色取四像素均值', () => {
  const scaled = resizeBilinear(blockPattern(), 2, 2);
  assert.equal(scaled.width, 2);
  assert.equal(scaled.height, 2);
  assert.deepEqual([...scaled.data.filter((_, i) => i % 4 === 0)], [10, 20, 30, 40]);
  assert.deepEqual([...scaled.data.filter((_, i) => i % 4 === 3)], [255, 255, 255, 255]);
});

/* ------------------------------------------------------------------ *
 * convert：正常路径
 * ------------------------------------------------------------------ */

test('BMP → PNG：文件结构、像素、文件名都正确', async () => {
  const pattern = blockPattern();
  const api = createApi({
    name: '照片.bmp',
    bytes: buildBmp(4, 4, pattern.data),
    options: { target: 'png' },
  });
  const result = await convert(api.input, api);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, '照片.png');
  assert.equal(result.files[0].mime, 'image/png');
  const decoded = pngToRgba(result.files[0].bytes);
  assert.equal(decoded.width, 4);
  assert.deepEqual([...decoded.data], [...pattern.data]);
  assert.ok(api.__progress.at(-1).ratio === 1, '进度必须收尾到 1');
});

test('PPM → PNG，且 maxEdge=2 时按最长边等比缩放', async () => {
  const pattern = blockPattern();
  const api = createApi({
    name: 'gradient.ppm',
    bytes: buildPnm(4, 4, pattern.data),
    options: { target: 'png', maxEdge: '2' },
  });
  const result = await convert(api.input, api);
  const decoded = pngToRgba(result.files[0].bytes);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.deepEqual([...decoded.data.filter((_, i) => i % 4 === 0)], [10, 20, 30, 40]);
  assert.ok(api.__notes.some((note) => note.message.includes('已缩放')), '缩放后必须有提示');
});

test('缩放尺寸：非整数比例按四舍五入取整，且不会缩到 0', async () => {
  const pattern = blockPattern();
  const api = createApi({
    name: 'a.ppm',
    bytes: buildPnm(4, 4, pattern.data),
    options: { target: 'png', maxEdge: '3' },
  });
  const result = await convert(api.input, api);
  const decoded = pngToRgba(result.files[0].bytes);
  assert.equal(decoded.width, 3);
  assert.equal(decoded.height, 3);
});

test('PNG → PNG 往返（纯 JS 解码 + 编码）保持像素', async () => {
  const pattern = blockPattern();
  const source = encodePng(pattern, { zlibSync });
  const api = createApi({ name: 'source.png', bytes: source, options: { target: 'png' } });
  const result = await convert(api.input, api);
  const decoded = pngToRgba(result.files[0].bytes);
  assert.deepEqual([...decoded.data], [...pattern.data]);
});

test('转 BMP：输出是 24 位未压缩 BMP 且能解回原像素', async () => {
  const pattern = blockPattern();
  const api = createApi({ name: 'photo.png', bytes: encodePng(pattern, { zlibSync }), options: { target: 'bmp' } });
  const result = await convert(api.input, api);
  assert.equal(result.files[0].name, 'photo.bmp');
  assert.equal(result.files[0].bytes[0], 0x42);
  const decoded = decodeBmp(result.files[0].bytes);
  assert.deepEqual([...decoded.data], [...pattern.data]);
});

test('转 ICO：超过 256px 会被压到 256，内嵌 PNG 可解回', async () => {
  const width = 300;
  const height = 100;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = i % 251;
    data[i * 4 + 1] = 40;
    data[i * 4 + 2] = 90;
    data[i * 4 + 3] = 255;
  }
  const api = createApi({ name: 'logo.ppm', bytes: buildPnm(width, height, data), options: { target: 'ico' } });
  const result = await convert(api.input, api);
  const ico = result.files[0].bytes;
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  assert.equal(view.getUint16(2, true), 1, 'ICO 目录类型应为 1');
  assert.equal(view.getUint16(4, true), 1, '应只有一个图标条目');
  assert.equal(ico[6], 0, '256 宽度在 ICO 里记作 0');
  assert.equal(ico[7], 85);
  const parsed = parsePng(ico.subarray(view.getUint32(18, true)));
  assert.equal(parsed.header.width, 256);
  assert.equal(parsed.header.height, 85);
  assert.equal(parsed.header.colorType, 6);
});

/** 组装一个多条目 ICO，用来验证解码器的条目选择策略 */
function buildIco(entries) {
  const headerSize = 6 + entries.length * 16;
  const out = new Uint8Array(headerSize + entries.reduce((sum, entry) => sum + entry.png.length, 0));
  const view = new DataView(out.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, entries.length, true);
  let offset = headerSize;
  entries.forEach((entry, index) => {
    const p = 6 + index * 16;
    out[p] = entry.width >= 256 ? 0 : entry.width;
    out[p + 1] = entry.height >= 256 ? 0 : entry.height;
    view.setUint16(p + 4, 1, true);
    view.setUint16(p + 6, 32, true);
    view.setUint32(p + 8, entry.png.length, true);
    view.setUint32(p + 12, offset, true);
    out.set(entry.png, offset);
    offset += entry.png.length;
  });
  return out;
}

test('ICO 解码：优先取面积最大的条目', () => {
  const small = encodePng({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(200) }, { zlibSync });
  const big = encodePng({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(100) }, { zlibSync });
  const combined = buildIco([
    { width: 2, height: 2, png: small },
    { width: 4, height: 4, png: big },
  ]);
  const decoded = decodeIco(combined, { unzlibSync });
  assert.equal(decoded.width, 4, '应当挑选面积最大的图标条目');
  assert.equal(decoded.height, 4);
  assert.equal(decoded.data[0], 100);
});

test('pageMode=all 对单帧图片仍只产出一个文件', async () => {
  const pattern = blockPattern();
  const api = createApi({
    name: 'still.bmp',
    bytes: buildBmp(4, 4, pattern.data),
    options: { target: 'png', pageMode: 'all' },
  });
  const result = await convert(api.input, api);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, 'still.png');
  assert.equal(result.files[0].mime, 'image/png');
});

test('保留透明开关：keepTransparency=false 时把透明压成背景色', async () => {
  const data = new Uint8ClampedArray([255, 0, 0, 0, 0, 0, 255, 255]);
  const api = createApi({
    name: 'alpha.png',
    bytes: encodePng({ width: 2, height: 1, data }, { zlibSync }),
    options: { target: 'png', keepTransparency: false, background: '#000000' },
  });
  const result = await convert(api.input, api);
  const decoded = pngToRgba(result.files[0].bytes);
  assert.deepEqual([...decoded.data.subarray(0, 4)], [0, 0, 0, 255], '透明像素应被压成黑色');
  assert.deepEqual([...decoded.data.subarray(4, 8)], [0, 0, 255, 255], '不透明像素不应改变');
});

/* ------------------------------------------------------------------ *
 * convert：错误路径与降级
 * ------------------------------------------------------------------ */

test('空输入抛 IMAGE_EMPTY', async () => {
  const api = createApi({ name: 'empty.bmp', bytes: new Uint8Array(0), options: { target: 'png' } });
  await assert.rejects(convert(api.input, api), (err) => err instanceof ConversionError && err.code === 'IMAGE_EMPTY');
});

test('坏 BMP 数据抛 IMAGE_DECODE_FAILED 而不是别的异常', async () => {
  const broken = new Uint8Array(200);
  broken.fill(0x37);
  const api = createApi({ name: 'broken.bmp', bytes: broken, options: { target: 'png' } });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError, '必须是 ConversionError');
    assert.equal(err.code, 'IMAGE_DECODE_FAILED');
    assert.ok(err.message.length > 0);
    return true;
  });
});

test('截断的 BMP 抛错且信息可读', async () => {
  const pattern = blockPattern();
  const full = buildBmp(4, 4, pattern.data);
  const api = createApi({ name: 'cut.bmp', bytes: full.subarray(0, 60), options: { target: 'png' } });
  await assert.rejects(convert(api.input, api), (err) => err instanceof ConversionError);
});

test('不支持的目标格式抛 IMAGE_TARGET_UNSUPPORTED', async () => {
  const pattern = blockPattern();
  const api = createApi({ name: 'a.bmp', bytes: buildBmp(4, 4, pattern.data), options: { target: 'tiff' } });
  await assert.rejects(convert(api.input, api), (err) => err instanceof ConversionError && err.code === 'IMAGE_TARGET_UNSUPPORTED');
});

test('Node 环境请求 JPEG：报 IMAGE_ENCODER_CANVAS_REQUIRED，不抛 TypeError', async () => {
  const pattern = blockPattern();
  const api = createApi({ name: 'photo.bmp', bytes: buildBmp(4, 4, pattern.data), options: { target: 'jpg' } });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.equal(err.code, 'IMAGE_ENCODER_CANVAS_REQUIRED');
    assert.match(err.message, /Canvas/);
    return true;
  });
});

test('Node 环境请求 WebP / AVIF 同样给出明确失败提示', async () => {
  const pattern = blockPattern();
  for (const target of ['webp', 'avif']) {
    const api = createApi({ name: 'photo.ppm', bytes: buildPnm(4, 4, pattern.data), options: { target } });
    await assert.rejects(convert(api.input, api), (err) => err instanceof ConversionError && err.code === 'IMAGE_ENCODER_CANVAS_REQUIRED');
  }
});

test('Node 环境解码 JPEG：抛受控错误，而不是未捕获异常', async () => {
  const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46);
  const api = createApi({ name: 'x.jpg', bytes: jpeg, options: { target: 'png' } });
  await assert.rejects(convert(api.input, api), (err) => err instanceof ConversionError && err.code === 'IMAGE_DECODE_UNAVAILABLE');
});

test('TIFF / WebP 等没有解码器的格式：错误信息里带可执行的下一步', async () => {
  const api = createApi({ name: 'scan.tiff', bytes: Uint8Array.of(0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4), options: { target: 'png' } });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.match(err.message, /TIFF/);
    return true;
  });
});

test('没有 Canvas 时 getCanvas 返回 null，convert 不会因 DOM 缺失崩溃', () => {
  assert.equal(getCanvas(2, 2), null, 'Node 环境不应造出 Canvas');
});

test('注入 api.getCanvas = null 的桩（模拟无 Canvas 环境）仍走纯 JS 路径', async () => {
  const pattern = blockPattern();
  const api = createApi({
    name: 'mock.bmp',
    bytes: buildBmp(4, 4, pattern.data),
    options: { target: 'png' },
    getCanvas: () => null,
  });
  const result = await convert(api.input, api);
  assert.deepEqual([...pngToRgba(result.files[0].bytes).data], [...pattern.data]);
});

/* ------------------------------------------------------------------ *
 * 浏览器分支：用 @napi-rs/canvas 冒充浏览器画布
 *
 * 真机的 OffscreenCanvas 在 Node 里造不出来，但「编码必须走 canvas」这条分支的
 * 判定逻辑（惰性补画布、能力探测、底色合成、缩放）可以在这里回归。
 * 这里专门覆盖一个真实缺陷：纯 JS 解码器（BMP/ICO/PNM）交出来的是像素而不是画布，
 * 早期实现据此判定「环境没有 Canvas」，导致浏览器里 BMP → JPEG 直接报错。
 * ------------------------------------------------------------------ */

async function makeBrowserCanvas() {
  const sketch = await import('@napi-rs/canvas');
  const factory = (width, height) => {
    const canvas = sketch.createCanvas(width, height);
    // 注意：@napi-rs/canvas 自带 convertToBlob/toBlob，但它无视 type 一律返回 PNG，
    // 与浏览器行为不同，必须两个都覆盖掉（覆盖 toBlob 不够——canvasToBlob 优先用 convertToBlob）
    const encode = (type = 'image/png', quality) => {
      try {
        return {
          bytes: canvas.toBuffer(type, typeof quality === 'number' ? Math.round(quality * 100) : undefined),
          type,
        };
      } catch {
        // 浏览器遇到不支持的编码类型会静默产出 PNG，这里照抄该语义，好让能力探测有东西可测
        return { bytes: canvas.toBuffer('image/png'), type: 'image/png' };
      }
    };
    canvas.convertToBlob = async ({ type, quality } = {}) => {
      const encoded = encode(type, quality);
      return new Blob([encoded.bytes], { type: encoded.type });
    };
    canvas.toBlob = (callback, type, quality) => {
      const encoded = encode(type, quality);
      callback(new Blob([encoded.bytes], { type: encoded.type }));
    };
    return { canvas, ctx: canvas.getContext('2d') };
  };
  factory.sketch = sketch;
  return factory;
}

/** 把编码结果读回像素，验证「出的是真图」而不只是字节非空 */
async function readBackPixels(sketch, bytes) {
  const image = await sketch.loadImage(Buffer.from(bytes));
  const canvas = sketch.createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data };
}

test('浏览器分支：纯 JS 解码出的 BMP → JPEG 能出图（不得误判为没有 Canvas）', async (t) => {
  const external = await loadExternalDecoder();
  if (!external) {
    t.skip('未安装 @napi-rs/canvas，跳过浏览器分支回归');
    return;
  }
  const pattern = blockPattern();
  const getCanvasStub = await makeBrowserCanvas();
  const api = createApi({
    name: 'bmp-photo.bmp',
    bytes: buildBmp(4, 4, pattern.data),
    options: { target: 'jpg', quality: 0.9 },
    env: 'browser',
    getCanvas: getCanvasStub,
  });
  const result = await convert(api.input, api);
  assert.equal(result.files[0].mime, 'image/jpeg', 'MIME 必须是 image/jpeg，不能悄悄退化成 PNG');
  assert.deepEqual([...result.files[0].bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], 'JPEG 的 SOI 标记不对');
  const readBack = await readBackPixels(getCanvasStub.sketch, result.files[0].bytes);
  assert.equal(readBack.width, 4);
  assert.equal(readBack.height, 4);
  assert.ok(Math.abs(readBack.data[0] - 10) <= 6, `左上角像素应接近 10，实际 ${readBack.data[0]}`);
});

test('浏览器分支：BMP → WebP / AVIF 也是真编码，不是退化的 PNG', async (t) => {
  const external = await loadExternalDecoder();
  if (!external) {
    t.skip('未安装 @napi-rs/canvas，跳过浏览器分支回归');
    return;
  }
  const pattern = blockPattern();
  const getCanvasStub = await makeBrowserCanvas();

  const webpApi = createApi({
    name: 'a.bmp',
    bytes: buildBmp(4, 4, pattern.data),
    options: { target: 'webp' },
    env: 'browser',
    getCanvas: getCanvasStub,
  });
  const webp = await convert(webpApi.input, webpApi);
  assert.equal(webp.files[0].mime, 'image/webp');
  assert.equal(String.fromCharCode(...webp.files[0].bytes.subarray(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...webp.files[0].bytes.subarray(8, 12)), 'WEBP');

  const avifApi = createApi({
    name: 'a.bmp',
    bytes: buildBmp(4, 4, pattern.data),
    options: { target: 'avif' },
    env: 'browser',
    getCanvas: getCanvasStub,
  });
  const avif = await convert(avifApi.input, avifApi);
  assert.equal(avif.files[0].mime, 'image/avif');
  assert.equal(String.fromCharCode(...avif.files[0].bytes.subarray(4, 8)), 'ftyp', 'AVIF 缺少 ftyp box');
});

test('浏览器分支：透明 PNG → JPEG 时按 background 填底色', async (t) => {
  const external = await loadExternalDecoder();
  if (!external) {
    t.skip('未安装 @napi-rs/canvas，跳过浏览器分支回归');
    return;
  }
  // 左半透明、右半不透明的红块。图必须够宽：JPEG 的色度是 2×2 下采样，
  // 贴着交界处的像素颜色会被邻块平均掉，所以只断言离交界足够远的列
  const width = 8;
  const height = 4;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const opaque = x >= width / 2;
      data[i] = opaque ? 255 : 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = opaque ? 255 : 0;
    }
  }
  const getCanvasStub = await makeBrowserCanvas();
  const api = createApi({
    name: 'alpha.png',
    bytes: encodePng({ width, height, data }, { zlibSync }),
    options: { target: 'jpg', background: '#ffffff' },
    env: 'browser',
    getCanvas: getCanvasStub,
  });
  const result = await convert(api.input, api);
  assert.equal(result.files[0].mime, 'image/jpeg');
  const readBack = await readBackPixels(getCanvasStub.sketch, result.files[0].bytes);
  const transparentEdge = [...readBack.data.subarray(0, 3)];
  const opaqueEdge = [...readBack.data.subarray((width - 1) * 4, (width - 1) * 4 + 3)];
  assert.ok(transparentEdge.every((v) => v > 230), `透明像素应填成白色，实际 ${transparentEdge}`);
  assert.ok(opaqueEdge[0] > 230 && opaqueEdge[1] < 30 && opaqueEdge[2] < 30, `不透明像素应保持红色，实际 ${opaqueEdge}`);
});

test('浏览器分支：maxEdge 缩放后 JPEG 尺寸正确', async (t) => {
  const external = await loadExternalDecoder();
  if (!external) {
    t.skip('未安装 @napi-rs/canvas，跳过浏览器分支回归');
    return;
  }
  const pattern = blockPattern();
  const getCanvasStub = await makeBrowserCanvas();
  const api = createApi({
    name: 'big.bmp',
    bytes: buildBmp(4, 4, pattern.data),
    options: { target: 'jpg', maxEdge: '2' },
    env: 'browser',
    getCanvas: getCanvasStub,
  });
  const result = await convert(api.input, api);
  const readBack = await readBackPixels(getCanvasStub.sketch, result.files[0].bytes);
  assert.equal(readBack.width, 2);
  assert.equal(readBack.height, 2);
});

test('浏览器分支：不支持的类型抛 IMAGE_FORMAT_UNSUPPORTED（探测到退化就明确失败）', async () => {
  const pattern = blockPattern();
  // 模拟「有 Canvas 但没有 JPEG 编码器」的浏览器：任何请求都退回 PNG（浏览器规范就是这样）
  const pngOnlyFactory = (width, height) => {
    const ctx = {
      fillStyle: '#000000',
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData() {},
      fillRect() {},
      save() {},
      restore() {},
      set globalCompositeOperation(value) { this.__op = value; },
      get globalCompositeOperation() { return this.__op; },
    };
    return {
      canvas: { width, height, getContext: () => ctx, convertToBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) },
      ctx,
    };
  };
  const api = createApi({
    name: 'x.bmp',
    bytes: buildBmp(4, 4, pattern.data),
    options: { target: 'jpg' },
    env: 'browser',
    getCanvas: pngOnlyFactory,
  });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.equal(err.code, 'IMAGE_FORMAT_UNSUPPORTED');
    return true;
  });
});

/* ------------------------------------------------------------------ *
 * 第三方交叉验证
 * ------------------------------------------------------------------ */

test('交叉验证：第三方解码器（@napi-rs/canvas）能读回我们编码的 PNG', async (t) => {
  const external = await loadExternalDecoder();
  if (!external) {
    t.skip('未安装 @napi-rs/canvas，跳过第三方 PNG 交叉验证');
    return;
  }
  const pattern = blockPattern();
  const png = encodePng(pattern, { zlibSync });
  const image = await external.loadImage(Buffer.from(png));
  assert.equal(image.width, 4);
  assert.equal(image.height, 4);
  const canvas = external.createCanvas(4, 4);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, 4, 4).data;
  assert.deepEqual([...pixels].map((v, i) => (i % 4 === 3 ? 255 : v)), [...pattern.data]);
});

test('交叉验证：我们的解码器能读第三方编码器产出的 PNG', async (t) => {
  const external = await loadExternalDecoder();
  if (!external) {
    t.skip('未安装 @napi-rs/canvas，跳过第三方 PNG 交叉验证');
    return;
  }
  const canvas = external.createCanvas(3, 2);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(0, 0, 3, 1);
  ctx.fillStyle = '#cc3366';
  ctx.fillRect(0, 1, 3, 1);
  const png = new Uint8Array(canvas.toBuffer('image/png'));
  const decoded = decodePng(png, { unzlibSync });
  assert.equal(decoded.width, 3);
  assert.equal(decoded.height, 2);
  assert.deepEqual([...decoded.data.subarray(0, 4)], [0x33, 0x66, 0xcc, 255]);
  assert.deepEqual([...decoded.data.subarray(12, 16)], [0xcc, 0x33, 0x66, 255]);
});
