/**
 * 图片转换模块。
 *
 * 两条路径并存不是「为了兼容而兼容」，而是各有不可替代的理由：
 *  - 浏览器主路径（createImageBitmap / ImageDecoder + Canvas）：色彩管理、EXIF 方向、缩放滤波、
 *    JPEG/WebP/AVIF 编码全都由浏览器内核实现，质量与体积都明显更好，所以能用就用；
 *  - 纯 JS 兜底路径（Node 测试、无 DOM 环境）：没有 Canvas 时也要能给出**正确**结果，
 *    否则模块无法被自动化测试覆盖。它自己解 BMP/ICO/PNM/PNG，自己编码 PNG / BMP / ICO，
 *    缩放用双线性插值。JPEG/WebP 编码需要完整 DCT/熵编码实现，不值得手写，这条路径会明确报错而不是糊弄。
 *
 * 能力差异一律「先探测、后失败」，失败信息里带上用户能照做的下一步，不做静默降级。
 */
import { ConversionError } from './errors.js';
import { baseNameOf, clamp, extOf, mimeOfExt } from './util.js';

export const meta = {
  id: 'image',
  category: 'image',
  label: '图片',
  from: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'avif', 'heic', 'heif', 'svg', 'tiff', 'pnm'],
  to: ['png', 'jpg', 'webp', 'bmp', 'ico', 'avif'],
  priority: 90,
  options: [
    { key: 'quality', type: 'range', label: 'JPEG/WebP 质量', default: 0.9, min: 0.3, max: 1, step: 0.05 },
    { key: 'maxEdge', type: 'select', label: '最长边限制', default: '0', choices: [{ value: '0', label: '不缩放' }, { value: '4096', label: '4096 px' }, { value: '1920', label: '1920 px' }, { value: '1080', label: '1080 px' }, { value: '800', label: '800 px' }] },
    { key: 'keepTransparency', type: 'boolean', label: '保留透明（转 PNG/WebP）', default: true },
    { key: 'background', type: 'select', label: '透明区域填充色（转 JPEG 时）', default: '#ffffff', choices: [{ value: '#ffffff', label: '白' }, { value: '#000000', label: '黑' }, { value: '#f5f5f7', label: '浅灰' }] },
    { key: 'pageMode', type: 'select', label: '多帧/多页图片', default: 'first', choices: [{ value: 'first', label: '只取第一帧' }, { value: 'all', label: '全部导出为 zip' }] },
  ],
};

/** 各格式解码失败时给用户的方向；「换个浏览器」这种废话不要写 */
const DECODE_HINTS = {
  heic: 'Safari 之外的浏览器普遍无法解码 HEIC/HEIF，已尝试用 libheif-js 兜底仍未成功；请在 iPhone 相册里「分享 → 存储为 JPEG」后再转换。',
  heif: 'Safari 之外的浏览器普遍无法解码 HEIC/HEIF，已尝试用 libheif-js 兜底仍未成功；请在手机上先导出为 JPEG 再转换。',
  avif: '当前浏览器不支持 AVIF 解码；请改用较新的 Chrome / Edge / Safari 16.4+，或先用其它工具转成 PNG/JPEG。',
  tiff: '浏览器与纯 JS 兜底路径都不支持 TIFF 解码；请先用系统预览或其它工具另存为 PNG/JPEG。',
  svg: 'SVG 解码失败；请确认文件里有明确的 width/height 属性（缺少尺寸的 SVG 无法栅格化）。',
  webp: 'WebP 解码失败，文件可能已损坏。',
};

const MAX_ICO_EDGE = 256;

/* ------------------------------------------------------------------ *
 * 1. 纯 JS 位图工具（Node / 无 Canvas 环境）
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

const readU16 = (bytes, o) => bytes[o] | (bytes[o + 1] << 8);
const readI32 = (bytes, o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) | 0;
const readU32 = (bytes, o) => readI32(bytes, o) >>> 0;
// PNG 是大端（网络字节序），BMP/ICO 是小端——两套都要，混用会产出结构完全错位的文件
const readU32BE = (bytes, o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;

function writeU16(out, o, value) {
  out[o] = value & 0xff;
  out[o + 1] = (value >>> 8) & 0xff;
}

function writeU32(out, o, value) {
  out[o] = value & 0xff;
  out[o + 1] = (value >>> 8) & 0xff;
  out[o + 2] = (value >>> 16) & 0xff;
  out[o + 3] = (value >>> 24) & 0xff;
}

function writeU32BE(out, o, value) {
  out[o] = (value >>> 24) & 0xff;
  out[o + 1] = (value >>> 16) & 0xff;
  out[o + 2] = (value >>> 8) & 0xff;
  out[o + 3] = value & 0xff;
}

/** 像素缓冲的统一形状；data 一律是 RGBA，便于各编码器互换 */
function makeImage(width, height, data) {
  return { width, height, data };
}

function assertPixels(image, label) {
  const { width, height, data } = image ?? {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ConversionError('IMAGE_DECODE_FAILED', `${label}：图片宽高无效。`);
  }
  const channels = data ? data.length / (width * height) : 0;
  if (![3, 4].includes(channels)) {
    throw new ConversionError('IMAGE_DECODE_FAILED', `${label}：像素数据长度与宽高不匹配。`);
  }
  return channels;
}

/* ---------------------------- PNG 解码 ---------------------------- */

function unfilterScanlines(raw, width, height, channels) {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[offset];
    offset += 1;
    const line = out.subarray(y * stride, (y + 1) * stride);
    const raw_line = raw.subarray(offset, offset + stride);
    offset += stride;
    for (let i = 0; i < stride; i += 1) {
      const x = raw_line[i];
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let value;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: value = x + paeth(a, b, c); break;
        default: throw new ConversionError('IMAGE_DECODE_FAILED', `PNG 使用了未知的行过滤器（${filter}），文件可能已损坏。`);
      }
      line[i] = value & 0xff;
    }
    prev = line;
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

/**
 * 解 PNG（8 位、非隔行）：覆盖灰度/RGB/调色板/灰度+Alpha/RGBA 五种色彩类型。
 * 16 位与 Adam7 隔行属于长尾，交给浏览器路径，这里明确报错。
 * @param {Uint8Array} bytes
 * @param {{unzlibSync:(data:Uint8Array)=>Uint8Array}} codec
 */
