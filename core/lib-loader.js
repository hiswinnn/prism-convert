/**
 * 依赖加载器：同一份模块代码在浏览器与 Node 里都只写 `await api.lib('xlsx')`。
 *
 * 浏览器：所有库通过 `<站点根>/vendor/lib/*` 镜像到 node_modules 的真实相对路径，
 *         因此库内部的相对 import（pdfjs 的 worker、cmaps、字体，ffmpeg 的 esm 分块）
 *         天然可用，不需要打包器；UMD 库（mammoth）用 script 注入。
 * Node：直接按裸包名动态 import，走 node_modules 解析。
 *
 * 关键坑：vendor 基址**必须由当前模块的 URL 推导**，不能写成 '/vendor/lib/...'。
 * 根绝对路径在本机（站点根就是 /）能跑，但部署到子路径
 * （如 https://<user>.github.io/<repo>/）就会指向域名根目录，全部 404 —— 这个 bug
 * 只有在真机访问线上地址时才会暴露（本地 dev-server 与 dist 都挂在根路径，永远看不出来）。
 */

/** 模块自身位置 → vendor 基址（路径无关，根路径与子路径都对） */
export const VENDOR_BASE = new URL('../vendor/lib/', import.meta.url).href;

/** 把 vendor 下的相对路径拼成可直接 import/fetch 的绝对 URL */
export function vendorUrl(relativePath) {
  return new URL(relativePath, VENDOR_BASE).href;
}

const LIBS = {
  fflate: { browser: ['module', vendorUrl('fflate/esm/browser.js')], node: 'fflate' },
  xlsx: { browser: ['module', vendorUrl('xlsx/xlsx.mjs')], node: 'xlsx' },
  'pdf-lib': { browser: ['module', vendorUrl('pdf-lib/dist/pdf-lib.esm.js')], node: 'pdf-lib' },
  'pdfjs-dist': {
    browser: ['module', vendorUrl('pdfjs-dist/build/pdf.mjs')],
    // Node 端必须用 legacy 构建：它不依赖 DOM，也不使用 worker
    node: 'pdfjs-dist/legacy/build/pdf.mjs',
  },
  mammoth: {
    browser: ['script', vendorUrl('mammoth/mammoth.browser.min.js'), 'mammoth'],
    node: 'mammoth',
  },
  docx: { browser: ['module', vendorUrl('docx/dist/index.mjs')], node: 'docx' },
  marked: { browser: ['module', vendorUrl('marked/lib/marked.esm.js')], node: 'marked' },
  turndown: { browser: ['module', vendorUrl('turndown/lib/turndown.browser.es.js')], node: 'turndown' },
  'js-yaml': { browser: ['module', vendorUrl('js-yaml/dist/js-yaml.mjs')], node: 'js-yaml' },
  '@ffmpeg/ffmpeg': { browser: ['module', vendorUrl('@ffmpeg/ffmpeg/dist/esm/index.js')], node: '@ffmpeg/ffmpeg' },
  'libheif-js': {
    browser: ['module', vendorUrl('libheif-js/libheif-wasm/libheif-bundle.mjs')],
    node: 'libheif-js/libheif-wasm/libheif-bundle.js',
  },
};

/** 引擎运行环境 */
export const env = typeof globalThis.window !== 'undefined' && typeof globalThis.document !== 'undefined' ? 'browser' : 'node';

const cache = new Map();
const scriptPromises = new Map();

function loadScript(url, globalName) {
  if (scriptPromises.has(url)) return scriptPromises.get(url);
  const promise = new Promise((resolve, reject) => {
    if (globalName && globalThis[globalName]) {
      resolve(globalThis[globalName]);
      return;
    }
    const el = document.createElement('script');
    el.src = url;
    el.onload = () => resolve(globalName ? globalThis[globalName] : true);
    el.onerror = () => reject(new Error(`脚本加载失败：${url}`));
    document.head.appendChild(el);
  });
  scriptPromises.set(url, promise);
  return promise;
}

/**
 * 懒加载第三方库。同一个库只加载一次。
 * @param {string} name
 */
export async function loadLib(name) {
  if (cache.has(name)) return cache.get(name);
  // 未登记的库不直接报错：允许模块写子路径（如 'pdfjs-dist/legacy/build/pdf.mjs'），
  // 浏览器侧走 vendor 镜像，Node 侧按裸 specifier 解析。
  const spec = LIBS[name] ?? { browser: ['module', vendorUrl(name)], node: name };

  const promise = (async () => {
    if (env === 'browser') {
      const [kind, url, globalName] = spec.browser;
      if (kind === 'script') return loadScript(url, globalName);
      const mod = await import(/* @vite-ignore */ url);
      // 有些库只有 default 导出（CJS 转 ESM），统一成「直接用」的形态
      return mod.default && Object.keys(mod).length === 1 ? mod.default : mod;
    }
    const mod = await import(spec.node ?? name);
    return mod.default && Object.keys(mod).length === 1 ? mod.default : mod;
  })();

  cache.set(name, promise);
  try {
    return await promise;
  } catch (err) {
    cache.delete(name);
    throw err;
  }
}

