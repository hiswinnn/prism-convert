/**
 * 编码识别 / 解码 / 编码——「转换不乱码」的核心。
 *
 * 设计要点：
 * 1) 浏览器与 Node 的 TextDecoder 都按 WHATWG 编码标准实现，原生支持 gbk/big5/shift_jis/euc-kr，
 *    因此解码侧不需要 iconv；编码侧（UTF-8 → GBK/Big5）用小节 2 的反查表自己建，避免再引入依赖。
 * 2) 识别不可能 100% 准确（GBK 字节几乎总能被 Big5 解出「看似合法」的汉字），
 *    所以 detectEncoding 返回**候选列表 + 试解码样本**，界面直接把对比摆给用户看，让他一键纠正——
 *    这比猜对更重要。
 */
import { ConversionError } from './errors.js';

export const ENCODINGS = [
  { id: 'auto', label: '自动识别', kind: 'auto' },
  { id: 'utf-8', label: 'UTF-8', kind: 'unicode' },
  { id: 'utf-8-bom', label: 'UTF-8 (带 BOM)', kind: 'unicode' },
  { id: 'utf-16le', label: 'UTF-16 LE', kind: 'unicode' },
  { id: 'utf-16be', label: 'UTF-16 BE', kind: 'unicode' },
  { id: 'gb18030', label: 'GB18030 (国标全集)', kind: 'legacy' },
  { id: 'gbk', label: 'GBK / GB2312 (简体常见)', kind: 'legacy' },
  { id: 'big5', label: 'Big5 (繁体)', kind: 'legacy' },
  { id: 'shift_jis', label: 'Shift_JIS (日文)', kind: 'legacy' },
  { id: 'euc-kr', label: 'EUC-KR (韩文)', kind: 'legacy' },
  { id: 'windows-1252', label: 'Windows-1252 (西欧)', kind: 'legacy' },
];

const LABEL_ALIASES = new Map(Object.entries({
  auto: 'auto', '': 'auto', utf8: 'utf-8', 'utf-8': 'utf-8', 'utf-8-bom': 'utf-8-bom',
  'utf8-bom': 'utf-8-bom', utf16le: 'utf-16le', 'utf-16': 'utf-16le', 'utf-16le': 'utf-16le',
  utf16be: 'utf-16be', 'utf-16be': 'utf-16be', utf32le: 'utf-32le', 'utf-32le': 'utf-32le',
  gbk: 'gbk', gb2312: 'gbk', gb18030: 'gb18030', 'x-gbk': 'gbk', big5: 'big5',
  'big5-hkscs': 'big5', cp950: 'big5', sjis: 'shift_jis', 'shift-jis': 'shift_jis',
  'shift_jis': 'shift_jis', 'windows-31j': 'shift_jis', euckr: 'euc-kr', 'euc-kr': 'euc-kr',
  cp949: 'euc-kr', latin1: 'windows-1252', 'iso-8859-1': 'windows-1252',
  'windows-1252': 'windows-1252', cp1252: 'windows-1252', ansi: 'gbk',
  'us-ascii': 'utf-8', ascii: 'utf-8',
}));

export function normalizeEncoding(name) {
  const key = String(name ?? 'auto').trim().toLowerCase();
  return LABEL_ALIASES.get(key) ?? key;
}

const decoderCache = new Map();
function getDecoder(label, fatal = false) {
  const key = `${label}|${fatal}`;
  let decoder = decoderCache.get(key);
  if (!decoder) {
    try {
      decoder = new TextDecoder(label, { fatal });
    } catch (err) {
      throw new ConversionError('ENCODING_UNSUPPORTED', `当前环境不支持编码 ${label}`, { cause: err });
    }
    decoderCache.set(key, decoder);
  }
  return decoder;
}

export const hasBom = {
  utf8: (bytes) => bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
  utf16le: (bytes) => bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe,
  utf16be: (bytes) => bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff,
  utf32le: (bytes) => bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0,
};

function decodeManualUtf32(bytes, little) {
  const out = [];
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    const cp = little
      ? bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)
      : (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    if (cp >= 0 && cp <= 0x10ffff) out.push(String.fromCodePoint(cp >>> 0));
  }
  return out.join('');
}

/**
 * 字节 → 字符串。encoding 传 'auto' 时先自动识别。
 * @returns {string}
 */
