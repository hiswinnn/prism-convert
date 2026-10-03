/**
 * 通用工具：浏览器 / Node 双环境可用，不依赖 DOM。
 */
import { encodeText, decodeBytes } from './encoding.js';

/** 统一成 Uint8Array 视图（不复制数据） */
export function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return encodeText(value, 'utf-8');
  throw new TypeError('toBytes 只接受 Uint8Array / ArrayBuffer / TypedArray / string');
}

export function concatBytes(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export { decodeBytes, encodeText };

/** 文件名的扩展名（小写，不含点）；无扩展名返回 '' */
export function extOf(name) {
  const clean = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const dot = clean.lastIndexOf('.');
  if (dot <= 0 || dot === clean.length - 1) return '';
  return clean.slice(dot + 1).toLowerCase();
}

export function baseNameOf(name) {
  const clean = String(name ?? '').split(/[\\/]/).pop() ?? 'untitled';
  const dot = clean.lastIndexOf('.');
  return dot > 0 ? clean.slice(0, dot) : clean;
}

const ILLEGAL_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 消毒文件名：Windows/macOS/Android 都能安全落地 */
export function sanitizeFileName(name, fallback = 'untitled') {
  let out = String(name ?? '').replace(ILLEGAL_FILENAME, '_').replace(/\s+/g, ' ').trim();
  out = out.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!out) out = fallback;
  // 保留扩展名的前提下截断，避免超过文件系统的 255 字节限制
  if (out.length > 120) {
    const ext = extOf(out);
    const stem = baseNameOf(out).slice(0, 100);
    out = ext ? `${stem}.${ext}` : stem;
  }
  return out;
}

/** 同名冲突时追加 -1、-2…（输入为已消毒的文件名列表） */
export function uniqueFileName(name, taken) {
  const set = taken instanceof Set ? taken : new Set(taken ?? []);
  if (!set.has(name)) {
    set.add(name);
    return name;
  }
  const ext = extOf(name);
  const stem = baseNameOf(name);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = ext ? `${stem}-${i}.${ext}` : `${stem}-${i}`;
    if (!set.has(candidate)) {
      set.add(candidate);
      return candidate;
    }
  }
  const fallback = `${stem}-${Date.now()}`;
  set.add(fallback);
  return fallback;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

const MIME_BY_EXT = {
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', jsonl: 'application/x-ndjson',
  csv: 'text/csv', tsv: 'text/tab-separated-values', html: 'text/html', htm: 'text/html',
  xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', heic: 'image/heic', svg: 'image/svg+xml',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  epub: 'application/epub+zip', rtf: 'application/rtf', zip: 'application/zip',
  gz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
  avi: 'video/x-msvideo', gifv: 'video/mp4', srt: 'application/x-subrip',
  vtt: 'text/vtt', ass: 'text/x-ssa', ttf: 'font/ttf', otf: 'font/otf', woff2: 'font/woff2',
  base64: 'text/plain', bin: 'application/octet-stream',
};

export function mimeOfExt(ext) {
  return MIME_BY_EXT[String(ext ?? '').toLowerCase()] ?? 'application/octet-stream';
}

/** RFC4180 CSV 解析：支持引号、转义引号、字段内换行、CRLF */
export function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') inQuotes = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // CRLF 与孤立 CR 都当行尾
      if (src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function stringifyCsv(rows, delimiter = ',') {
  const needsQuote = new RegExp(`["\\n\\r${delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`);
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = cell === null || cell === undefined ? '' : String(cell);
          return needsQuote.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(delimiter),
    )
    .join('\r\n');
}

export function htmlEscape(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 文本统计：用于结果卡片展示「转换了多少字」，中文按字计 */
export function textStats(text) {
  const src = String(text ?? '');
  const lines = src ? src.split(/\r\n|\r|\n/).length : 0;
  const cjk = (src.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const words = (src.match(/[A-Za-z0-9_'’-]+/g) ?? []).length;
  return { chars: src.length, lines, cjk, words };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