/**
 * 大体积静态资源（wasm、worker、字体表）的 URL。
 * 同样走 vendorUrl：子路径部署时不能是根绝对路径。
 */
export function assetUrl(name) {
  const table = {
    // 关键：@ffmpeg/ffmpeg 0.12 的 worker 是 module worker，它用 `await import(coreURL)` 取 core，
    // 所以必须给 dist/esm 的构建（有 `export default createFFmpegCore`）。
    // 给 umd 版会失败在 importScripts 上，报 "failed to import ffmpeg-core.js"。
    'ffmpeg-core.js': vendorUrl('@ffmpeg/core/dist/esm/ffmpeg-core.js'),
    'ffmpeg-core.wasm': vendorUrl('@ffmpeg/core/dist/esm/ffmpeg-core.wasm'),
    // 构建时额外产出 gzip 版（30.7MB → 9.8MB），同源兜底时优先用它
    'ffmpeg-core.wasm.gz': vendorUrl('@ffmpeg/core/dist/esm/ffmpeg-core.wasm.gz'),
    'pdf.worker.mjs': vendorUrl('pdfjs-dist/build/pdf.worker.mjs'),
    'pdfjs-standard_fonts': vendorUrl('pdfjs-dist/standard_fonts/'),
    'pdfjs-cmaps': vendorUrl('pdfjs-dist/cmaps/'),
  };
  return table[name] ?? null;
}

export function listLibs() {
  return Object.keys(LIBS);
}

/* ------------------------------------------------------------------ *
 * 音视频引擎（@ffmpeg/core）的获取
 *
 * 为什么要单独做这一套：
 * 这台机器到 GitHub Pages 的实测速度是 0.03 MB/s，30MB 的 wasm 要下 25 分钟——
 * 「首次使用下载一次引擎」在真实网络下等于不可用。
 * 而国内 npm 镜像（registry.npmmirror.com）实测 15 MB/s，且它提供的 tarball 里
 * 同时带着 ffmpeg-core.js 与 .wasm，一次请求就够。所以：镜像优先，同源与公共 CDN 兜底。
 * ------------------------------------------------------------------ */

/** 与 package.json / node_modules 里安装的 @ffmpeg/core 版本保持一致 */
export const FFMPEG_CORE_VERSION = '0.12.10';

const MIRROR_TARBALLS = [
  () => `https://registry.npmmirror.com/@ffmpeg/core/-/core-${FFMPEG_CORE_VERSION}.tgz`,
  () => `https://registry.npmjs.org/@ffmpeg/core/-/core-${FFMPEG_CORE_VERSION}.tgz`,
];

const CDN_FILES = [
  () => ['https://unpkg.com/@ffmpeg/core@${v}/dist/esm/ffmpeg-core.js', 'https://unpkg.com/@ffmpeg/core@${v}/dist/esm/ffmpeg-core.wasm'],
];