export function decodePng(bytes, { unzlibSync } = {}) {
  if (typeof unzlibSync !== 'function') throw new ConversionError('IMAGE_DECODE_UNAVAILABLE', '缺少 zlib 解压实现，无法解析 PNG。');
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || signature.some((b, i) => bytes[i] !== b)) {
    throw new ConversionError('IMAGE_DECODE_FAILED', '不是有效的 PNG 文件（文件头不匹配）。');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let paletteAlpha = null;
  const idat = [];

  while (offset + 8 <= bytes.length) {
    const length = readU32BE(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const start = offset + 8;
    if (start + length > bytes.length) throw new ConversionError('IMAGE_DECODE_FAILED', 'PNG 数据不完整（块长度越界）。');
    const chunk = bytes.subarray(start, start + length);

    if (type === 'IHDR') {
      width = readU32BE(chunk, 0);
      height = readU32BE(chunk, 4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      interlace = chunk[12];
    } else if (type === 'PLTE') {
      palette = chunk;
    } else if (type === 'tRNS') {
      paletteAlpha = chunk;
    } else if (type === 'IDAT') {
      idat.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    offset = start + length + 4; // 跳过 CRC
  }

  if (!width || !height) throw new ConversionError('IMAGE_DECODE_FAILED', 'PNG 缺少 IHDR 信息。');
  if (interlace !== 0) throw new ConversionError('IMAGE_DECODE_FAILED', '暂不支持隔行（Adam7）PNG，请在浏览器中转换。');
  if (bitDepth !== 8 && !(colorType === 3 && [1, 2, 4].includes(bitDepth))) {
    throw new ConversionError('IMAGE_DECODE_FAILED', `暂不支持 ${bitDepth} 位 PNG，请在浏览器中转换。`);
  }
  if (!idat.length) throw new ConversionError('IMAGE_DECODE_FAILED', 'PNG 里没有任何图像数据。');

  const compressed = concat(idat);
  let raw;
  try {
    raw = unzlibSync(compressed);
  } catch (err) {
    throw new ConversionError('IMAGE_DECODE_FAILED', 'PNG 的压缩数据已损坏，无法解压。', { cause: err });
  }

  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (!channels) throw new ConversionError('IMAGE_DECODE_FAILED', `PNG 使用了未知色彩类型（${colorType}）。`);

  // 1/2/4 位只出现在调色板图里（上面已校验），先按位展开成 8 位再统一处理
  const scanlines = bitDepth === 8
    ? unfilterScanlines(raw, width, height, channels)
    : unfilterPacked(raw, width, height, bitDepth);
  const scanChannels = bitDepth === 8 ? channels : 1;

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * scanChannels;
    const d = i * 4;
    if (colorType === 6) {
      data[d] = scanlines[s]; data[d + 1] = scanlines[s + 1]; data[d + 2] = scanlines[s + 2]; data[d + 3] = scanlines[s + 3];
    } else if (colorType === 2) {
      data[d] = scanlines[s]; data[d + 1] = scanlines[s + 1]; data[d + 2] = scanlines[s + 2]; data[d + 3] = 255;
    } else if (colorType === 4) {
      data[d] = scanlines[s]; data[d + 1] = scanlines[s]; data[d + 2] = scanlines[s]; data[d + 3] = scanlines[s + 1];
    } else if (colorType === 0) {
      data[d] = scanlines[s]; data[d + 1] = scanlines[s]; data[d + 2] = scanlines[s]; data[d + 3] = 255;
    } else {
      if (!palette) throw new ConversionError('IMAGE_DECODE_FAILED', '调色板 PNG 缺少 PLTE 块。');
      const index = scanlines[s];
      if (index * 3 + 2 >= palette.length) throw new ConversionError('IMAGE_DECODE_FAILED', '调色板 PNG 的索引越界。');
      data[d] = palette[index * 3];
      data[d + 1] = palette[index * 3 + 1];
      data[d + 2] = palette[index * 3 + 2];
      data[d + 3] = paletteAlpha && index < paletteAlpha.length ? paletteAlpha[index] : 255;
    }
  }
  return makeImage(width, height, data);
}

function unfilterPacked(raw, width, height, bitDepth) {
  const bytesPerRow = Math.ceil((width * bitDepth) / 8);
  const out = new Uint8Array(width * height);
  let prev = new Uint8Array(bytesPerRow);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[offset];
    offset += 1;
    const line = new Uint8Array(bytesPerRow);
    for (let i = 0; i < bytesPerRow; i += 1) {
      const x = raw[offset + i];
      const a = i >= 1 ? line[i - 1] : 0;
      const b = prev[i];
      const c = i >= 1 ? prev[i - 1] : 0;
      const base = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? ((a + b) >> 1) : paeth(a, b, c);
      line[i] = (x + base) & 0xff;
    }
    offset += bytesPerRow;
    const perByte = 8 / bitDepth;
    const mask = (1 << bitDepth) - 1;
    for (let x = 0; x < width; x += 1) {
      const byte = line[Math.floor(x / perByte)];
      const shift = 8 - bitDepth * ((x % perByte) + 1);
      out[y * width + x] = (byte >> shift) & mask;
    }
    prev = line;
  }
  return out;
}

function concat(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/* ---------------------------- PNG 编码 ---------------------------- */

/**
 * 生成 PNG（IHDR / IDAT / IEND + CRC32）。
 * 行过滤器用 libpng 的「最小绝对值和」启发式自适应选择，照片类图片体积能差出一倍。
 * @param {{width:number,height:number,data:Uint8Array|Uint8ClampedArray}} image RGBA（或 RGB）像素
 * @param {{zlibSync:(data:Uint8Array)=>Uint8Array, colorType?:2|6}} options
 * @returns {Uint8Array}
 */
export function encodePng(image, { zlibSync, colorType = 6 } = {}) {
  if (typeof zlibSync !== 'function') throw new ConversionError('IMAGE_ENCODER_UNAVAILABLE', '缺少 zlib 压缩实现，无法生成 PNG。');
  const channels = assertPixels(image, 'PNG 编码');
  const { width, height, data } = image;
  const outChannels = colorType === 2 ? 3 : 4;
  const stride = width * outChannels;

  const raw = new Uint8Array((stride + 1) * height);
  const prev = new Uint8Array(stride);
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride));
  let write = 0;

  for (let y = 0; y < height; y += 1) {
    const line = new Uint8Array(stride);
    for (let x = 0; x < width; x += 1) {
      const s = (y * width + x) * channels;
      const d = x * outChannels;
      line[d] = data[s];
      line[d + 1] = data[s + 1];
      line[d + 2] = data[s + 2];
      if (outChannels === 4) line[d + 3] = channels === 4 ? data[s + 3] : 255;
    }

    let best = 0;
    let bestScore = Infinity;
    for (let type = 0; type < 5; type += 1) {
      const buffer = candidates[type];
      let score = 0;
      for (let i = 0; i < stride; i += 1) {
        const a = i >= outChannels ? line[i - outChannels] : 0;
        const b = prev[i];
        const c = i >= outChannels ? prev[i - outChannels] : 0;
        let value;
        if (type === 0) value = line[i];
        else if (type === 1) value = line[i] - a;
        else if (type === 2) value = line[i] - b;
        else if (type === 3) value = line[i] - ((a + b) >> 1);
        else value = line[i] - paeth(a, b, c);
        value &= 0xff;
        buffer[i] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        best = type;
      }
    }
    raw[write] = best;
    raw.set(candidates[best], write + 1);
    write += stride + 1;
    prev.set(line);
  }

  const ihdr = new Uint8Array(13);
  writeU32BE(ihdr, 0, width);
  writeU32BE(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = outChannels === 4 ? 6 : 2;
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlibSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

function pngChunk(type, payload) {
  const out = new Uint8Array(12 + payload.length);
  writeU32BE(out, 0, payload.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  writeU32BE(out, 8 + payload.length, crc32(out.subarray(4, 8 + payload.length)));
  return out;
}

/* ---------------------------- BMP ---------------------------- */

/**
 * 解 BMP：24/32 位未压缩为主，另支持 8 位调色板与 BI_BITFIELDS（常见于截图工具输出）。
 * RLE 压缩（1/2）是长尾，明确报错。
 * @param {Uint8Array} bytes
 * @param {{dibOnly?:boolean, heightOverride?:number, andMask?:boolean}} [options]
 *   dibOnly 供 ICO 复用（ICO 里存的是没有文件头的 DIB，高度是真实高度的两倍）。
 */
export function decodeBmp(bytes, options = {}) {
  const { dibOnly = false, heightOverride = 0, andMask = false } = options;
  const base = dibOnly ? 0 : 14;
  if (!dibOnly && (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d)) {
    throw new ConversionError('IMAGE_DECODE_FAILED', '不是有效的 BMP 文件（缺少 BM 文件头）。');
  }
  if (dibOnly && bytes.length < 40) throw new ConversionError('IMAGE_DECODE_FAILED', 'BMP 数据不完整。');

  let pixelOffset;
  let headerSize;
  if (dibOnly) {
    headerSize = readU32(bytes, 0);
    pixelOffset = headerSize;
  } else {
    pixelOffset = readU32(bytes, 10);
    headerSize = readU32(bytes, 14);
  }

  let width;
  let height;
  let bitCount;
  let compression = 0;
  let paletteCount = 0;
  if (headerSize === 12) {
    width = readU16(bytes, base + 4);
    height = readU16(bytes, base + 6);
    bitCount = readU16(bytes, base + 10);
  } else if (headerSize >= 40) {
    width = readI32(bytes, base + 4);
    height = readI32(bytes, base + 8);
    bitCount = readU16(bytes, base + 14);
    compression = readU32(bytes, base + 16);
    if (bitCount <= 8) paletteCount = readU32(bytes, base + 32);
  } else {
    throw new ConversionError('IMAGE_DECODE_FAILED', `BMP 头长度 ${headerSize} 无法识别。`);
  }

  if (heightOverride > 0) height = heightOverride;
  let topDown = false;
  if (height < 0) {
    topDown = true;
    height = -height;
  }
  if (!width || !height) throw new ConversionError('IMAGE_DECODE_FAILED', 'BMP 宽高无效，文件可能已损坏。');
  if (compression !== 0 && compression !== 3) {
    throw new ConversionError('IMAGE_DECODE_FAILED', `BMP 使用了 ${compression === 1 || compression === 2 ? 'RLE 压缩' : `压缩方式 ${compression}`}，暂不支持；请先转成 PNG。`);
  }
  if (![8, 24, 32].includes(bitCount)) {
    throw new ConversionError('IMAGE_DECODE_FAILED', `暂不支持 ${bitCount} 位 BMP（支持 8/24/32 位）。`);
  }

  const headerEnd = headerSize === 12 ? base + 12 : base + headerSize;
  const paletteOffset = headerEnd;
  const palette = new Uint8Array(bitCount === 8 ? 256 * 4 : 0);
  if (bitCount === 8) {
    const entries = paletteCount > 0 ? Math.min(paletteCount, 256) : 256;
    if (paletteOffset + entries * 4 > bytes.length) throw new ConversionError('IMAGE_DECODE_FAILED', 'BMP 调色板数据不完整。');
    for (let i = 0; i < entries; i += 1) {
      palette[i * 4] = bytes[paletteOffset + i * 4 + 2];
      palette[i * 4 + 1] = bytes[paletteOffset + i * 4 + 1];
      palette[i * 4 + 2] = bytes[paletteOffset + i * 4];
      palette[i * 4 + 3] = 255;
    }
  }

  const bytesPerPixel = bitCount / 8;
  const rowSize = Math.floor((bitCount * width + 31) / 32) * 4;
  const pixelStart = dibOnly ? pixelOffset + (bitCount === 8 ? Math.min(paletteCount || 256, 256) * 4 : 0) : pixelOffset;
  if (pixelStart + rowSize * height > bytes.length) {
    throw new ConversionError('IMAGE_DECODE_FAILED', 'BMP 像素数据不完整（文件被截断）。');
  }

  const data = new Uint8ClampedArray(width * height * 4);
  let allAlphaZero = bitCount === 32;
  for (let y = 0; y < height; y += 1) {
    const srcRow = topDown ? y : height - 1 - y;
    const rowOffset = pixelStart + srcRow * rowSize;
    for (let x = 0; x < width; x += 1) {
      const s = rowOffset + x * bytesPerPixel;
      const d = (y * width + x) * 4;
      if (bitCount === 8) {
        const index = bytes[s];
        data[d] = palette[index * 4];
        data[d + 1] = palette[index * 4 + 1];
        data[d + 2] = palette[index * 4 + 2];
        data[d + 3] = 255;
      } else {
        data[d] = bytes[s + 2];
        data[d + 1] = bytes[s + 1];
        data[d + 2] = bytes[s];
        data[d + 3] = bitCount === 32 ? bytes[s + 3] : 255;
        if (bitCount === 32 && bytes[s + 3] !== 0) allAlphaZero = false;
      }
    }
  }
  // 32 位 BI_RGB 里 Alpha 通道常被程序写成 0（Windows 约定为忽略），只有确实存在非 0 时才信任它
  if (allAlphaZero) for (let i = 3; i < data.length; i += 4) data[i] = 255;

  if (andMask) applyAndMask(data, bytes, pixelStart + rowSize * height, width, height);
  return makeImage(width, height, data);
}

/** ICO 里的 AND 掩码（1 位，行按 4 字节对齐）：置位表示透明 */
function applyAndMask(data, bytes, maskStart, width, height) {
  const maskRow = Math.floor((width + 31) / 32) * 4;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = maskStart + y * maskRow;
    if (rowOffset + maskRow > bytes.length) return; // 掩码缺失就当作全不透明，不影响主图
    for (let x = 0; x < width; x += 1) {
      const byte = bytes[rowOffset + (x >> 3)];
      if (byte === undefined) continue;
      if ((byte >> (7 - (x & 7))) & 1) data[((height - 1 - y) * width + x) * 4 + 3] = 0;
    }
  }
}

/** 24 位未压缩 BMP（自下而上，行 4 字节对齐）；Alpha 由调用方先行合成 */
export function encodeBmp(image) {
  assertPixels(image, 'BMP 编码');
  const { width, height, data } = image;
  const rowSize = Math.floor((width * 3 + 3) / 4) * 4;
  const pixelSize = rowSize * height;
  const out = new Uint8Array(54 + pixelSize);
  out[0] = 0x42;
  out[1] = 0x4d;
  writeU32(out, 2, out.length);
  writeU32(out, 10, 54);
  writeU32(out, 14, 40);
  writeU32(out, 18, width);
  writeU32(out, 22, height);
  writeU16(out, 26, 1);
  writeU16(out, 28, 24);
  writeU32(out, 34, pixelSize);
  writeU32(out, 38, 2835);
  writeU32(out, 42, 2835);
  for (let y = 0; y < height; y += 1) {
    const srcRow = height - 1 - y;
    let offset = 54 + y * rowSize;
    for (let x = 0; x < width; x += 1) {
      const s = (srcRow * width + x) * 4;
      out[offset] = data[s + 2];
      out[offset + 1] = data[s + 1];
      out[offset + 2] = data[s];
      offset += 3;
    }
  }
  return out;
}

/* ---------------------------- ICO ---------------------------- */

/** ICO 容器：单条目、内嵌 PNG（Vista 之后的标准做法，兼容性最好） */
export function encodeIco(pngBytes, width, height) {
  if (!pngBytes?.length) throw new ConversionError('IMAGE_ENCODE_FAILED', 'ICO 编码缺少 PNG 数据。');
  const out = new Uint8Array(6 + 16 + pngBytes.length);
  writeU16(out, 2, 1);
  writeU16(out, 4, 1);
  out[6] = width >= 256 ? 0 : width;
  out[7] = height >= 256 ? 0 : height;
  writeU16(out, 10, 1);
  writeU16(out, 12, 32);
  writeU32(out, 14, pngBytes.length);
  writeU32(out, 18, 22);
  out.set(pngBytes, 22);
  return out;
}

/**
 * 解 ICO。
 * @param {Uint8Array} bytes
 * @param {{unzlibSync?:Function}} [codec] 内嵌 PNG 条目需要 zlib
 */
export function decodeIco(bytes, codec = {}) {
  if (bytes.length < 22 || readU16(bytes, 0) !== 0 || readU16(bytes, 2) !== 1) {
    throw new ConversionError('IMAGE_DECODE_FAILED', '不是有效的 ICO 文件（缺少图标目录头）。');
  }
  const count = readU16(bytes, 4);
  if (!count) throw new ConversionError('IMAGE_DECODE_FAILED', 'ICO 里没有任何图像条目。');
  let best = null;
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    if (entry + 16 > bytes.length) break;
    const width = bytes[entry] === 0 ? 256 : bytes[entry];
    const height = bytes[entry + 1] === 0 ? 256 : bytes[entry + 1];
    const size = readU32(bytes, entry + 8);
    const offset = readU32(bytes, entry + 12);
    if (offset + size > bytes.length) continue;
    // 同一个图标里挑面积最大的那张：用户要的是清晰度，不是第 0 条
    if (!best || width * height > best.width * best.height) best = { width, height, size, offset };
  }
  if (!best) throw new ConversionError('IMAGE_DECODE_FAILED', 'ICO 条目数据越界，文件可能已损坏。');
  const payload = bytes.subarray(best.offset, best.offset + best.size);
  // 内嵌 PNG 已成为事实标准；老的 .ico 存的是 DIB（无文件头、高度翻倍、后跟 AND 掩码）
  if (payload.length > 8 && payload[0] === 0x89 && payload[1] === 0x50) {
    return decodePng(payload, { unzlibSync: codec.unzlibSync });
  }
  return decodeBmp(payload, { dibOnly: true, heightOverride: best.height, andMask: true });
}

/* ---------------------------- PNM ---------------------------- */

function pnmReader(bytes) {
  let pos = 0;
  const isSpace = (b) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0b || b === 0x0c;
  return {
    nextToken() {
      while (pos < bytes.length) {
        const b = bytes[pos];
        if (b === 0x23) {
          while (pos < bytes.length && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d) pos += 1;
        } else if (isSpace(b)) pos += 1;
        else break;
      }
      const start = pos;
      while (pos < bytes.length && !isSpace(bytes[pos]) && bytes[pos] !== 0x23) pos += 1;
      return String.fromCharCode(...bytes.subarray(start, pos));
    },
    /** P5/P6 的二进制数据紧跟在单个空白符之后 */
    binaryStart() {
      if (pos < bytes.length && isSpace(bytes[pos])) pos += 1;
      return pos;
    },
    get position() { return pos; },
  };
}

/** 解 PNM/PGM/PPM：P2/P3（ASCII）与 P5/P6（二进制），兼容 16 位样本 */
export function decodePnm(bytes) {
  const reader = pnmReader(bytes);
  const magic = reader.nextToken();
  if (!['P2', 'P3', 'P5', 'P6'].includes(magic)) {
    throw new ConversionError('IMAGE_DECODE_FAILED', `不是支持的 PNM 变体（只支持 P2/P3/P5/P6，收到 ${magic || '空'}）。`);
  }
  const width = Number(reader.nextToken());
  const height = Number(reader.nextToken());
  const maxval = Number(reader.nextToken());
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ConversionError('IMAGE_DECODE_FAILED', 'PNM 宽高无效。');
  }
  if (!Number.isInteger(maxval) || maxval <= 0 || maxval > 65535) {
    throw new ConversionError('IMAGE_DECODE_FAILED', `PNM 的 maxval（${maxval}）无效。`);
  }
  const isColor = magic === 'P3' || magic === 'P6';
  const data = new Uint8ClampedArray(width * height * 4);
  const scale = (value) => Math.max(0, Math.min(255, Math.round((value / maxval) * 255)));

  if (magic === 'P2' || magic === 'P3') {
    for (let i = 0; i < width * height; i += 1) {
      const g = scale(Number(reader.nextToken()));
      const r = isColor ? scale(Number(reader.nextToken())) : g;
      const b = isColor ? scale(Number(reader.nextToken())) : g;
      const d = i * 4;
      data[d] = r; data[d + 1] = g; data[d + 2] = b; data[d + 3] = 255;
    }
    return makeImage(width, height, data);
  }

  const start = reader.binaryStart();
  const samples = width * height * (isColor ? 3 : 1);
  const bytesPerSample = maxval > 255 ? 2 : 1;
  if (start + samples * bytesPerSample > bytes.length) {
    throw new ConversionError('IMAGE_DECODE_FAILED', 'PNM 像素数据不完整（文件被截断）。');
  }
  const readSample = (index) => {
    const o = start + index * bytesPerSample;
    return bytesPerSample === 2 ? (bytes[o] << 8) | bytes[o + 1] : bytes[o];
  };
  for (let i = 0; i < width * height; i += 1) {
    const base = i * (isColor ? 3 : 1);
    const g = scale(readSample(base));
    const r = isColor ? scale(readSample(base + 1)) : g;
    const b = isColor ? scale(readSample(base + 2)) : g;
    const d = i * 4;
    data[d] = r; data[d + 1] = g; data[d + 2] = b; data[d + 3] = 255;
  }
  return makeImage(width, height, data);
}

