/**
 * 测试用 Api 桩：按 docs/CONTRACT.md 的 Api 表实现，供各转换模块的 node --test 使用。
 *
 * 这里刻意不复用 src/core/encoding.js：桩要能独立验证「模块自己有没有正确调用 api.encode/decode」，
 * 拿引擎实现当桩会让测试变成同义反复。GBK 码表按 encoding.js 的思路现建（TextDecoder 反查）。
 */
import { zipSync as fzipSync, unzipSync as funzipSync } from 'fflate';

const ILLEGAL_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 文件名消毒：与 src/core/util.js 的 sanitizeFileName 行为一致 */
export function sanitizeFileName(name, fallback = 'untitled') {
  let out = String(name ?? '').replace(ILLEGAL_FILENAME, '_').replace(/\s+/g, ' ').trim();
  out = out.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!out) out = fallback;
  if (out.length > 120) {
    const dot = out.lastIndexOf('.');
    out = dot > 0 ? `${out.slice(0, dot).slice(0, 100)}.${out.slice(dot + 1)}` : out.slice(0, 100);
  }
  return out;
}

const utf8Decoder = new TextDecoder('utf-8');
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

export function utf8Encode(text) {
  return new TextEncoder().encode(text);
}

/* ------------------------------------------------------------------ *
 * GBK：编码侧靠 gb18030 的反查表，解码侧直接用 TextDecoder
 * ------------------------------------------------------------------ */

export function gbkDecode(bytes) {
  return new TextDecoder('gbk').decode(bytes);
}

export function gbkEncode(text) {
  const source = String(text ?? '');
  const out = [];
  for (const ch of source) {
    const code = ch.codePointAt(0);
    if (code < 0x80) { out.push(code); continue; }
    const bytes = gbkTable().get(ch);
    if (!bytes) throw new Error(`GBK 无法表示字符 ${ch}`);
    out.push(...bytes);
  }
  return Uint8Array.from(out);
}

let table = null;
function gbkTable() {
  if (table) return table;
  const pairs = [];
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (const [lo, hi] of [[0x40, 0x7e], [0x80, 0xfe]]) {
      for (let trail = lo; trail <= hi; trail += 1) {
        if (trail === 0x7f) continue;
        pairs.push(lead, trail);
      }
    }
  }
  const all = Uint8Array.from(pairs);
  const decoded = new TextDecoder('gb18030').decode(all);
  table = new Map();
  if (decoded.length === pairs.length / 2) {
    let i = 0;
    for (const ch of decoded) {
      const offset = i * 2;
      i += 1;
      if (ch !== '\uFFFD' && !table.has(ch)) table.set(ch, [pairs[offset], pairs[offset + 1]]);
    }
    return table;
  }
  // 批量解码出现错位（含无法解码的字节）时退回逐对解码，慢但正确
  const one = new TextDecoder('gb18030');
  for (let i = 0; i < pairs.length; i += 2) {
    const ch = one.decode(Uint8Array.of(pairs[i], pairs[i + 1]));
    if (ch.length === 1 && ch !== '\uFFFD' && !table.has(ch)) table.set(ch, [pairs[i], pairs[i + 1]]);
  }
  return table;
}

/* ------------------------------------------------------------------ *
 * 文本编解码（桩环境用）
 * ------------------------------------------------------------------ */

export function decodeBytes(bytes, encoding = 'auto') {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const label = normalize(encoding);
  if (label === 'auto') return decodeBytes(data, sniff(data));
  if (label === 'utf-8-bom') return utf8Decoder.decode(data.subarray(3));
  if (label === 'utf-8') return utf8Decoder.decode(data);
  if (label === 'gbk') return gbkDecode(data);
  return new TextDecoder(label).decode(data);
}

export function encodeText(text, encoding = 'utf-8') {
  const label = normalize(encoding);
  if (label === 'utf-8') return utf8Encode(text);
  if (label === 'utf-8-bom') {
    const body = utf8Encode(text);
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }
  if (label === 'gbk') return gbkEncode(text);
  throw new Error(`桩环境不支持输出编码 ${encoding}`);
}

function normalize(encoding) {
  const key = String(encoding ?? 'auto').trim().toLowerCase();
  return key === 'gb2312' || key === 'gb18030' ? 'gbk' : key;
}

/** 简化版自动识别：UTF-8 严格校验过就是 UTF-8，否则当 GBK（够测试用，不追求 detect.js 的准确度） */
function sniff(bytes) {
  if (!bytes.length) return 'utf-8';
  try {
    utf8Strict.decode(bytes);
    return 'utf-8';
  } catch {
    return 'gbk';
  }
}

/* ------------------------------------------------------------------ *
 * Api 桩
 * ------------------------------------------------------------------ */

/**
 * @param {{
 *   bytes?: Uint8Array, text?: string, name?: string, ext?: string, mime?: string,
 *   options?: Record<string, unknown>, env?: 'browser'|'node',
 *   assets?: Record<string,string>|null, target?: string,
 * }} [config]
 */
export function createApi(config = {}) {
  const bytes = config.bytes ?? (config.text !== undefined ? utf8Encode(config.text) : new Uint8Array(0));
  const name = config.name ?? 'sample.bin';
  const ext = config.ext ?? (name.includes('.') ? name.split('.').pop().toLowerCase() : 'bin');
  const options = config.options ?? {};

  const api = {
    input: { name, ext, mime: config.mime ?? 'application/octet-stream', size: bytes.length, bytes },
    detected: { encoding: 'utf-8', confidence: 0.9, candidates: [] },
    env: config.env ?? 'browser',
    target: config.target,
    progressCalls: [],
    noteCalls: [],

    bytes: () => bytes,
    text: (encoding) => decodeBytes(bytes, encoding ?? 'auto'),
    decode: (value, encoding) => decodeBytes(value, encoding ?? 'auto'),
    encode: (text, encoding) => encodeText(text, encoding ?? 'utf-8'),
    opt: (key, fallback) => (options[key] === undefined ? fallback : options[key]),
    progress(ratio, label) { api.progressCalls.push({ ratio, label }); },
    note(level, message) { api.noteCalls.push({ level, message }); },
    fileName: (value) => sanitizeFileName(value),

    /** 浏览器里由引擎提供 core 的 URL；桩里默认没有，用来验证 ENGINE_UNAVAILABLE 分支 */
    asset: config.assets === null ? undefined : async (assetName) => (config.assets ?? {})[assetName],

    async lib(libName) {
      if (libName === 'fflate') return import('fflate');
      return import(libName);
    },
    zip: (entries) => fzipSync(Object.fromEntries(entries.map((entry) => [entry.name, entry.bytes]))),
    unzip: (value) => Object.entries(funzipSync(value)).map(([entryName, data]) => ({ name: entryName, bytes: data })),
  };
  return api;
}