/** 用户在设置里填的引擎地址（自建镜像 / 反向代理），留空则用默认顺序 */
export function engineMirrorOverride() {
  try {
    return (globalThis.localStorage?.getItem('prism.engineMirror') ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * 极简 tar 解析（ustar）：只取普通文件，够用来拆 npm tarball。
 * 单独导出是为了能被 Node 单测直接验证——解包逻辑错了会表现为「引擎加载失败」这种难查的症状。
 * @param {Uint8Array} buffer
 * @returns {Map<string, Uint8Array>}
 */
export function untar(buffer) {
  const files = new Map();
  const decoder = new TextDecoder();
  const readString = (bytes) => decoder.decode(bytes).replace(/\0[\s\S]*$/, '').trim();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // 两个 512 空块表示结束
    const name = readString(header.subarray(0, 100));
    const size = parseInt(readString(header.subarray(124, 136)) || '0', 8) || 0;
    const type = String.fromCharCode(header[156]);
    const prefix = readString(header.subarray(345, 500));
    const full = prefix ? `${prefix}/${name}` : name;
    const start = offset + 512;
    if (type === '0' || type === '\0' || type === '') files.set(full, buffer.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** 带进度与超时的下载；返回 Uint8Array */
async function fetchBytes(url, { onProgress, timeoutMs = 180000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length') ?? 0);
    if (!response.body || !total) return new Uint8Array(await response.arrayBuffer());

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(received / total, received, total);
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function blobUrl(bytes, type) {
  return URL.createObjectURL(new Blob([bytes], { type }));
}

/**
 * 拿到可用于 ffmpeg.load() 的 core/wasm 地址。
 * @param {{onProgress?:(ratio:number,received:number,total:number,label:string)=>void, onNote?:(message:string)=>void}} options
 * @returns {Promise<{coreURL:string, wasmURL:string, source:string, revoke:()=>void}>}
 */
export async function loadFfmpegCore({ onProgress, onNote } = {}) {
  if (env !== 'browser') throw new Error('音视频引擎只能在浏览器里加载');
  const { gunzipSync } = await loadLib('fflate');
  const failures = [];
  const created = [];
  const revoke = () => {
    for (const url of created) URL.revokeObjectURL(url);
  };

  const custom = engineMirrorOverride();
  const tarballUrls = custom ? [custom] : MIRROR_TARBALLS.map((fn) => fn());

  // 断网（或明确离线）时别去镜像/CDN 上傻等：直接落到本站的 gz/原始文件。
  // 这是「下载到本地、没网也能用」的关键——本站文件就在 dist 里，随离线包一起分发。
  const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) || (globalThis.location?.protocol === 'file:');

  // ① npm 镜像 tarball：一次请求拿到 js + wasm
  for (const url of offline ? [] : tarballUrls) {
    try {
      onNote?.(`正在从引擎镜像下载（${new URL(url).host}）…`);
      const gz = await fetchBytes(url, {
        onProgress: (ratio, received, total) => onProgress?.(ratio * 0.85, received, total, '下载引擎'),
      });
      const files = untar(gunzipSync(gz));
      const core = files.get('package/dist/esm/ffmpeg-core.js');
      const wasm = files.get('package/dist/esm/ffmpeg-core.wasm');
      if (!core || !wasm) throw new Error('tarball 里没有 dist/esm 构建');
      const coreURL = blobUrl(core, 'text/javascript');
      const wasmURL = blobUrl(wasm, 'application/wasm');
      created.push(coreURL, wasmURL);
      onProgress?.(1, wasm.length, wasm.length, '引擎就绪');
      return { coreURL, wasmURL, source: url, revoke };
    } catch (err) {
      failures.push(`${url} → ${err.message}`);
    }
  }

  // ② 同源：先取 gzip 版（体积约为 1/3），失败再取原始 wasm
  const gzUrl = assetUrl('ffmpeg-core.wasm.gz');
  if (gzUrl) {
    try {
      onNote?.('镜像不可用，改用本站引擎（压缩传输）…');
      const gz = await fetchBytes(gzUrl, {
        onProgress: (ratio, received, total) => onProgress?.(ratio * 0.85, received, total, '下载引擎'),
      });
      const wasm = gz[0] === 0x1f && gz[1] === 0x8b ? gunzipSync(gz) : gz;
      const coreURL = assetUrl('ffmpeg-core.js');
      const wasmURL = blobUrl(wasm, 'application/wasm');
      created.push(wasmURL);
      return { coreURL, wasmURL, source: gzUrl, revoke };
    } catch (err) {
      failures.push(`${gzUrl} → ${err.message}`);
    }
  }

  // ③ 同源原始文件（自建托管/海外网络下通常已经够快）
  const rawCore = assetUrl('ffmpeg-core.js');
  const rawWasm = assetUrl('ffmpeg-core.wasm');
  if (rawCore && rawWasm) {
    try {
      onNote?.('改用本站原始引擎文件…');
      await fetchBytes(rawWasm, { onProgress: (ratio, received, total) => onProgress?.(ratio * 0.85, received, total, '下载引擎') });
      return { coreURL: rawCore, wasmURL: rawWasm, source: rawWasm, revoke };
    } catch (err) {
      failures.push(`${rawWasm} → ${err.message}`);
    }
  }

  // ④ 公共 CDN 兜底
  for (const build of CDN_FILES) {
    const [coreTemplate, wasmTemplate] = build();
    const version = FFMPEG_CORE_VERSION;
    const coreURL = coreTemplate.replace('${v}', version);
    const wasmURL = wasmTemplate.replace('${v}', version);
    try {
      onNote?.('改用公共 CDN 引擎…');
      await fetchBytes(wasmURL, { onProgress: (ratio, received, total) => onProgress?.(ratio * 0.85, received, total, '下载引擎') });
      return { coreURL, wasmURL, source: wasmURL, revoke };
    } catch (err) {
      failures.push(`${wasmURL} → ${err.message}`);
    }
  }

  throw new Error(`音视频引擎下载失败：${failures.join('；')}`);
}