/* ---------------------------- 缩放 / 合成 ---------------------------- */

/**
 * 双线性插值缩放（带 alpha 预乘）。
 * 直接对未预乘的 RGBA 插值会在透明边缘渗出黑边，所以先乘 alpha 再还原。
 */
export function resizeBilinear(image, width, height) {
  const channels = assertPixels(image, '缩放');
  const { width: sw, height: sh, data } = image;
  if (width === sw && height === sh) return makeImage(sw, sh, data);
  const out = new Uint8ClampedArray(width * height * channels);
  const xRatio = sw / width;
  const yRatio = sh / height;
  const premultiplied = channels === 4;

  for (let y = 0; y < height; y += 1) {
    // 采样点对齐像素中心，否则整体会偏移半个像素
    const sy = clamp((y + 0.5) * yRatio - 0.5, 0, sh - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < width; x += 1) {
      const sx = clamp((x + 0.5) * xRatio - 0.5, 0, sw - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = sx - x0;
      const offsets = [
        [(y0 * sw + x0) * channels, (1 - wx) * (1 - wy)],
        [(y0 * sw + x1) * channels, wx * (1 - wy)],
        [(y1 * sw + x0) * channels, (1 - wx) * wy],
        [(y1 * sw + x1) * channels, wx * wy],
      ];
      const target = (y * width + x) * channels;
      if (premultiplied) {
        let r = 0; let g = 0; let b = 0; let a = 0;
        for (const [offset, weight] of offsets) {
          const alpha = data[offset + 3] / 255;
          r += data[offset] * alpha * weight;
          g += data[offset + 1] * alpha * weight;
          b += data[offset + 2] * alpha * weight;
          a += data[offset + 3] * weight;
        }
        const alphaOut = a / 255;
        out[target] = alphaOut > 0 ? r / alphaOut : 0;
        out[target + 1] = alphaOut > 0 ? g / alphaOut : 0;
        out[target + 2] = alphaOut > 0 ? b / alphaOut : 0;
        out[target + 3] = a;
      } else {
        for (let c = 0; c < channels; c += 1) {
          let value = 0;
          for (const [offset, weight] of offsets) value += data[offset + c] * weight;
          out[target + c] = value;
        }
      }
    }
  }
  return makeImage(width, height, out);
}

/** 把透明区域压到指定底色上（JPEG/BMP 没有 Alpha 通道，必须先合成） */
export function flattenOntoBackground(image, color) {
  const channels = assertPixels(image, '背景合成');
  if (channels !== 4) return image;
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    out[i] = data[i] * alpha + color.r * (1 - alpha);
    out[i + 1] = data[i + 1] * alpha + color.g * (1 - alpha);
    out[i + 2] = data[i + 2] * alpha + color.b * (1 - alpha);
    out[i + 3] = 255;
  }
  return makeImage(width, height, out);
}