export function decodeBytes(bytes, encoding = 'auto') {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let label = normalizeEncoding(encoding);
  if (label === 'auto') label = detectEncoding(data).encoding;

  if (label === 'utf-8-bom' || (label === 'utf-8' && hasBom.utf8(data))) {
    const body = hasBom.utf8(data) ? data.subarray(3) : data;
    return getDecoder('utf-8').decode(body);
  }
  if (label === 'utf-8') return getDecoder('utf-8').decode(data);
  if (label === 'utf-16le') return getDecoder('utf-16le').decode(hasBom.utf16le(data) ? data.subarray(2) : data);
  if (label === 'utf-16be') return getDecoder('utf-16be').decode(hasBom.utf16be(data) ? data.subarray(2) : data);
  if (label === 'utf-32le') return decodeManualUtf32(hasBom.utf32le(data) ? data.subarray(4) : data, true);
  if (label === 'utf-32be') return decodeManualUtf32(data, false);

  // GB18030 是 GBK 的超集，解码时用它更宽容；标签本身不影响结果正确性
  const decoderLabel = label === 'gbk' ? 'gb18030' : label;
  return getDecoder(decoderLabel).decode(data);
}

/* ------------------------------------------------------------------ *
 * 编码侧：UTF-8 字符串 → GBK / Big5 / Shift_JIS / EUC-KR / 单字节
 * 反查表由 TextDecoder 一次性反向生成，避免手工维护码表（那才是乱码之源）。
 * ------------------------------------------------------------------ */

const LEGACY_RANGES = {
  gb18030: { lead: [0x81, 0xfe], trail: [[0x40, 0x7e], [0x80, 0xfe]], decoder: 'gb18030' },
  gbk: { lead: [0x81, 0xfe], trail: [[0x40, 0x7e], [0x80, 0xfe]], decoder: 'gb18030' },
  big5: { lead: [0xa1, 0xf9], trail: [[0x40, 0x7e], [0xa1, 0xfe]], decoder: 'big5' },
  shift_jis: { lead: [[0x81, 0x9f], [0xe0, 0xfc]], trail: [[0x40, 0x7e], [0x80, 0xfc]], decoder: 'shift_jis' },
  'euc-kr': { lead: [0x81, 0xfe], trail: [[0x41, 0x7e], [0x81, 0xfe]], decoder: 'euc-kr' },
};

const encoderTables = new Map();

/** 返回 Map<字符, Uint8Array(1或2字节)>；首次调用时构建（GBK 约 2.4 万个码位，毫秒级） */
function legacyEncoder(label) {
  if (encoderTables.has(label)) return encoderTables.get(label);
  const spec = LEGACY_RANGES[label];
  const map = new Map();
  for (let b = 0; b < 0x80; b += 1) map.set(String.fromCharCode(b), Uint8Array.of(b));
  if (!spec) {
    encoderTables.set(label, map);
    return map;
  }
  const leads = Array.isArray(spec.lead[0]) ? spec.lead : [spec.lead];
  const trails = spec.trail;
  const pairs = [];
  for (const [leadLo, leadHi] of leads) {
    for (let lead = leadLo; lead <= leadHi; lead += 1) {
      for (const [trailLo, trailHi] of trails) {
        for (let trail = trailLo; trail <= trailHi; trail += 1) {
          if (trail === 0x7f) continue;
          pairs.push(lead, trail);
        }
      }
    }
  }
  // 一次性解码整块字节，码点顺序与字节对一一对应（非法序列解出 U+FFFD，同样占一个码点）
  const decoded = getDecoder(spec.decoder).decode(Uint8Array.from(pairs));
  let index = 0;
  for (const ch of decoded) {
    const offset = index * 2;
    index += 1;
    if (ch === '\uFFFD') continue;
    if (!map.has(ch)) map.set(ch, Uint8Array.of(pairs[offset], pairs[offset + 1]));
  }
  encoderTables.set(label, map);
  return map;
}

/** 单字节编码（windows-1252）里 0xA0-0xFF 的字符映射是固定的 */
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

function encodeSingleByte(text, label) {
  const out = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (label === 'windows-1252' && code >= 0xa0 && code <= 0xff) out.push(code);
    else if (code < 0x80) out.push(code);
    else {
      const idx = CP1252_HIGH.indexOf(ch);
      out.push(idx >= 0 ? 0x80 + idx : 0x3f); // 无法表示的字符降级为 '?'
    }
  }
  return Uint8Array.from(out);
}

/**
 * 字符串 → 字节。不支持字符会降级为 '?'，并在文本里统计以便界面提示。
 * @returns {Uint8Array}
 */
