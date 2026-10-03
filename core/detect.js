/**
 * 文件类型识别：先看magic bytes，再看文本特征。
 * 扩展名不可信（手机上传、微信转发经常丢失或改名），所以一切以内容为准。
 */
import { ConversionError } from './errors.js';
import { loadLib } from './lib-loader.js';
import { looksLikeText } from './text-heuristics.js';

const MAGIC = [
  { ext: 'png', mime: 'image/png', family: 'image', label: 'PNG 图片', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg', mime: 'image/jpeg', family: 'image', label: 'JPEG 图片', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'gif', mime: 'image/gif', family: 'image', label: 'GIF 动图', bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'bmp', mime: 'image/bmp', family: 'image', label: 'BMP 位图', bytes: [0x42, 0x4d] },
  { ext: 'ico', mime: 'image/x-icon', family: 'image', label: 'ICO 图标', bytes: [0x00, 0x00, 0x01, 0x00] },
  { ext: 'pdf', mime: 'application/pdf', family: 'pdf', label: 'PDF 文档', bytes: [0x25, 0x50, 0x44, 0x46] },
  // 注意：ZIP 头（PK）不能放在这张快速表里——docx/xlsx/epub 都是 zip 容器，
  // 必须走 inspectZip 看内部目录结构，否则一律被认成「ZIP 压缩包」。
  { ext: 'gz', mime: 'application/gzip', family: 'archive', label: 'GZIP 压缩', bytes: [0x1f, 0x8b] },
  { ext: '7z', mime: 'application/x-7z-compressed', family: 'archive', label: '7-Zip 压缩包', bytes: [0x37, 0x7a, 0xbc, 0xaf] },
  { ext: 'rar', mime: 'application/vnd.rar', family: 'archive', label: 'RAR 压缩包', bytes: [0x52, 0x61, 0x72, 0x21] },
  // RIFF 容器：'RIFF' + 4 字节长度 + 'WAVE'/'AVI '，所以格式标识在偏移 8，不是 4
  { ext: 'wav', mime: 'audio/wav', family: 'media', label: 'WAV 音频', bytes: [0x52, 0x49, 0x46, 0x46], offset8: [0x57, 0x41, 0x56, 0x45] },
  { ext: 'avi', mime: 'video/x-msvideo', family: 'media', label: 'AVI 视频', bytes: [0x52, 0x49, 0x46, 0x46], offset8: [0x41, 0x56, 0x49, 0x20] },
  { ext: 'flac', mime: 'audio/flac', family: 'media', label: 'FLAC 无损音频', bytes: [0x66, 0x4c, 0x61, 0x43] },
  { ext: 'ogg', mime: 'audio/ogg', family: 'media', label: 'OGG 音频', bytes: [0x4f, 0x67, 0x67, 0x53] },
  { ext: 'mp3', mime: 'audio/mpeg', family: 'media', label: 'MP3 音频', bytes: [0x49, 0x44, 0x33] },
  { ext: 'mkv', mime: 'video/x-matroska', family: 'media', label: 'Matroska 视频', bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { ext: 'ttf', mime: 'font/ttf', family: 'font', label: 'TrueType 字体', bytes: [0x00, 0x01, 0x00, 0x00] },
  { ext: 'otf', mime: 'font/otf', family: 'font', label: 'OpenType 字体', bytes: [0x4f, 0x54, 0x54, 0x4f] },
  { ext: 'woff', mime: 'font/woff', family: 'font', label: 'WOFF 字体', bytes: [0x77, 0x4f, 0x46, 0x46] },
  { ext: 'sqlite', mime: 'application/vnd.sqlite3', family: 'binary', label: 'SQLite 数据库', bytes: [0x53, 0x51, 0x4c, 0x69] },
  { ext: 'wasm', mime: 'application/wasm', family: 'binary', label: 'WebAssembly 模块', bytes: [0x00, 0x61, 0x73, 0x6d] },
  { ext: 'class', mime: 'application/java-vm', family: 'binary', label: 'Java class', bytes: [0xca, 0xfe, 0xba, 0xbe] },
];

function startsWith(data, pattern, offset = 0) {
  if (data.length < offset + pattern.length) return false;
  for (let i = 0; i < pattern.length; i += 1) {
    if (data[offset + i] !== pattern[i]) return false;
  }
  return true;
}

function asciiAt(data, offset, length) {
  let out = '';
  for (let i = 0; i < length && offset + i < data.length; i += 1) out += String.fromCharCode(data[offset + i]);
  return out;
}

/** ISO-BMFF（mp4/mov/heic/avif）统一在偏移 4 处有 ftyp box */
function inspectFtyp(data) {
  if (asciiAt(data, 4, 4) !== 'ftyp') return null;
  const brand = asciiAt(data, 8, 4).trim();
  const compatible = asciiAt(data, 16, 24);
  const brandTable = {
    heic: 'image/heic', heix: 'image/heic', hevc: 'image/heic', heim: 'image/heic',
    heis: 'image/heic', mif1: 'image/heif', msf1: 'image/heif',
    avif: 'image/avif', avis: 'image/avif',
    mp4: 'video/mp4', isom: 'video/mp4', iso2: 'video/mp4', mp41: 'video/mp4', mp42: 'video/mp4',
    dash: 'video/mp4', M4V: 'video/mp4', M4A: 'audio/mp4', 'qt': 'video/quicktime',
    '3gp4': 'video/3gpp', '3gp5': 'video/3gpp',
  };
  const isHeicFamily = ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis'].includes(brand);
  const mime = brandTable[brand] ?? (isHeicFamily ? 'image/heic' : 'video/mp4');
  const ext = isHeicFamily
    ? (mime === 'image/avif' ? 'avif' : (mime === 'image/heif' ? 'heif' : 'heic'))
    : (mime === 'audio/mp4' ? 'm4a' : (mime === 'video/quicktime' ? 'mov' : (mime.startsWith('video/3gpp') ? '3gp' : 'mp4')));
  const family = mime.startsWith('audio') ? 'media' : (mime.startsWith('image') ? 'image' : 'media');
  return { ext, mime, family, label: `${brand} 容器 (${mime})`, detail: { brand, compatible: compatible.trim() } };
}

async function inspectZip(data) {
  const { unzipSync } = await loadLib('fflate');
  let entries;
  try {
    entries = Object.keys(unzipSync(data, { filter: () => true }) ?? {});
  } catch {
    return { ext: 'zip', mime: 'application/zip', family: 'zip', label: 'ZIP 压缩包', confidence: 0.6 };
  }
  const names = entries.map((n) => n.toLowerCase());
  if (names.includes('mimetype') || names.some((n) => n.startsWith('meta-inf/container.xml'))) {
    return { ext: 'epub', mime: 'application/epub+zip', family: 'document', label: 'EPUB 电子书', detail: { entries: names.length } };
  }
  if (names.some((n) => n.startsWith('word/'))) {
    return { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', family: 'document', label: 'Word 文档 (docx)', detail: { entries: names.length } };
  }
  if (names.some((n) => n.startsWith('xl/'))) {
    return { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', family: 'table', label: 'Excel 工作簿 (xlsx)', detail: { entries: names.length } };
  }
  if (names.some((n) => n.startsWith('ppt/'))) {
    return { ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', family: 'document', label: 'PowerPoint (pptx)', detail: { entries: names.length } };
  }
  if (names.some((n) => n === 'mimetype' || n.endsWith('.odt'))) {
    return { ext: 'odt', mime: 'application/vnd.oasis.opendocument.text', family: 'document', label: 'OpenDocument 文本', detail: { entries: names.length } };
  }
  return { ext: 'zip', mime: 'application/zip', family: 'zip', label: 'ZIP 压缩包', detail: { entries: names.length } };
}

/**
 * 识别文件类型。
 * @param {Uint8Array} bytes
 * @param {string} [name] 原始文件名，仅在内容无法判定时作为兜底参考
 * @returns {Promise<{ext:string, mime:string, family:string, label:string, confidence:number, detail?:object}>}
 */
export async function detectType(bytes, name = '') {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length === 0) {
    return { ext: 'bin', mime: 'application/octet-stream', family: 'binary', label: '空文件', confidence: 0.2 };
  }

  for (const rule of MAGIC) {
    if (!startsWith(data, rule.bytes)) continue;
    if (rule.offset8 && !startsWith(data, rule.offset8, 8)) continue;
    return { ext: rule.ext, mime: rule.mime, family: rule.family, label: rule.label, confidence: 0.99 };
  }

  const ftyp = inspectFtyp(data);
  if (ftyp) return { ...ftyp, confidence: 0.97 };

  if (startsWith(data, [0x50, 0x4b])) return { ...(await inspectZip(data)), confidence: 0.95 };

  if (startsWith(data, [0x25, 0x21]) || startsWith(data, [0x7b, 0x5c, 0x72, 0x74, 0x66])) {
    return { ext: 'rtf', mime: 'application/rtf', family: 'document', label: 'RTF 富文本', confidence: 0.9 };
  }

  if (startsWith(data, [0x1f, 0x8b])) {
    const { gunzipSync } = await loadLib('fflate');
    try {
      const inner = gunzipSync(data);
      const innerType = await detectType(inner, name.replace(/\.(gz|tgz)$/i, ''));
      if (innerType.ext === 'tar') return { ext: 'tar', mime: 'application/x-tar', family: 'archive', label: 'TAR 归档', confidence: 0.85 };
      return { ext: 'gz', mime: 'application/gzip', family: 'archive', label: `GZIP（内含 ${innerType.label}）`, confidence: 0.9 };
    } catch {
      return { ext: 'gz', mime: 'application/gzip', family: 'archive', label: 'GZIP 压缩', confidence: 0.8 };
    }
  }

  // TAR：偏移 257 处有 "ustar"
  if (asciiAt(data, 257, 5) === 'ustar') {
    return { ext: 'tar', mime: 'application/x-tar', family: 'archive', label: 'TAR 归档', confidence: 0.9 };
  }

  const textKind = looksLikeText(data, name);
  if (textKind) return { ...textKind, confidence: textKind.confidence ?? 0.7 };

  return { ext: 'bin', mime: 'application/octet-stream', family: 'binary', label: '未识别的二进制文件', confidence: 0.3 };
}

export { ConversionError };