function parseColor(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (!match) return { r: 255, g: 255, b: 255 };
  const n = Number.parseInt(match[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/* ------------------------------------------------------------------ *
 * 2. Canvas 集中入口
 *    DOM / OffscreenCanvas 只允许出现在这里，测试里替换这一个函数就能整体走纯 JS 路径。
 * ------------------------------------------------------------------ */

export function getCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (ctx) return { canvas, ctx };
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) return { canvas, ctx };
  }
  return null;
}

export async function canvasToBlob(canvas, mime, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: mime, quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob 未返回数据'))), mime, quality);
  });
}

async function canvasToBytes(canvas, mime, quality) {
  const blob = await canvasToBlob(canvas, mime, quality);
  return new Uint8Array(await blob.arrayBuffer());
}

// 能力探测按「画布实现」缓存：不同实现（真实 OffscreenCanvas / canvas 元素 / 测试桩）
// 支持的编码类型可能不同，共用一个缓存会串味
const encodeCapability = new WeakMap();

/** 编码能力探测：不支持的类型 toBlob 会悄悄退化成 PNG，必须核对返回的 MIME */
async function canEncodeMime(mime, canvasFactory) {
  let cache = encodeCapability.get(canvasFactory);
  if (!cache) {
    cache = new Map();
    encodeCapability.set(canvasFactory, cache);
  }
  if (cache.has(mime)) return cache.get(mime);
  let supported = false;
  try {
    const probe = canvasFactory(1, 1);
    if (probe) {
      probe.ctx.fillStyle = '#ffffff';
      probe.ctx.fillRect(0, 0, 1, 1);
      const blob = await canvasToBlob(probe.canvas, mime, 0.8);
      supported = blob?.type === mime;
    }
  } catch {
    supported = false;
  }
  cache.set(mime, supported);
  return supported;
}

