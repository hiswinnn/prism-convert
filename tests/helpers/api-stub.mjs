/**
 * 转换模块测试用的 Api 桩：只实现契约里列出的成员，行为与引擎保持一致。
 * 放在 tests/helpers 里，避免每个模块测试各写一份。
 */
import { decodeBytes, encodeText, extOf, mimeOfExt, sanitizeFileName, uniqueFileName } from '../../src/core/util.js';
import { zipSync, unzipSync } from 'fflate';

/** CJS 包经 import() 可能只暴露 default，这里统一摊平 */
async function loadLib(name) {
  const mod = await import(name);
  const keys = Object.keys(mod);
  if (keys.length === 1 && keys[0] === 'default') return mod.default;
  return mod;
}

/**
 * @param {object} [init]
 * @param {string} [init.name] 输入文件名
 * @param {Uint8Array} [init.bytes] 输入字节
 * @param {Record<string, unknown>} [init.options] 模块选项
 * @param {'node'|'browser'} [init.env]
 * @param {Array<{name:string,bytes:Uint8Array}>} [init.extraInputs] 多输入场景
 * @param {(w:number,h:number)=>object|null} [init.getCanvas] 替换 Canvas 工厂
 * @param {string} [init.encoding] 文本解码编码
 */
export function createApi(init = {}) {
  const name = init.name ?? 'input.bin';
  const bytes = init.bytes ?? new Uint8Array();
  const options = init.options ?? {};
  const notes = [];
  const progress = [];
  const ext = extOf(name);
  const taken = new Set();

  return {
    input: {
      name,
      ext,
      mime: mimeOfExt(ext),
      size: bytes.length,
      bytes,
      files: init.extraInputs ?? undefined,
    },
    env: init.env ?? 'node',
    detected: { encoding: init.encoding ?? 'utf-8', confidence: 1, candidates: [] },
    opt(key, fallback) {
      const value = options[key];
      return value === undefined || value === null ? fallback : value;
    },
    bytes: () => bytes,
    text: (encoding) => decodeBytes(bytes, encoding ?? init.encoding ?? 'auto'),
    encode: (text, encoding) => encodeText(text, encoding ?? 'utf-8'),
    decode: (data, encoding) => decodeBytes(data, encoding ?? 'auto'),
    lib: loadLib,
    progress: (ratio, label) => progress.push({ ratio, label }),
    note: (level, message) => notes.push({ level, message }),
    fileName: (value) => uniqueFileName(sanitizeFileName(value), taken),
    zip: (entries) => zipSync(Object.fromEntries(entries.map((entry) => [entry.name, entry.bytes]))),
    unzip: (data) => Object.entries(unzipSync(data)).map(([entryName, entryBytes]) => ({ name: entryName, bytes: entryBytes })),
    getCanvas: init.getCanvas,
    // 测试断言用的旁路，不属于契约
    __notes: notes,
    __progress: progress,
  };
}
