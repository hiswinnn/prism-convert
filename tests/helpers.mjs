/**
 * createApi 桩：把引擎（src/core/engine.js 的 buildApi）在 Node 里的行为复刻成最小可用版本，
 * 让模块测试不依赖界面与引擎。只实现契约里承诺的成员，缺一个都会在模块里暴露出来。
 */
import { decodeBytes, detectEncoding, encodeText } from '../src/core/encoding.js';
import { ConversionError, fail } from '../src/core/errors.js';
import { baseNameOf, mimeOfExt, sanitizeFileName, uniqueFileName } from '../src/core/util.js';
import { unzipBytes, zipBytes } from '../src/core/zip.js';

/**
 * @param {Uint8Array|ArrayBuffer|string} bytes 输入字节（字符串按 UTF-8 编码）
 * @param {{name?:string, ext?:string, options?:object, env?:string, onProgress?:(r:number,l?:string)=>void}} [config]
 */
export function createApi(bytes, config = {}) {
  const data = typeof bytes === 'string' ? encodeText(bytes, 'utf-8') : new Uint8Array(bytes);
  const name = config.name ?? 'input.bin';
  const ext = config.ext ?? (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
  const options = config.options ?? {};
  const notes = [];
  const takenNames = new Set();
  const progressLog = [];
  const detected = detectEncoding(data);

  return {
    input: { name, ext, mime: mimeOfExt(ext), size: data.length, bytes: data },
    detected,
    env: config.env ?? 'node',
    bytes: () => data,
    text: () => decodeBytes(data, 'auto'),
    decode: (value, encoding = 'auto') => decodeBytes(value, encoding),
    encode: (text, encoding = 'utf-8') => encodeText(text, encoding),
    opt: (key, fallback) => {
      const value = options[key];
      return value === undefined || value === null || value === '' ? fallback : value;
    },
    lib: async (libName) => import(libName),
    progress: (ratio, label) => {
      progressLog.push({ ratio, label });
      config.onProgress?.(ratio, label);
    },
    note: (level, message) => notes.push({ level, message }),
    fileName: (fileName) => uniqueFileName(sanitizeFileName(fileName), takenNames),
    zip: zipBytes,
    unzip: unzipBytes,
    /** 测试专用：拿回本次转换累积的提示（引擎侧由 convertFile 收集，桩里挂在 api 上） */
    notes,
    progressLog,
    baseName: () => baseNameOf(name),
  };
}

/** 把转换结果里的文件按名字取出来解码成文本 */
export function textOf(result, name) {
  const file = name ? result.files.find((f) => f.name === name) : result.files[0];
  if (!file) {
    throw new Error(`结果里没有文件 ${name ?? '(第一个)'}：${result.files.map((f) => f.name).join(' / ')}`);
  }
  return decodeBytes(file.bytes, 'auto');
}

export function fileOf(result, name) {
  const file = name ? result.files.find((f) => f.name === name) : result.files[0];
  if (!file) throw new Error(`结果里没有文件 ${name ?? '(第一个)'}`);
  return file;
}

/** 断言一个 async 操作抛出 ConversionError 且 code 正确，返回该错误便于继续断言消息 */
export async function expectConversionError(fn, code) {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ConversionError)) {
      throw new Error(`期望 ConversionError(${code})，实际是 ${err?.name}: ${err?.message}`);
    }
    if (code && err.code !== code) {
      throw new Error(`期望 code=${code}，实际 code=${err.code}（消息：${err.message}）`);
    }
    return err;
  }
  throw new Error(`期望抛出 ConversionError(${code})，但没有抛错`);
}

export { ConversionError, fail };