/* ------------------------------------------------------------------ *
 * 3. 解码
 * ------------------------------------------------------------------ */

const fflateCache = new WeakMap();

/** fflate 只在纯 JS 路径真正用到时加载；浏览器路径不需要它 */
async function loadFflate(api) {
  if (fflateCache.has(api)) return fflateCache.get(api);
  const pending = (async () => {
    const loaded = await api.lib('fflate');
    const fflate = loaded?.zlibSync ? loaded : (loaded?.default ?? loaded);
    if (typeof fflate?.zlibSync !== 'function') {
      throw new ConversionError('IMAGE_ENCODER_UNAVAILABLE', '缺少 zlib 实现（fflate），无法在无 Canvas 环境里生成 PNG。');
    }
    return fflate;
  })();
  fflateCache.set(api, pending);
  return pending;
}

const isNodeRuntime = (api) =>
  api.env === 'node' ||
  (api.env === undefined && typeof document === 'undefined' && typeof createImageBitmap === 'undefined');

function decodePureJs(bytes, ext, fflate) {
  switch (ext) {
    case 'bmp': return decodeBmp(bytes);
    case 'ico': return decodeIco(bytes, fflate ?? {});
    case 'pnm': case 'ppm': case 'pgm': case 'pbm': return decodePnm(bytes);
    case 'png': return decodePng(bytes, fflate ?? {});
    default: return null;
  }
}

