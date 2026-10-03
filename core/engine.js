/**
 * 转换引擎：识别 → 挑转换器 → 构造 api → 执行 → 归一化结果。
 * 界面只跟这里打交道，不直接碰各模块。
 */
import { detectType } from './detect.js';
import { decodeBytes, detectEncoding, describeEncoding, encodeText, lastEncodeWarning, looksGarbled } from './encoding.js';
import { ConversionError } from './errors.js';
import { assetUrl, env, loadLib } from './lib-loader.js';
import { canonicalExt, defaultTargetFor, findCandidates, formatLabel, getConverter, targetsFor } from './registry.js';
import {
  baseNameOf, clamp, extOf, formatBytes, mimeOfExt, sanitizeFileName, textStats, toBytes, uniqueFileName,
} from './util.js';
import { unzipBytes, zipBytes } from './zip.js';

/** 需要做编码识别的族别与扩展名：其它二进制格式不必猜编码 */
const TEXT_FAMILIES = new Set(['text', 'subtitle', 'chat']);
const TEXT_EXTS = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'xml', 'ini', 'html', 'srt', 'vtt', 'ass']);

function isTextLike(family, ext) {
  // 注意：xlsx/docx/ods 的 family 是 table/document，本质是 zip 容器，
  // 对它们猜编码只会得到「Windows-1252 置信度 47%」这种误导性结论。
  return TEXT_FAMILIES.has(family) || TEXT_EXTS.has(ext);
}

/** 「这个模块不认识这份数据」的软失败：引擎会退给下一个候选转换器，而不是直接报错 */
const SOFT_FAIL = /(UNKNOWN|NOT_APPLICABLE|MISMATCH|UNSUPPORTED_FORMAT)$/;

function isSoftFail(err) {
  return err instanceof ConversionError && SOFT_FAIL.test(err.code);
}

/**
 * 识别文件：类型 + 编码 + 预览 + 可转目标。
 * @param {{name:string, bytes:Uint8Array}} file
 */
export async function analyzeFile(file) {
  const bytes = toBytes(file.bytes);
  const name = file.name ?? 'untitled';
  const type = await detectType(bytes, name);
  const declaredExt = extOf(name);
  const ext = canonicalExt(type.ext);
  const isText = isTextLike(type.family, ext);

  let encoding = null;
  let preview = null;
  let stats = null;
  let garbled = false;
  if (isText) {
    encoding = detectEncoding(bytes);
    try {
      const text = decodeBytes(bytes, encoding.encoding);
      preview = text.slice(0, 800);
      stats = textStats(text);
      garbled = looksGarbled(preview);
    } catch {
      // 识别失败不算致命：界面仍可让用户手动选编码
      encoding = encoding ?? { encoding: 'utf-8', confidence: 0, candidates: [] };
    }
  }

  return {
    name,
    size: bytes.length,
    sizeLabel: formatBytes(bytes.length),
    ext,
    declaredExt,
    mime: type.mime,
    family: type.family,
    label: type.label,
    typeConfidence: type.confidence ?? 0.5,
    detail: type.detail ?? null,
    isText,
    encoding,
    encodingLabel: encoding ? describeEncoding(encoding) : null,
    preview,
    stats,
    garbled,
    targets: targetsFor(ext).map((target) => ({ ext: target, label: formatLabel(target) })),
    defaultTarget: pickDefaultTarget(ext, encoding),
    candidates: findCandidates(ext, defaultTargetFor(ext) ?? '').map((c) => ({ id: c.id, label: c.label })),
  };
}

/**
 * 默认目标要顺着用户意图走：
 * 一个 GBK 的 txt，十有八九是「打开是乱码」，默认给「转成 TXT」让他直接修编码；
 * 已经是 UTF-8 的 txt，才是「想换个格式」，默认给 Word。
 */
