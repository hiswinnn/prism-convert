/**
 * 压缩包模块：zip / gz / tar / tgz 的解压、清单、重新打包。
 *
 * 为什么自己解析 tar 与 ZIP 中央目录：
 * - fflate 只做 deflate / gzip / zip，tar 不在它的范围内；
 * - 「解压后总大小」必须在真正解压之前用头部声明值卡住，否则一个 zip 炸弹就能把标签页打崩；
 * - ZIP 中文名乱码（老 Windows 工具把 GBK 字节写进文件名且不置 bit 11）只能靠原始字节修正。
 *
 * MIME、体积格式化、扩展名这些通用能力复用 util.js，避免每个模块各维护一份映射表。
 *
 * @typedef {import('./types.js').Api} Api
 */
import { ConversionError } from './errors.js';
import { extOf, formatBytes, mimeOfExt } from './util.js';

const TAR_BLOCK = 512;
const ZIP_UTF8_FLAG = 0x800;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const ZIP64_SENTINEL = 0xffffffff;

/** 解压后总大小上限：纯前端在内存里解压，超过这个量浏览器基本必崩，宁可明确拒绝 */
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
/** 单个文件超过这个大小就在结果卡片上提醒一句 */
const LARGE_ENTRY_BYTES = 50 * 1024 * 1024;
const PREVIEW_CHARS = 2000;

// 全角区间：清单要按显示宽度对齐，CJK 一律算两列
const WIDE_CHAR = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6b\uff00-\uff60\uffe0-\uffe6]/;

export const meta = {
  id: 'archive',
  category: 'archive',
  label: '压缩包',
  from: ['zip', 'gz', 'tar', 'tgz'],
  to: ['zip', 'gz', 'tar', 'txt', 'json'],
  priority: 60,
  options: [
    { key: 'action', type: 'select', label: '操作', default: 'extract', choices: [
      { value: 'extract', label: '解压' },
      { value: 'list', label: '只看清单' },
      { value: 'repackage', label: '重新打包为 zip' },
    ] },
    { key: 'flatten', type: 'boolean', label: '解压时拉平目录（文件名加路径前缀避免重名）', default: false },
    { key: 'includeHidden', type: 'boolean', label: '包含隐藏文件（.开头）', default: false },
    { key: 'encoding', type: 'encoding', label: '清单文本编码', default: 'utf-8' },
  ],
};