async function decodeWithBrowser(bytes, ext, wantAllFrames) {
  const mime = mimeOfExt(ext);
  const frames = [];

  if (wantAllFrames && typeof ImageDecoder !== 'undefined' && ext !== 'svg') {
    try {
      const decoder = new ImageDecoder({ data: bytes, type: mime });
      await decoder.completed;
      const count = decoder.tracks?.selectedTrack?.frameCount ?? 1;
      for (let i = 0; i < count; i += 1) {
        const { image } = await decoder.decode({ frameIndex: i });
        frames.push({ width: image.displayWidth, height: image.displayHeight, source: image });
      }
      decoder.close?.();
      if (frames.length) return frames;
    } catch {
      frames.length = 0; // 退回到 createImageBitmap / <img>
    }
  }

  if (ext !== 'svg' && typeof createImageBitmap === 'function') {
    const blob = new Blob([bytes], { type: mime });
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return [{ width: bitmap.width, height: bitmap.height, source: bitmap }];
    } catch {
      // 某些浏览器不接受 imageOrientation，用默认参数再试一次
      try {
        const bitmap = await createImageBitmap(blob);
        return [{ width: bitmap.width, height: bitmap.height, source: bitmap }];
      } catch {
        /* 落到 <img> 路径 */
      }
    }
  }

  if (typeof document !== 'undefined' && typeof Image !== 'undefined' && typeof URL !== 'undefined') {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    try {
      const image = new Image();
      image.src = url;
      await (typeof image.decode === 'function'
        ? image.decode()
        : new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error('图片解码失败'));
        }));
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (width && height) return [{ width, height, source: image }];
    } catch {
      return [];
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return frames;
}

async function decodeWithLibheif(bytes, api, hintKey) {
  const hint = DECODE_HINTS[hintKey] ?? DECODE_HINTS.heic;
  let libheif = await api.lib('libheif-js');
  libheif = libheif?.default ?? libheif;
  if (typeof libheif?.then === 'function') libheif = await libheif;
  if (typeof libheif?.HeifDecoder !== 'function') {
    throw new ConversionError('HEIC_DECODER_UNAVAILABLE', 'HEIC/AVIF 解码器（libheif-js）不可用；请用手机「分享 → 存储为 JPEG」或先用其它工具转换。');
  }
  let images;
  try {
    images = new libheif.HeifDecoder().decode(bytes);
  } catch (err) {
    throw new ConversionError('HEIC_DECODE_FAILED', hint, { cause: err });
  }
  const image = images?.[0];
  if (!image || typeof image.get_width !== 'function') {
    throw new ConversionError('HEIC_DECODE_FAILED', hint);
  }
  const width = image.get_width();
  const height = image.get_height();
  const data = new Uint8ClampedArray(width * height * 4);
  try {
    image.display({ data, width, height });
  } catch (err) {
    throw new ConversionError('HEIC_DECODE_FAILED', hint, { cause: err });
  } finally {
    image.free?.();
  }
  return { width, height, data };
}

/**
 * 解码成帧列表。
 * 顺序刻意为之：纯 JS 能解的格式先走纯 JS（浏览器与 Node 结果一致），
 * 其余交给浏览器，最后才是 HEIC/AVIF 的 libheif 兜底与明确报错。
 */