export function encodeText(text, encoding = 'utf-8') {
  const source = String(text ?? '');
  const label = normalizeEncoding(encoding);

  if (label === 'utf-8') return getEncoder('utf-8').encode(source);
  if (label === 'utf-8-bom') {
    const body = getEncoder('utf-8').encode(source);
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }
  if (label === 'utf-16le' || label === 'utf-16be') {
    const little = label === 'utf-16le';
    const withBom = shouldAddUtf16Bom(label);
    const out = new Uint8Array(source.length * 2 + (withBom ? 2 : 0));
    let offset = 0;
    if (withBom) {
      out[0] = little ? 0xff : 0xfe;
      out[1] = little ? 0xfe : 0xff;
      offset = 2;
    }
    for (let i = 0; i < source.length; i += 1) {
      const code = source.charCodeAt(i);
      if (little) {
        out[offset + i * 2] = code & 0xff;
        out[offset + i * 2 + 1] = code >> 8;
      } else {
        out[offset + i * 2] = code >> 8;
        out[offset + i * 2 + 1] = code & 0xff;
      }
    }
    return out;
  }
  if (label === 'windows-1252') return encodeSingleByte(source, 'windows-1252');

  if (LEGACY_RANGES[label]) {
    const table = legacyEncoder(label);
    const out = [];
    let dropped = 0;
    for (const ch of source) {
      const bytes = table.get(ch);
      if (bytes) out.push(...bytes);
      else {
        dropped += 1;
        out.push(0x3f);
      }
    }
    if (dropped > 0) {
      // 让上层能提示「有 N 个字符该编码无法表示，已替换为 ?」——静默替换是乱码的近亲
      lastEncodeWarning.value = { encoding: label, dropped };
    } else lastEncodeWarning.value = null;
    return Uint8Array.from(out);
  }

  throw new ConversionError('ENCODING_UNSUPPORTED', `不支持输出编码 ${encoding}`);
}

/** 上一次 encodeText 的降级信息，供界面提示（避免静默丢字） */
export const lastEncodeWarning = { value: null };

const encoderCache = new Map();
function getEncoder(label) {
  let encoder = encoderCache.get(label);
  if (!encoder) {
    encoder = new TextEncoder(label);
    encoderCache.set(label, encoder);
  }
  return encoder;
}

// 历史遗留：某些 Windows 程序读无 BOM 的 UTF-16 会判断失败，输出 UTF-16 时统一带 BOM
function shouldAddUtf16Bom() {
  return true;
}

/* ------------------------------------------------------------------ *
 * 识别
 * ------------------------------------------------------------------ */

// 简繁共用高频字：正确的解码结果里这些字占比明显更高，是区分 GBK / Big5 误判最有效的信号
const COMMON_CJK = new Set(
  ('的一是不了在人有我他这个们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种' +
    '開美總從無情己面最女但現前些所同日手又行意動方期它頭經長兒回位分愛老因很給名法間斯知世什兩次使身者被高已親其進此話常與活正感個這為裡著於麼頭')
    .split(''),
);