/** @param {import('./types.js').Input} input @param {Api} api */
export async function convert(input, api) {
  const fflate = await api.lib('fflate');
  const bytes = api.bytes();

  const action = String(api.opt('action', 'extract'));
  if (!['extract', 'list', 'repackage'].includes(action)) {
    throw new ConversionError('ARCHIVE_BAD_ACTION', `不认识的压缩包操作「${action}」`);
  }

  api.progress(0.05, '识别压缩包格式');
  const format = detectFormat(bytes, input.ext);
  if (!format) {
    throw new ConversionError(
      'ARCHIVE_UNKNOWN',
      '认不出这个压缩包的格式（支持 zip / gz / tar / tgz；RAR、7z 请先转成 ZIP）',
    );
  }

  const notes = [];
  const wantsContent = action !== 'list';
  const archive = readArchive(bytes, format, fflate, api, { wantsContent, notes, inputName: input.name });

  if (!archive.entries.length) {
    throw new ConversionError('ARCHIVE_EMPTY', '压缩包里没有文件（空压缩包，或只有目录项）');
  }
  if (archive.reencodedNames > 0) {
    notes.push({
      level: 'info',
      message: `修正了 ${archive.reencodedNames} 个乱码文件名（旧 Windows 工具写入的 GBK 文件名），已按 GBK 重新解码`,
    });
  }

  api.progress(0.6, '整理条目');
  const includeHidden = api.opt('includeHidden', false) === true;
  const flatten = api.opt('flatten', false) === true;
  const { visible, hiddenCount } = pickVisible(archive.entries, includeHidden);
  if (!visible.length) {
    throw new ConversionError(
      'ARCHIVE_EMPTY',
      hiddenCount
        ? `压缩包里只有 ${hiddenCount} 个隐藏条目（. 开头），勾选「包含隐藏文件」后再试`
        : '压缩包里没有可解压的文件',
    );
  }

  const large = visible.filter((entry) => entry.size > LARGE_ENTRY_BYTES);
  if (large.length) {
    notes.push({
      level: 'warn',
      message: `有 ${large.length} 个文件超过 ${formatBytes(LARGE_ENTRY_BYTES)}（最大 ${formatBytes(Math.max(...large.map((e) => e.size)))}），浏览器处理会很吃内存`,
    });
  }

  const named = buildNames(visible, flatten, api);
  if (named.renamed) {
    notes.push({ level: 'info', message: `有 ${named.renamed} 个条目改名后重名，已自动追加 -1、-2 区分` });
  }

  const target = resolveTarget(api, '');
  const listing = buildListing(input.name ?? '压缩包', archive, named.entries, hiddenCount, target === 'json');

  if (action === 'list' || (action === 'extract' && (target === 'txt' || target === 'json'))) {
    const isJson = target === 'json';
    const name = `${stripExt(input.name ?? 'archive')}${isJson ? '.manifest.json' : '.清单.txt'}`;
    api.progress(1, '生成清单');
    return {
      files: [{
        name: api.fileName(name),
        bytes: api.encode(listing, api.opt('encoding', 'utf-8')),
        mime: mimeOfExt(isJson ? 'json' : 'txt'),
      }],
      preview: previewOf(listing),
      notes,
    };
  }

  if (action === 'repackage') {
    api.progress(0.8, '重新打包');
    // 用无原型对象：压缩包里出现名为 __proto__ 的条目时，普通对象会把它当成原型而不是键
    const bag = Object.create(null);
    for (const entry of named.entries) bag[entry.name] = entry.bytes;
    let zipBytes;
    try {
      // fflate 默认压缩级别，且对非 ASCII 文件名会自动置 bit 11，下游工具不会解成乱码
      zipBytes = fflate.zipSync(bag);
    } catch (err) {
      throw new ConversionError('ARCHIVE_PACK_FAILED', '重新打包失败，可能是文件名或数据异常', { cause: err });
    }
    api.progress(1, '完成');
    return {
      files: [{
        name: api.fileName(`${stripExt(input.name ?? 'archive')}.zip`),
        bytes: zipBytes,
        mime: mimeOfExt('zip'),
      }],
      preview: previewOf(listing),
      notes,
    };
  }

  api.progress(1, '完成');
  return {
    // 名字在 buildNames 里已逐段过 api.fileName；整条再过一次会把目录分隔符和 .env 开头的点一起吃掉
    files: named.entries.map((entry) => ({
      name: entry.name,
      bytes: entry.bytes,
      mime: mimeOfExt(extOf(entry.name)),
    })),
    preview: previewOf(listing),
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * 格式识别
 * ------------------------------------------------------------------ */

function detectFormat(bytes, ext) {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) return 'zip';
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gz';
  if (looksLikeTar(bytes)) return 'tar';
  // 内容认不出来再退回扩展名，给「改过后缀」的文件留条路
  const e = String(ext ?? '').toLowerCase();
  if (e === 'zip') return 'zip';
  if (e === 'tar') return 'tar';
  if (e === 'gz' || e === 'tgz') return 'gz';
  return null;
}

function looksLikeTar(bytes) {
  if (bytes.length < TAR_BLOCK || bytes.length % TAR_BLOCK !== 0) return false;
  if (latin1(bytes, 257, 262) === 'ustar') return true;
  // 空 tar（开头就是结束块）与只有合法校验和的旧式 tar 也认
  return isZeroBlock(bytes, 0) || hasValidTarChecksum(bytes, 0);
}

function hasValidTarChecksum(bytes, offset) {
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) {
    // 校验和字段本身按 8 个空格参与计算
    sum += i >= 148 && i < 156 ? 0x20 : bytes[offset + i];
  }
  const stored = readOctal(bytes, offset + 148, 8);
  return stored !== null && stored === sum;
}

