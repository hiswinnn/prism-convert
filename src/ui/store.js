/**
 * 应用状态与业务动作。视图只读 state，只调这里的函数。
 * 不引入响应式框架：结构变化才整树重渲染，进度这类高频更新走定点补丁。
 */
import { analyzeFile, bundleResults, convertFile } from '../core/engine.js';
import { canonicalExt, defaultTargetFor, findCandidates, formatLabel, getConverter, targetsFor } from '../core/registry.js';

const DEFAULTS_KEY = 'prism.defaults';

const listeners = new Set();

export const state = {
  view: 'work',
  files: [],
  busy: false,
  defaults: loadDefaults(),
  batchProgress: null,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(detail = {}) {
  for (const fn of listeners) fn(detail);
}

export function set(patch, { silent = false } = {}) {
  Object.assign(state, patch);
  if (!silent) emit();
}

/* ------------------------------ 偏好设置 ------------------------------ */

function loadDefaults() {
  try {
    return { encoding: 'utf-8', shareAfterConvert: false, ...(JSON.parse(localStorage.getItem(DEFAULTS_KEY) ?? '{}')) };
  } catch {
    return { encoding: 'utf-8', shareAfterConvert: false };
  }
}

export function setDefault(key, value) {
  state.defaults[key] = value;
  localStorage.setItem(DEFAULTS_KEY, JSON.stringify(state.defaults));
  emit();
}

/* ------------------------------ 文件队列 ------------------------------ */

let seq = 0;

async function readBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * 加入待转换文件：立刻做类型/编码识别，让用户在点转换之前就知道会发生什么。
 * @param {File[]|FileList} list
 */
export async function addFiles(list) {
  const incoming = [...list];
  if (incoming.length === 0) return;
  state.busy = true;
  emit();

  const created = [];
  for (const file of incoming) {
    const entry = {
      id: `f${++seq}`,
      name: file.name || `粘贴内容-${seq}`,
      size: file.size,
      bytes: null,
      analysis: null,
      target: null,
      converterId: null,
      options: {},
      status: 'analyzing',
      progress: 0,
      progressLabel: '识别中',
      result: null,
      error: null,
      chat: null,
    };
    created.push(entry);
    state.files.push(entry);
    emit();

    try {
      entry.bytes = await readBytes(file);
      entry.analysis = await analyzeFile({ name: entry.name, bytes: entry.bytes });
      entry.target = entry.analysis.defaultTarget;
      entry.converterId = findCandidates(entry.analysis.ext, entry.target ?? '')[0]?.id ?? null;
      entry.options = defaultOptionsFor(entry);
      entry.status = 'ready';
      entry.progressLabel = '就绪';
      if (['json', 'jsonl'].includes(entry.analysis.ext)) entry.chat = await probeChat(entry);
    } catch (err) {
      entry.status = 'error';
      entry.error = { code: err?.code ?? 'ANALYZE_FAILED', message: err?.message ?? String(err) };
    }
    emit();
  }

  state.busy = false;
  emit();
}

/** 是不是 AI 聊天记录？界面据此显示「对话工坊」入口 */
async function probeChat(entry) {
  try {
    const module = await import('../core/chat-export.js');
    if (typeof module.inspect !== 'function') return null;
    const api = {
      input: { name: entry.name, ext: entry.analysis.ext, bytes: entry.bytes, mime: entry.analysis.mime, size: entry.size },
      text: () => new TextDecoder('utf-8').decode(entry.bytes),
      bytes: () => entry.bytes,
      decode: (data) => new TextDecoder('utf-8').decode(data),
      opt: (key, fallback) => entry.options[key] ?? fallback,
      progress: () => {},
      note: () => {},
      env: 'browser',
    };
    const info = module.inspect(api.input, api);
    return { provider: info.provider, providerLabel: info.providerLabel, conversations: info.conversations ?? [] };
  } catch {
    return null;
  }
}

/** 按当前目标格式对应的转换器，生成默认选项 */
export function defaultOptionsFor(entry) {
  const converter = currentConverter(entry);
  const meta = converter ? getConverter(converter.id) : null;
  const options = {};
  for (const option of meta?.options ?? []) {
    if (option.key === 'encoding') options[option.key] = state.defaults.encoding;
    else options[option.key] = option.default;
  }
  return options;
}

/** 当前会使用的转换器（第一个候选；转换器内部不认数据时引擎会自动降级） */
export function currentConverter(entry) {
  if (!entry?.analysis) return null;
  const forced = entry.converterId ? getConverter(entry.converterId) : null;
  if (forced && forced.to.map(canonicalExt).includes(canonicalExt(entry.target ?? ''))) return forced;
  return findCandidates(entry.analysis.ext, entry.target ?? '')[0] ?? null;
}

export function removeFile(id) {
  state.files = state.files.filter((f) => f.id !== id);
  emit();
}

export function clearFiles() {
  state.files = [];
  state.batchProgress = null;
  emit();
}

export function setTarget(id, target) {
  const entry = state.files.find((f) => f.id === id);
  if (!entry) return;
  entry.target = target;
  entry.converterId = findCandidates(entry.analysis.ext, target)[0]?.id ?? null;
  entry.options = defaultOptionsFor(entry);
  entry.result = null;
  entry.error = null;
  entry.status = 'ready';
  emit();
}

export function setConverter(id, converterId) {
  const entry = state.files.find((f) => f.id === id);
  if (!entry) return;
  entry.converterId = converterId;
  entry.options = defaultOptionsFor(entry);
  entry.result = null;
  emit();
}

export function setOption(id, key, value) {
  const entry = state.files.find((f) => f.id === id);
  if (!entry) return;
  entry.options[key] = value;
  if (key === 'encoding') setDefault('encoding', value);
  emit({ reason: 'option' });
}

export function setEncoding(id, encoding) {
  const entry = state.files.find((f) => f.id === id);
  if (!entry?.analysis) return;
  // 输入编码与输出编码是两件事：这里改的是「怎么读这份文件」
  entry.analysis.encoding.encoding = encoding;
  entry.analysis.garbled = false;
  try {
    const decoder = new TextDecoder(encoding === 'gbk' ? 'gb18030' : encoding);
    entry.analysis.preview = decoder.decode(entry.bytes).slice(0, 800);
  } catch {
    /* 无法解码时保留原预览 */
  }
  entry.result = null;
  emit();
}

/* ------------------------------ 转换 ------------------------------ */

export async function runConvert(id) {
  const entry = state.files.find((f) => f.id === id);
  if (!entry || !entry.bytes) return null;
  entry.status = 'converting';
  entry.progress = 0;
  entry.progressLabel = '准备中';
  entry.error = null;
  entry.result = null;
  emit({ reason: 'convert-start', id });

  try {
    const result = await convertFile(
      { name: entry.name, bytes: entry.bytes },
      {
        target: entry.target,
        options: entry.options,
        converterId: entry.converterId,
        analysis: entry.analysis,
        onProgress: (ratio, label) => {
          entry.progress = ratio;
          if (label) entry.progressLabel = label;
          emit({ reason: 'progress', id, ratio, label });
        },
      },
    );
    entry.result = result;
    entry.status = 'done';
    entry.progress = 1;
    entry.progressLabel = '完成';
    emit({ reason: 'convert-end', id });
    return result;
  } catch (err) {
    entry.status = 'error';
    entry.progress = 0;
    entry.error = { code: err?.code ?? 'CONVERT_FAILED', message: err?.message ?? String(err), detail: err?.detail };
    emit({ reason: 'convert-end', id });
    return null;
  }
}

export async function runAll() {
  const pending = state.files.filter((f) => f.status !== 'done' || !f.result);
  state.busy = true;
  state.batchProgress = { done: 0, total: pending.length };
  emit();
  for (const entry of pending) {
    await runConvert(entry.id);
    state.batchProgress = { done: (state.batchProgress?.done ?? 0) + 1, total: pending.length };
    emit({ reason: 'progress' });
  }
  state.busy = false;
  emit();
}

/** 把所有成功结果打成一个 zip */
export async function zipAllResults() {
  const files = state.files.flatMap((f) => f.result?.files ?? []);
  if (files.length === 0) return null;
  const stamp = new Date().toISOString().slice(0, 10);
  return bundleResults(files, `棱镜-转换结果-${stamp}.zip`);
}

export { formatLabel, getConverter, targetsFor, defaultTargetFor };