function countMatches(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function scoreCandidate(bytes, label) {
  const text = decodeBytes(bytes, label);
  const sample = text.slice(0, 20000) || text;
  const total = Math.max(1, Array.from(sample).length);
  const replacement = countMatches(sample, /\uFFFD/g) / total;
  const ctrl = countMatches(sample, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g) / total;
  const cjk = countMatches(sample, /[\u3400-\u9fff]/g) / total;
  const common = Array.from(sample).filter((ch) => COMMON_CJK.has(ch)).length / total;

  /**
   * 打分要点（踩过的坑）：不能写成「基础分 + 各项加分」再 clamp——
   * 只要有任意一项加分，所有候选都会被截断成 1.000，排序彻底失效（Big5 会被判成 GB18030）。
   * 改成各项先归一到 0~1 再加权平均，分数才真的可比。
   */
  const validScore = 1 - Math.min(1, replacement * 8);
  const ctrlScore = 1 - Math.min(1, ctrl * 8);
  const commonScore = Math.min(1, common / 0.06);   // 真实中文文本高频字占比很高；误码解出的生僻字接近 0
  const cjkScore = Math.min(1, cjk / 0.5);          // 中文文本 CJK 占比通常过半

  const score = 0.42 * validScore + 0.08 * ctrlScore + 0.38 * commonScore + 0.12 * cjkScore;
  return {
    encoding: label,
    score: Math.max(0, Math.min(1, score)),
    replacement,
    cjk,
    common,
    sample: text.slice(0, 120),
  };
}

const CJK_LEGACY = ['gb18030', 'big5', 'shift_jis', 'euc-kr'];

/**
 * 识别字节编码。
 * @returns {{encoding:string, confidence:number, candidates:Array<{encoding:string,score:number,sample:string}>}}
 */
export function detectEncoding(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length === 0) return { encoding: 'utf-8', confidence: 0.3, candidates: [] };

  if (hasBom.utf32le(data)) return { encoding: 'utf-32le', confidence: 0.99, candidates: [] };
  if (hasBom.utf8(data)) return { encoding: 'utf-8-bom', confidence: 0.99, candidates: [] };
  if (hasBom.utf16le(data)) return { encoding: 'utf-16le', confidence: 0.99, candidates: [] };
  if (hasBom.utf16be(data)) return { encoding: 'utf-16be', confidence: 0.99, candidates: [] };

  // UTF-8 严格校验通过就是 UTF-8：非法序列在严格模式下会抛错，这一步几乎没有假阳性
  let validUtf8 = true;
  try {
    getDecoder('utf-8', true).decode(data);
  } catch {
    validUtf8 = false;
  }
  const asciiOnly = !/[\u0080-\uffff]/.test(validUtf8 ? getDecoder('utf-8').decode(data.slice(0, 4096)) : '\u0080');
  if (validUtf8) {
    return {
      encoding: 'utf-8',
      confidence: asciiOnly ? 0.9 : 0.98,
      candidates: [{ encoding: 'utf-8', score: asciiOnly ? 0.9 : 0.98, sample: decodeBytes(data, 'utf-8').slice(0, 120) }],
    };
  }

  // 无 BOM 的 UTF-16：ASCII 文本里会大量出现 0x00，按奇偶位置判断字节序
  if (data.length >= 4) {
    let evenZeros = 0;
    let oddZeros = 0;
    const probe = Math.min(data.length, 4096);
    for (let i = 0; i < probe; i += 1) {
      if (data[i] !== 0) continue;
      if (i % 2 === 0) evenZeros += 1;
      else oddZeros += 1;
    }
    const ratio = probe / 2;
    if (evenZeros / ratio > 0.35 && oddZeros / ratio < 0.05) {
      return { encoding: 'utf-16be', confidence: 0.85, candidates: [] };
    }
    if (oddZeros / ratio > 0.35 && evenZeros / ratio < 0.05) {
      return { encoding: 'utf-16le', confidence: 0.85, candidates: [] };
    }
  }

  const candidates = CJK_LEGACY.map((label) => scoreCandidate(data, label));
  const hasHighBytes = data.some((b) => b >= 0x80);
  if (!hasHighBytes) {
    return { encoding: 'utf-8', confidence: 0.9, candidates: [] };
  }
  candidates.push(scoreCandidate(data, 'windows-1252'));
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return {
    encoding: best.encoding,
    confidence: Math.max(0, Math.min(1, best.score)),
    candidates: candidates.map(({ encoding, score, sample }) => ({ encoding, score, sample })),
  };
}

/**
 * 判断一段文本是否「像乱码」（用来在界面提示切换编码）。
 * 常见形态：大量替换字符、西欧重音字母连排的 mojibake、私用区/生僻扩展区扎堆。
 */
export function looksGarbled(text) {
  const sample = String(text ?? '').slice(0, 4000);
  if (!sample) return false;
  const total = sample.length;
  const replacement = countMatches(sample, /\uFFFD/g) / total;
  const mojibake = countMatches(sample, /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß][\u0080-\u00ff¡-ÿ]/g) / total;
  const privateUse = countMatches(sample, /[\uE000-\uF8FF]/g) / total;
  const rareBlocks = countMatches(sample, /[\u3000-\u303f\u3100-\u312f\u31c0-\u31ef]/g) / total;
  return replacement > 0.02 || mojibake > 0.05 || privateUse > 0.02 || rareBlocks > 0.3;
}

/** 给界面用的一句话说明 */
export function describeEncoding(result) {
  const label = ENCODINGS.find((e) => e.id === result.encoding)?.label ?? result.encoding;
  if (result.encoding === 'utf-8' && result.confidence >= 0.95) return `${label}（确定）`;
  return `${label}（置信度 ${Math.round(result.confidence * 100)}%）`;
}