function pickDefaultTarget(ext, encoding) {
  const available = targetsFor(ext);
  const base = defaultTargetFor(ext);
  const legacy = encoding && !['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'utf-32le'].includes(encoding.encoding);
  if (legacy && (ext === 'txt' || ext === 'md') && available.includes('txt')) return 'txt';
  return base;
}

function buildApi({ analysis, bytes, options, target, onProgress, notes, takenNames, fflate }) {
  const textCache = new Map();
  let warnedEncoding = false;
  // 模块可能对同一个名字重复申请占位（先建清单、再建输出文件）。
  // 直接算重名会给出「中文名-1.txt」这种莫名其妙的结果，所以已发出的名字要幂等返回。
  const issued = new Set();
  const claimName = (name) => {
    if (issued.has(name)) return name;
    const unique = uniqueFileName(name, takenNames);
    issued.add(unique);
    return unique;
  };

  // 「目标格式」是引擎与模块之间最容易漏传的信息：模块各自会去 api.target / opt('to') /
  // input.target 里找，这里全部补齐，避免某个模块默默回落成 txt。
  const TARGET_KEYS = new Set(['target', 'to', 'format', 'output', 'outExt']);

  const api = {
    target,
    to: target,
    outputFormat: target,
    input: {
      name: analysis.name,
      ext: analysis.ext,
      declaredExt: analysis.declaredExt,
      mime: analysis.mime,
      size: bytes.length,
      bytes,
      target,
      to: target,
    },
    env,
    detected: analysis.encoding,
    bytes: () => bytes,
    decode: (data, encoding) => decodeBytes(data, encoding ?? analysis.encoding?.encoding ?? 'auto'),
    text: (encoding) => {
      const key = encoding ?? analysis.encoding?.encoding ?? 'utf-8';
      if (!textCache.has(key)) textCache.set(key, decodeBytes(bytes, key));
      return textCache.get(key);
    },
    encode: (text, encoding = 'utf-8') => {
      const out = encodeText(text, encoding);
      const warning = lastEncodeWarning.value;
      if (warning && !warnedEncoding) {
        warnedEncoding = true;
        notes.push({
          level: 'warn',
          message: `有 ${warning.dropped} 个字符无法用 ${warning.encoding.toUpperCase()} 表示，已替换为「?」。改用 UTF-8 可完整保留。`,
        });
      }
      return out;
    },
    opt: (key, fallback) => {
      const value = options?.[key];
      if (value === undefined || value === null || value === '') {
        if (TARGET_KEYS.has(key) && target) return target;
        return fallback;
      }
      return value;
    },
    lib: loadLib,
    asset: assetUrl,
    progress: (ratio, label) => onProgress?.(clamp(Number(ratio) || 0, 0, 1), label),
    note: (level, message) => notes.push({ level, message }),
    fileName: (name) => claimName(sanitizeFileName(name)),
    outName: (newExt) => claimName(sanitizeFileName(`${baseNameOf(analysis.name)}.${newExt}`)),
    zip: (entries) => {
      // 同步语义：契约里 api.zip() 直接返回字节，模块（如 pdf 多页渲染）会把它当 bytes 用，
      // 返回 Promise 会一路漏到 toBytes 才炸，很难定位。
      const bag = {};
      for (const entry of entries ?? []) bag[entry.name] = toBytes(entry.bytes);
      return fflate.zipSync(bag, { level: 6 });
    },
    unzip: (data, filter) => {
      const files = fflate.unzipSync(toBytes(data), filter ? { filter: (file) => filter(file.name, file.size ?? 0) } : undefined);
      return Object.entries(files).map(([name, content]) => ({ name, bytes: content }));
    },
    // 兼容：拿不到应用层的编码告警时，模块可直接读
    encodingWarning: () => lastEncodeWarning.value,
  };
  return api;
}

/**
 * 执行转换。
 * @param {{name:string, bytes:Uint8Array}} file
 * @param {{target?:string, options?:object, onProgress?:(ratio:number,label?:string)=>void, analysis?:object}} config
 */
export async function convertFile(file, config = {}) {
  const { target, options = {}, onProgress } = config;
  const bytes = toBytes(file.bytes);
  const analysis = config.analysis ?? (await analyzeFile(file));
  // 空文件要最先拦下来：否则会走到「暂不支持某某格式」这种答非所问的提示上
  if (bytes.length === 0) {
    throw new ConversionError('EMPTY_FILE', '这个文件是空的，没有内容可以转换');
  }
  const wanted = canonicalExt(target ?? analysis.defaultTarget ?? '');
  if (!wanted) {
    throw new ConversionError('NO_TARGET', `没认出这是什么格式的文件，暂时不知道怎么转换它`);
  }

  const candidates = findCandidates(analysis.ext, wanted);
  // 用户可以指定「按哪个模块解释这份数据」（例如同一份 JSON：聊天记录 / 配置数据）
  if (config.converterId) {
    const forced = candidates.findIndex((c) => c.id === config.converterId);
    if (forced > 0) candidates.unshift(candidates.splice(forced, 1)[0]);
  }
  if (candidates.length === 0) {
    const available = targetsFor(analysis.ext);
    throw new ConversionError(
      'NO_CONVERTER',
      available.length
        ? `暂不支持 ${formatLabel(analysis.ext)} → ${formatLabel(wanted)}。当前可以转成：${available.map(formatLabel).join('、')}`
        : `暂不支持 ${formatLabel(analysis.ext)} 这类文件`,
    );
  }

  const notes = [];
  const takenNames = new Set();
  const startedAt = Date.now();
  let lastSoftError = null;
  let usedConverter = null;
  let result = null;
  // fflate 很小且几乎每次转换都会用到（zip 输入识别、api.zip/unzip），这里先取好，
  // 让模块侧拿到同步的 zip/unzip
  const fflate = await loadLib('fflate');

  for (const converter of candidates) {
    onProgress?.(0.02, `准备${converter.label}转换`);
    try {
      const module = await converter.loader();
      const api = buildApi({ analysis, bytes, options, target: wanted, onProgress, notes, takenNames, fflate });
      result = await module.convert({ ...api.input }, api);
      usedConverter = converter;
      break;
    } catch (err) {
      if (isSoftFail(err) && candidates.indexOf(converter) < candidates.length - 1) {
        lastSoftError = err;
        notes.push({ level: 'info', message: `${converter.label}模块不认这份数据，换下一个引擎试试` });
        continue;
      }
      if (err instanceof ConversionError) throw err;
      // 未预期异常一律包装，避免界面拿到英文堆栈
      throw new ConversionError('CONVERT_FAILED', `${converter.label}转换失败：${err?.message ?? err}`, {
        cause: err,
        detail: err?.stack,
      });
    }
  }

  if (!result) {
    throw lastSoftError ?? new ConversionError('CONVERT_FAILED', '转换没有产出结果');
  }

  // 模块已经用 api.fileName() 去重过一轮；这里只处理「本批结果内部」的重名，
  // 直接复用同一个 takenNames 会把 x.txt 二次改名成 x-1.txt（用户会看到莫名其妙的 -1）。
  const resultNames = new Set();
  const files = (result.files ?? []).map((entry) => {
    const fileBytes = toBytes(entry.bytes);
    const name = uniqueFileName(sanitizeOutputName(entry.name, api0(analysis, wanted)), resultNames);
    return {
      name,
      bytes: fileBytes,
      size: fileBytes.length,
      sizeLabel: formatBytes(fileBytes.length),
      mime: entry.mime ?? mimeOfExt(extOf(name)),
      ext: extOf(name),
      kind: entry.kind ?? (isTextExt(extOf(name)) ? 'text' : 'binary'),
      text: entry.kind === 'text' || isTextExt(extOf(name)) ? safeDecodeText(fileBytes) : null,
    };
  });

  if (files.length === 0) {
    throw new ConversionError('EMPTY_RESULT', '转换完成但没有生成任何文件（源文件可能是空的）');
  }

  const preview = result.preview ?? files.find((f) => f.text)?.text?.slice(0, 2000) ?? null;

  // 模块经常把 api.note() 写过的内容又放进返回值的 notes 里，界面会看到重复的两条
  const mergedNotes = [...notes, ...(result.notes ?? [])];
  const seen = new Set();
  const uniqueNotes = mergedNotes.filter((note) => {
    const key = `${note.level}|${note.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    analysis,
    converterId: usedConverter.id,
    converterLabel: usedConverter.label,
    target: wanted,
    files,
    notes: uniqueNotes,
    preview,
    durationMs: Date.now() - startedAt,
  };
}

function api0(analysis, wanted) {
  return `${baseNameOf(analysis.name)}.${wanted}`;
}

/**
 * 输出文件名消毒。
 * 压缩包解压会带目录结构（docs/说明.txt），如果在这里把 '/' 一并消毒成 '_'，
 * 「拉平目录」这个开关就永远看不出差别了——所以逐段消毒、保留层级。
 */
function sanitizeOutputName(name, fallback) {
  const raw = String(name ?? '').trim() || fallback;
  const segments = raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map((segment) => sanitizeFileName(segment));
  return segments.join('/') || sanitizeFileName(fallback);
}

function isTextExt(ext) {
  return ['txt', 'md', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'xml', 'ini', 'html', 'htm', 'srt', 'vtt', 'ass'].includes(
    String(ext).toLowerCase(),
  );
}

/** 输出文本预览要宽容：老编码/半截字符不该让界面崩 */
function safeDecodeText(bytes) {
  try {
    const detected = detectEncoding(bytes);
    return decodeBytes(bytes, detected.encoding);
  } catch {
    return null;
  }
}

/** 批量结果打成一个 zip（多文件下载用） */
export async function bundleResults(files, zipName = 'prism-结果.zip', onProgress) {
  onProgress?.(0.2, '打包中');
  const entries = files.map((file) => ({ name: file.name, bytes: toBytes(file.bytes) }));
  const bytes = await zipBytes(entries);
  onProgress?.(1, '打包完成');
  return { name: sanitizeFileName(zipName), bytes, mime: 'application/zip', ext: 'zip', size: bytes.length };
}

export { capabilityMatrix } from './registry.js';