function isZeroBlock(bytes, offset) {
  for (let i = 0; i < TAR_BLOCK; i += 1) if (bytes[offset + i] !== 0) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * 读取：统一产出条目元数据（+ 可选内容）
 * ------------------------------------------------------------------ */

function readArchive(bytes, format, fflate, api, { wantsContent, notes, inputName }) {
  if (format === 'zip') return readZip(bytes, fflate, api, wantsContent, notes);
  if (format === 'tar') return readTarArchive(bytes, api, wantsContent, notes);
  return readGzip(bytes, fflate, api, wantsContent, notes, inputName);
}

function readZip(bytes, fflate, api, wantsContent, notes) {
  const index = readCentralDirectory(bytes);
  if (wantsContent && index) assertWithinLimit(sumOf(index), 'ZIP');

  if (!wantsContent) {
    if (!index) throw new ConversionError('ARCHIVE_CORRUPT', 'ZIP 中央目录缺失或损坏，无法生成清单');
    const entries = index.map((record) => toEntry(record, null, api));
    return { label: 'ZIP', entries, reencodedNames: countReencoded(entries) };
  }

  let unzipped;
  try {
    unzipped = fflate.unzipSync(bytes);
  } catch (err) {
    throw new ConversionError('ARCHIVE_CORRUPT', 'ZIP 数据损坏，或这不是一个有效的 ZIP 文件', { cause: err });
  }

  const keys = Object.keys(unzipped);
  // fflate 按中央目录顺序输出；逐项核对解出来的名字，对不上就退回「只能用 fflate 的名字」
  const aligned = Boolean(index && index.length === keys.length
    && index.every((record, i) => fflateName(record.rawName, record.flags) === keys[i]));
  if (index && !aligned) {
    notes.push({
      level: 'warn',
      message: 'ZIP 中央目录与解压结果对不上（可能是流式写入的压缩包），已按解压结果列目录，文件时间与 CRC 不可用',
    });
  }

  const entries = keys.map((key, i) => (aligned
    ? toEntry(index[i], unzipped[key], api)
    : {
      name: key.replace(/\\/g, '/'),
      isDir: key.endsWith('/'),
      size: unzipped[key].length,
      compressedSize: null,
      crc32: null,
      mtime: null,
      bytes: unzipped[key],
    }));

  // 声明值可能被伪造，实测值再卡一次
  assertWithinLimit(entries.reduce((sum, entry) => sum + entry.size, 0), 'ZIP');
  return { label: 'ZIP', entries, reencodedNames: countReencoded(entries) };
}

function toEntry(record, data, api) {
  const decoded = decodeEntryName(record.rawName, record.flags, api);
  const name = decoded.name.replace(/\\/g, '/');
  return {
    name,
    isDir: name.endsWith('/'),
    // 有真实数据时以数据长度为准，避免被伪造的中央目录带偏
    size: data ? data.length : record.size,
    compressedSize: record.compressedSize,
    crc32: record.crc32,
    mtime: record.mtime,
    bytes: data ?? undefined,
    reencoded: decoded.reencoded,
  };
}

function countReencoded(entries) {
  return entries.reduce((n, entry) => n + (entry.reencoded ? 1 : 0), 0);
}

function sumOf(index) {
  return index.reduce((sum, record) => sum + (record.size ?? 0), 0);
}

function assertWithinLimit(total, what) {
  if (total > MAX_TOTAL_BYTES) {
    throw new ConversionError(
      'ARCHIVE_TOO_LARGE',
      `${what} 解压后约 ${formatBytes(total)}，超过 ${formatBytes(MAX_TOTAL_BYTES)} 上限；请先用本地解压工具处理，或分批取出里面的文件`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * ZIP 中央目录：解压前拿到大小 / CRC / 时间，并保留文件名的原始字节
 * ------------------------------------------------------------------ */

function readCentralDirectory(bytes) {
  if (bytes.length < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  const lowerBound = Math.max(0, bytes.length - 22 - 0xffff); // 注释最长 64KB，倒着扫
  for (let i = bytes.length - 22; i >= lowerBound; i -= 1) {
    if (view.getUint32(i, true) === ZIP_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === ZIP64_SENTINEL) return null; // ZIP64 的目录偏移在 zip64 EOCD 里，本模块不处理

  const records = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== ZIP_CENTRAL_FILE) return null;
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    if (offset + 46 + nameLen > bytes.length) return null;
    const rawSize = view.getUint32(offset + 24, true);
    const rawCompressed = view.getUint32(offset + 20, true);

    records.push({
      rawName: bytes.subarray(offset + 46, offset + 46 + nameLen),
      flags: view.getUint16(offset + 8, true),
      // 0xffffffff 表示真值在 zip64 扩展字段里，当作未知，别拿去算总量
      size: rawSize === ZIP64_SENTINEL ? 0 : rawSize,
      compressedSize: rawCompressed === ZIP64_SENTINEL ? null : rawCompressed,
      crc32: view.getUint32(offset + 16, true),
      mtime: dosToDate(view.getUint16(offset + 14, true), view.getUint16(offset + 12, true)),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return records.length === count ? records : null;
}

function dosToDate(dosDate, dosTime) {
  if (!dosDate) return null;
  const year = 1980 + (dosDate >> 9);
  const month = (dosDate >> 5) & 0x0f;
  const day = dosDate & 0x1f;
  if (month < 1 || month > 12 || day < 1) return null;
  return new Date(year, month - 1, day, (dosTime >> 11) & 0x1f, (dosTime >> 5) & 0x3f, (dosTime & 0x1f) * 2);
}

/** 复刻 fflate 的解名规则：bit 11 未置位时它按 Latin-1 逐字节解，因此能无损拿回原始字节 */
function fflateName(rawName, flags) {
  if (flags & ZIP_UTF8_FLAG) return new TextDecoder('utf-8').decode(rawName);
  return latin1(rawName, 0, rawName.length);
}

/* ------------------------------------------------------------------ *
 * 文件名乱码修正（ZIP 中文名经典坑）
 * ------------------------------------------------------------------ */

function decodeEntryName(rawName, flags, api) {
  if (flags & ZIP_UTF8_FLAG) return { name: fflateName(rawName, flags), reencoded: false };
  const plain = latin1(rawName, 0, rawName.length);
  if (!hasHighByte(rawName)) return { name: plain, reencoded: false };

  const asUtf8 = decodeWith(rawName, 'utf-8', api);
  const asGbk = decodeWith(rawName, 'gbk', api);
  if (!asGbk) return { name: asUtf8 ?? plain, reencoded: false };

  // 两种乱码形态：GBK 字节被当 UTF-8 解（出现替换字符），或 GBK 字节恰好也是合法 UTF-8 但一个汉字都没有
  const utf8Broken = looksGarbledName(asUtf8);
  const gbkBroken = looksGarbledName(asGbk);
  if (utf8Broken && !gbkBroken) return { name: asGbk, reencoded: true };
  if (!utf8Broken && !gbkBroken && countCjk(asGbk) > countCjk(asUtf8)) return { name: asGbk, reencoded: true };
  return { name: asUtf8 ?? plain, reencoded: false };
}

/** tar / gzip 头里的文件名没有 flag 可依，只能靠「解出来像不像中文」判断 */
function decodeHeaderName(rawName, api) {
  const plain = latin1(rawName, 0, rawName.length);
  if (!hasHighByte(rawName)) return { name: plain, reencoded: false };

  const asUtf8 = decodeWith(rawName, 'utf-8', api);
  const asGbk = decodeWith(rawName, 'gbk', api);
  if (!asGbk) return { name: asUtf8 ?? plain, reencoded: false };

  const utf8Broken = looksGarbledName(asUtf8);
  const gbkBroken = looksGarbledName(asGbk);
  if (utf8Broken && !gbkBroken) return { name: asGbk, reencoded: true };
  if (!utf8Broken && !gbkBroken && countCjk(asGbk) > countCjk(asUtf8)) return { name: asGbk, reencoded: true };
  return { name: asUtf8 ?? plain, reencoded: false };
}

function decodeWith(rawBytes, label, api) {
  if (typeof api?.decode === 'function') {
    try {
      return api.decode(rawBytes, label);
    } catch {
      // 引擎不支持该编码时退到 TextDecoder；两条路都走不通才算拿不到文本
    }
  }
  try {
    return new TextDecoder(label).decode(rawBytes);
  } catch {
    return null;
  }
}

function hasHighByte(rawBytes) {
  for (let i = 0; i < rawBytes.length; i += 1) if (rawBytes[i] >= 0x80) return true;
  return false;
}

function looksGarbledName(text) {
  if (!text) return false;
  const total = Math.max(1, text.length);
  const bad = (text.match(/\uFFFD/g) ?? []).length + (text.match(/[\uE000-\uF8FF]/g) ?? []).length;
  // 西欧重音字母后面跟一串 Latin-1 补充区字符，是「UTF-8 字节被当 Latin-1 解」的典型形态
  const mojibake = (text.match(/[\u00C0-\u00FF][\u0080-\u00BF]/g) ?? []).length;
  return bad / total > 0.05 || mojibake / total > 0.1;
}

function countCjk(text) {
  return text ? (text.match(/[\u3400-\u9fff]/g) ?? []).length : 0;
}

/* ------------------------------------------------------------------ *
 * TAR
 * ------------------------------------------------------------------ */

function readTarArchive(bytes, api, wantsContent, notes) {
  const parsed = parseTar(bytes, api, wantsContent);
  assertWithinLimit(parsed.entries.reduce((sum, entry) => sum + entry.size, 0), 'TAR');
  if (parsed.truncated) {
    notes.push({ level: 'warn', message: 'TAR 结尾缺少标准的结束块，已按实际能读到的内容处理' });
  }
  return { label: 'TAR', entries: parsed.entries, reencodedNames: parsed.reencodedNames };
}

function parseTar(bytes, api, wantsContent) {
  const entries = [];
  let offset = 0;
  let longName = null;
  let paxPath = null;
  let reencodedNames = 0;
  let truncated = false;

  while (offset + TAR_BLOCK <= bytes.length) {
    if (isZeroBlock(bytes, offset)) break;
    const size = readOctal(bytes, offset + 124, 12);
    if (size === null || size < 0) {
      throw new ConversionError('ARCHIVE_CORRUPT', `TAR 头解析失败（偏移 ${offset}），文件可能已损坏`);
    }
    const typeFlag = String.fromCharCode(bytes[offset + 156] || 0x30);
    const dataStart = offset + TAR_BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) { truncated = true; break; }

    if (typeFlag === 'L') { // GNU longname：内容就是下一个条目的名字
      longName = decodeHeaderName(bytes.subarray(dataStart, dataEnd), api).name;
    } else if (typeFlag === 'x' || typeFlag === 'X') { // pax 扩展头，path= 优先于一切
      paxPath = readPaxPath(bytes.subarray(dataStart, dataEnd)) ?? null;
    } else if (typeFlag === 'g') {
      // 全局 pax 头：本模块不维护全局状态，忽略
    } else if (typeFlag === '0' || typeFlag === '\u0000' || typeFlag === '7' || typeFlag === '5') {
      const prefix = readCString(bytes, offset + 345, 155);
      const decoded = decodeHeaderName(joinTarName(prefix, readCStringBytes(bytes, offset, 100)), api);
      const name = (paxPath ?? longName ?? decoded.name).replace(/\\/g, '/');
      if (paxPath == null && longName == null && decoded.reencoded) reencodedNames += 1;
      const isDir = typeFlag === '5' || name.endsWith('/');
      const mtime = readOctal(bytes, offset + 136, 12);
      entries.push({
        name,
        isDir,
        size,
        compressedSize: null,
        crc32: null,
        mtime: mtime ? new Date(mtime * 1000) : null,
        bytes: wantsContent && !isDir ? bytes.slice(dataStart, dataEnd) : undefined,
      });
      longName = null;
      paxPath = null;
    } else {
      // 硬/软链接、设备文件等：只跳过内容，不产出文件
      longName = null;
      paxPath = null;
    }

    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }

  return { entries, reencodedNames, truncated };
}

function joinTarName(prefix, rawName) {
  if (!prefix) return rawName;
  const out = new Uint8Array(prefix.length + 1 + rawName.length);
  out.set(prefix, 0);
  out[prefix.length] = 0x2f;
  out.set(rawName, prefix.length + 1);
  return out;
}

function readPaxPath(content) {
  let cursor = 0;
  while (cursor < content.length) {
    const space = content.indexOf(0x20, cursor);
    if (space < 0) break;
    const length = Number(latin1(content, cursor, space));
    if (!Number.isFinite(length) || length <= 0) break;
    const record = content.subarray(space + 1, cursor + length - 1); // 记录尾是 \n
    const eq = record.indexOf(0x3d);
    if (eq >= 0 && latin1(record, 0, eq) === 'path') return latin1(record, eq + 1, record.length);
    cursor += length;
  }
  return null;
}

function readOctal(bytes, offset, length) {
  // GNU 的大文件用 base-256（最高位置 1）表示，别当成八进制字符串读
  if (bytes[offset] & 0x80) {
    let value = 0;
    for (let i = 1; i < length; i += 1) value = value * 256 + bytes[offset + i];
    return value;
  }
  const text = latin1(bytes, offset, offset + length).replace(/\0/g, ' ').trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : null;
}

function readCStringBytes(bytes, offset, length) {
  let end = offset;
  const stop = offset + length;
  while (end < stop && bytes[end] !== 0) end += 1;
  return bytes.subarray(offset, end);
}

function readCString(bytes, offset, length) {
  return latin1(bytes, offset, offset + length).replace(/\0.*$/s, '');
}

/** Latin-1 视图：头里的字节串先原样取回，再决定按 UTF-8 还是 GBK 解 */
function latin1(bytes, start, end) {
  let out = '';
  const CHUNK = 8192; // 一次性 apply 太长会超参数上限
  for (let i = start; i < end; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, end)));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * GZIP
 * ------------------------------------------------------------------ */

function readGzip(bytes, fflate, api, wantsContent, notes, inputName) {
  if (wantsContent) assertWithinLimit(readGzipIsize(bytes) ?? 0, 'GZIP');

  let inner;
  try {
    inner = fflate.gunzipSync(bytes);
  } catch (err) {
    throw new ConversionError('ARCHIVE_CORRUPT', 'gzip 数据损坏，解压失败', { cause: err });
  }
  if (wantsContent) assertWithinLimit(inner.length, 'GZIP');

  // .tgz / .tar.gz：里面通常是 tar，再解一层
  if (looksLikeTar(inner)) {
    const parsed = parseTar(inner, api, wantsContent);
    if (parsed.truncated) notes.push({ level: 'warn', message: 'TAR 结尾缺少标准的结束块，已按实际能读到的内容处理' });
    return { label: 'TAR.GZ', entries: parsed.entries, reencodedNames: parsed.reencodedNames };
  }

  const header = readGzipName(bytes, api);
  // 没有 FNAME 头时（多数工具都不写）只能从输入文件名猜：notes.txt.gz → notes.txt
  const base = inputName ? (String(inputName).split(/[\\/]/).pop() ?? 'unpacked.bin') : 'unpacked.bin';
  return {
    label: 'GZIP',
    entries: [{
      name: header ? stripGzipExt(header.name) : stripGzipExt(base),
      isDir: false,
      size: inner.length,
      compressedSize: bytes.length,
      crc32: null,
      mtime: readGzipMtime(bytes),
      bytes: wantsContent ? inner : undefined,
      reencoded: header ? header.reencoded : false,
    }],
    reencodedNames: header && header.reencoded ? 1 : 0,
  };
}

/** gzip 尾 4 字节是 ISIZE（未压缩长度 mod 2^32）：解压前先拿它卡一道 */
function readGzipIsize(bytes) {
  if (bytes.length < 8) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 4, true);
}

function readGzipMtime(bytes) {
  if (bytes.length < 8) return null;
  const mtime = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  return mtime ? new Date(mtime * 1000) : null;
}

function readGzipName(bytes, api) {
  const flags = bytes[3];
  if (!(flags & 0x08)) return null; // FNAME
  let cursor = 10;
  if (flags & 0x04) { // FEXTRA 挡在名字前面
    if (cursor + 2 > bytes.length) return null;
    cursor += 2 + bytes[cursor] + (bytes[cursor + 1] << 8);
  }
  if (cursor >= bytes.length) return null;
  let end = cursor;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  if (end === cursor) return null;
  return decodeHeaderName(bytes.subarray(cursor, end), api);
}

/* ------------------------------------------------------------------ *
 * 输出命名
 * ------------------------------------------------------------------ */

function pickVisible(entries, includeHidden) {
  const visible = [];
  let hiddenCount = 0;
  for (const entry of entries) {
    if (entry.isDir) continue;
    if (!includeHidden && isHiddenName(entry.name)) { hiddenCount += 1; continue; }
    visible.push(entry);
  }
  return { visible, hiddenCount };
}

function isHiddenName(name) {
  // '..' 是路径穿越段、'.' 是当前目录，都不算「隐藏文件」
  return name.split('/').some((segment) => segment !== '.' && segment !== '..' && segment.startsWith('.'));
}

/**
 * 目录型压缩包默认保留目录结构：api.fileName() 会把 '/' 消毒掉，
 * 所以逐层消毒再拼回去；'.' / '..' 段直接丢弃，避免 zip slip 落到压缩包之外。
 */
function buildNames(entries, flatten, api) {
  const taken = new Set();
  let renamed = 0;
  const named = entries.map((entry) => {
    const segments = entry.name.split('/').filter((segment) => segment && segment !== '.' && segment !== '..');
    const sanitized = segments.map((segment) => safeSegment(segment, api));
    let name = flatten || sanitized.length <= 1 ? sanitized.join('_') : sanitized.join('/');
    if (!name) name = 'unnamed';
    const unique = dedupe(name, taken);
    if (unique !== name) renamed += 1;
    // source 保留原始元数据：清单要用到大小/CRC/时间，而 name 已经消毒过
    return { name: unique, bytes: entry.bytes, source: entry };
  });
  return { entries: named, renamed };
}

/**
 * 消毒单个路径段。api.fileName() 会顺手去掉开头的点，但用户既然勾了「包含隐藏文件」，
 * 再把 .env 输出成 env 就等于把这个选项废掉了，所以保留开头那串点、只消毒后面的主体。
 */
function safeSegment(segment, api) {
  const match = /^(\.+)(.+)$/.exec(segment);
  if (!match) return api.fileName(segment);
  return `${match[1]}${api.fileName(match[2])}`;
}

function dedupe(name, taken) {
  if (!taken.has(name)) { taken.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
  const fallback = `${stem}-${Date.now()}${ext}`;
  taken.add(fallback);
  return fallback;
}

/* ------------------------------------------------------------------ *
 * 清单
 * ------------------------------------------------------------------ */

function buildListing(fileName, archive, entries, hiddenCount, asJson) {
  const rows = entries.map((entry) => ({
    name: entry.name,
    size: entry.source.size,
    compressedSize: entry.source.compressedSize,
    mtime: entry.source.mtime,
    crc32: entry.source.crc32,
  }));
  const total = rows.reduce((sum, row) => sum + (row.size ?? 0), 0);

  if (asJson) {
    return JSON.stringify({
      file: fileName,
      format: archive.label,
      entryCount: rows.length,
      totalSize: total,
      hiddenSkipped: hiddenCount,
      entries: rows.map((row) => ({
        name: row.name,
        size: row.size,
        compressedSize: row.compressedSize,
        modified: row.mtime ? row.mtime.toISOString() : null,
        crc32: row.crc32 == null ? null : crcHex(row.crc32),
      })),
    }, null, 2);
  }

  const body = rows.map((row) => [
    row.name,
    row.size == null ? '—' : formatBytes(row.size),
    row.compressedSize == null ? '—' : formatBytes(row.compressedSize),
    row.mtime ? formatTime(row.mtime) : '—',
    row.crc32 == null ? '—' : crcHex(row.crc32),
  ]);
  const header = ['文件名', '原始大小', '压缩后', '修改时间', 'CRC32'];
  const widths = header.map((title, col) => Math.min(
    48,
    Math.max(displayWidth(title), ...body.map((row) => displayWidth(row[col]))),
  ));

  return [
    'Prism 棱镜 · 压缩包清单',
    `文件：${fileName}`,
    `格式：${archive.label}`,
    `条目：${rows.length} 个文件${hiddenCount ? `（另有 ${hiddenCount} 个隐藏条目未列入）` : ''}`,
    `解压后总大小：${formatBytes(total)}`,
    '',
    header.map((title, col) => padCell(title, widths[col])).join('  ').trimEnd(),
    widths.map((width) => '─'.repeat(width)).join('  '),
    ...body.map((row) => row.map((cell, col) => padCell(cell, widths[col])).join('  ').trimEnd()),
  ].join('\n');
}

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) width += WIDE_CHAR.test(ch) ? 2 : 1;
  return width;
}

function padCell(text, width) {
  const value = String(text);
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function crcHex(crc) {
  return (crc >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

function formatTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function previewOf(text) {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\n…（已截断）` : text;
}

/* ------------------------------------------------------------------ *
 * 杂项
 * ------------------------------------------------------------------ */

function stripExt(name) {
  const clean = String(name).split(/[\\/]/).pop() ?? 'archive';
  const dot = clean.lastIndexOf('.');
  return dot > 0 ? clean.slice(0, dot) : clean;
}

function stripGzipExt(name) {
  return /\.(tar\.gz|tgz|gzip|gz)$/i.test(name) ? name.replace(/\.(tar\.gz|tgz|gzip|gz)$/i, '') : `${name}.out`;
}

/**
 * 目标扩展名：契约没规定引擎怎么传「要转成什么」，这里按几种常见来源兜底，
 * 都拿不到就用 fallback，不做猜测式的隐式转换。
 */
function resolveTarget(api, fallback) {
  // 引擎会把目标格式同时挂在这几个键上（见 engine.js 的 TARGET_KEYS），逐个兜底
  const candidates = [
    api.opt('format', ''), api.opt('to', ''), api.opt('output', ''), api.opt('outExt', ''),
    typeof api.target === 'string' ? api.target : '',
  ];
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim().toLowerCase().replace(/^\./, '');
    if (value) return value;
  }
  return fallback;
}