async function decodeSource(bytes, ext, api, wantAllFrames) {
  if (bytes.length === 0) throw new ConversionError('IMAGE_EMPTY', '图片内容为空，无法转换。');

  if (['bmp', 'ico', 'pnm', 'ppm', 'pgm', 'pbm'].includes(ext)) {
    const fflate = ext === 'ico' ? await loadFflate(api) : null;
    return { frames: [decodePureJs(bytes, ext, fflate)], via: 'pure-js' };
  }

  if (!isNodeRuntime(api)) {
    const frames = await decodeWithBrowser(bytes, ext, wantAllFrames);
    if (frames.length) return { frames, via: 'canvas' };
  }

  if (ext === 'heic' || ext === 'heif' || ext === 'avif') {
    return { frames: [await decodeWithLibheif(bytes, api, ext)], via: 'libheif' };
  }

  const fflate = await loadFflate(api);
  const image = decodePureJs(bytes, ext, fflate);
  if (image) return { frames: [image], via: 'pure-js' };

  const hint = DECODE_HINTS[ext];
  throw new ConversionError(
    'IMAGE_DECODE_UNAVAILABLE',
    hint ??
      `当前环境无法解码 ${ext ? ext.toUpperCase() : '该格式'}：浏览器缺少对应解码能力，Node 兜底路径只支持 BMP/ICO/PNM/PNG。请在浏览器中转换。`,
  );
}

/* ------------------------------------------------------------------ *
 * 4. 编码
 * ------------------------------------------------------------------ */

function drawToCanvas(ctx, source, width, height) {
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
}

/**
 * 把一帧整理成目标尺寸，并根据编码需要准备像素。
 * 浏览器里缩放交给 Canvas（内核滤波质量更好）；纯 JS 路径用双线性。
 */
function prepareFrame(frame, plan) {
  const { maxEdge, canvasFactory } = plan;
  const scale = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(frame.width, frame.height)) : 1;
  const width = Math.max(1, Math.round(frame.width * scale));
  const height = Math.max(1, Math.round(frame.height * scale));

  const target = canvasFactory(width, height);
  if (frame.source && target) {
    drawToCanvas(target.ctx, frame.source, width, height);
    return { width, height, canvas: target.canvas };
  }
  if (!frame.data) {
    throw new ConversionError('IMAGE_DECODE_UNAVAILABLE', '当前环境无法绘制该图片（缺少 Canvas 与像素数据）。');
  }
  const source = { width: frame.width, height: frame.height, data: frame.data };
  const resized = width === frame.width && height === frame.height ? source : resizeBilinear(source, width, height);
  return { width, height, data: resized.data };
}

/** 目标画布上把透明区域压成底色（JPEG 与「不保留透明」时用） */
function fillCanvasBackground(canvas, ctx, width, height, color) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

const JPEG_QUALITY_DEFAULT = 0.9;
/** 只有浏览器内核能编码的格式：纯 JS 路径不写 JPEG 的 DCT/熵编码，也没有 WebP/AVIF 编码器 */
const CANVAS_ONLY_TARGETS = new Set(['jpg', 'webp', 'avif']);

/** 像素 → 画布。ImageData 的构造同样只能出现在这一节，保持「DOM 集中在入口」的约定 */
function putPixels(ctx, data, width, height) {
  const channels = data.length / (width * height);
  const image = ctx.createImageData(width, height);
  if (channels === 4) {
    image.data.set(data);
  } else {
    // RGB 先补成 RGBA
    for (let i = 0; i < width * height; i += 1) {
      image.data[i * 4] = data[i * channels];
      image.data[i * 4 + 1] = data[i * channels + 1];
      image.data[i * 4 + 2] = data[i * channels + 2];
      image.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

/**
 * 惰性补画布。
 * 纯 JS 解码器（BMP/ICO/PNM）交出来的是像素而不是画布，但 JPEG/WebP/AVIF 必须由浏览器内核编码。
 * 少了这一步就会把「解码阶段没用到画布」误判成「当前环境没有画布」，在真浏览器里报 IMAGE_ENCODER_CANVAS_REQUIRED。
 */
function ensureCanvas(prepared, canvasFactory) {
  if (prepared.canvas) return prepared.canvas;
  if (!prepared.data) return null;
  const surface = canvasFactory(prepared.width, prepared.height);
  if (!surface) return null;
  putPixels(surface.ctx, prepared.data, prepared.width, prepared.height);
  prepared.canvas = surface.canvas;
  return surface.canvas;
}

async function encodeTarget(prepared, target, plan) {
  const { quality, keepTransparency, background, canvasFactory, fflate } = plan;
  const pixels = () => ({ width: prepared.width, height: prepared.height, data: prepared.data });

  if (CANVAS_ONLY_TARGETS.has(target)) {
    const canvas = ensureCanvas(prepared, canvasFactory);
    if (!canvas) {
      throw new ConversionError(
        'IMAGE_ENCODER_CANVAS_REQUIRED',
        `当前环境没有 Canvas，无法编码 ${target.toUpperCase()}（JPEG/WebP/AVIF 编码需要浏览器内核）；请改选 PNG，或在浏览器中转换。`,
      );
    }
    const mime = mimeOfExt(target);
    if (!(await canEncodeMime(mime, canvasFactory))) {
      throw new ConversionError(
        'IMAGE_FORMAT_UNSUPPORTED',
        `当前浏览器不支持编码 ${target.toUpperCase()}；请改选 PNG 或 JPEG。`,
      );
    }
    if (target === 'jpg' || !keepTransparency) {
      fillCanvasBackground(canvas, canvas.getContext('2d'), prepared.width, prepared.height, background);
    }
    return canvasToBytes(canvas, mime, clamp(Number(quality) || JPEG_QUALITY_DEFAULT, 0.3, 1));
  }

  if (target === 'bmp') {
    const source = prepared.canvas
      ? { width: prepared.width, height: prepared.height, data: readCanvasPixels(prepared) }
      : pixels();
    return encodeBmp(flattenOntoBackground(source, background));
  }

  // PNG / ICO 两条路都能走：解码阶段有画布就用内核编码，否则用自己的编码器（Node 与浏览器结果一致）
  if (prepared.canvas) {
    if (!keepTransparency) {
      fillCanvasBackground(prepared.canvas, prepared.canvas.getContext('2d'), prepared.width, prepared.height, background);
    }
    const pngBytes = await canvasToBytes(prepared.canvas, 'image/png');
    return target === 'ico' ? encodeIco(pngBytes, prepared.width, prepared.height) : pngBytes;
  }

  const source = keepTransparency ? pixels() : flattenOntoBackground(pixels(), background);
  const pngBytes = encodePng(source, { zlibSync: fflate.zlibSync });
  return target === 'ico' ? encodeIco(pngBytes, prepared.width, prepared.height) : pngBytes;
}

function readCanvasPixels(prepared) {
  const ctx = prepared.canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, prepared.width, prepared.height);
  return new Uint8ClampedArray(imageData.data);
}

/**
 * 把任意输入图片光栅化成 PNG 字节（只取第一帧，不缩放，保留透明）。
 * PDF 模块用它把 pdf-lib 不认识、或 pdf-lib 解析不了的图片换成可嵌入的 PNG。
 * @param {Uint8Array} bytes
 * @param {string} ext
 * @param {import('./types.js').Api} api
 * @returns {Promise<Uint8Array>}
 */
export async function toPngBytes(bytes, ext, api) {
  const canvasFactory = typeof api.getCanvas === 'function' ? api.getCanvas : getCanvas;
  const { frames } = await decodeSource(bytes, ext, api, false);
  const plan = {
    maxEdge: 0,
    canvasFactory,
    quality: 1,
    keepTransparency: true,
    background: { r: 255, g: 255, b: 255 },
  };
  const prepared = prepareFrame(frames[0], plan);
  const fflate = prepared.canvas ? null : await loadFflate(api);
  return encodeTarget(prepared, 'png', { ...plan, fflate });
}

/* ------------------------------------------------------------------ *
 * 5. convert
 * ------------------------------------------------------------------ */

/** 目标格式可能来自引擎（api.opt）、输入描述，或都不给；缺省 PNG——有损格式不该是默认值 */
function resolveTarget(api, input) {
  const explicit = api.opt('target', undefined) ?? api.opt('format', undefined) ?? input?.target ?? input?.to;
  const value = String(explicit ?? '').trim().toLowerCase().replace(/^\./, '');
  if (!value || value === 'auto') return 'png';
  return value === 'jpeg' ? 'jpg' : value;
}

function normalizeQuality(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return JPEG_QUALITY_DEFAULT;
  return clamp(n, 0.3, 1);
}

export async function convert(input, api) {
  const bytes = api.bytes();
  const sourceName = String(input?.name ?? api.input?.name ?? 'image');
  const ext = (input?.ext || api.input?.ext || extOf(sourceName) || '').toLowerCase();
  const target = resolveTarget(api, input);
  if (!meta.to.includes(target)) {
    throw new ConversionError('IMAGE_TARGET_UNSUPPORTED', `图片模块不支持输出 .${target}；可选：${meta.to.join(' / ')}。`);
  }

  const maxEdgeOption = Number(api.opt('maxEdge', '0')) || 0;
  const keepTransparency = api.opt('keepTransparency', true) !== false;
  const background = parseColor(api.opt('background', '#ffffff'));
  const pageMode = api.opt('pageMode', 'first') === 'all' ? 'all' : 'first';
  const quality = normalizeQuality(api.opt('quality', JPEG_QUALITY_DEFAULT));
  const canvasFactory = typeof api.getCanvas === 'function' ? api.getCanvas : getCanvas;

  // ICO 的规范上限是 256×256，超过就缩下去，否则图标在资源管理器里会显示不全
  let maxEdge = maxEdgeOption > 0 ? maxEdgeOption : 0;
  if (target === 'ico') maxEdge = maxEdge > 0 ? Math.min(maxEdge, MAX_ICO_EDGE) : MAX_ICO_EDGE;

  api.progress(0.05, '解码图片');
  const { frames, via } = await decodeSource(bytes, ext, api, pageMode === 'all');
  const selected = pageMode === 'all' ? frames : frames.slice(0, 1);
  const notes = [];
  // 同时走 api.note（引擎的实时提示通道）与返回值 notes（契约里的结果字段），两边都不会漏
  const addNote = (level, message) => {
    notes.push({ level, message });
    api.note?.(level, message);
  };
  let scaledNoted = false;

  if (frames.length > 1 && pageMode === 'first') {
    addNote('warn', `这张图有 ${frames.length} 帧，已只取第一帧；需要全部导出请把「多帧/多页图片」改成「全部导出」。`);
  }
  if (via === 'libheif') {
    addNote('info', '浏览器不能直接解码 HEIC/AVIF，已用 libheif-js 兜底解码。');
  }

  const results = [];
  for (let index = 0; index < selected.length; index += 1) {
    api.progress(0.1 + (index / selected.length) * 0.85, selected.length > 1 ? `转换第 ${index + 1}/${selected.length} 帧` : '转换图片');
    const plan = { maxEdge, canvasFactory, quality, keepTransparency, background };
    const prepared = prepareFrame(selected[index], plan);
    if (!scaledNoted && (prepared.width !== selected[index].width || prepared.height !== selected[index].height)) {
      addNote('info', `已缩放到 ${prepared.width}×${prepared.height}。`);
      scaledNoted = true;
    }
    // fflate 只在自家 PNG 编码器真的要跑时才加载（BMP 输出不需要）
    const needsFflate = !prepared.canvas && (target === 'png' || target === 'ico');
    const fflate = needsFflate ? await loadFflate(api) : null;
    const encoded = await encodeTarget(prepared, target, { ...plan, fflate });
    const stem = baseNameOf(sourceName) || 'image';
    const suffix = selected.length > 1 ? `-${index + 1}` : '';
    results.push({
      name: `${stem}${suffix}.${target}`,
      bytes: encoded,
      mime: mimeOfExt(target),
    });
  }

  api.progress(1, '完成');
  if (results.length > 1) {
    // 多帧按选项文案打包成 zip：几十张图逐个点下载对用户没有意义
    return {
      files: [{
        name: api.fileName(`${baseNameOf(sourceName) || 'image'}.zip`),
        bytes: api.zip(results),
        mime: 'application/zip',
      }],
      notes: notes.length ? notes : undefined,
    };
  }
  return {
    files: results.map((file) => ({ ...file, name: api.fileName(file.name) })),
    notes: notes.length ? notes : undefined,
  };
}
