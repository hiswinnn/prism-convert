/**
 * 依赖加载器：同一份模块代码在浏览器与 Node 里都只写 `await api.lib('xlsx')`。
 *
 * 浏览器：所有库通过 /vendor/lib/* 镜像到 node_modules 的真实相对路径，
 *         因此库内部的相对 import 天然可用，不需要打包器；UMD 库（mammoth）用 script 注入。
 * Node：直接按裸包名动态 import，走 node_modules 解析。
 */

const LIBS = {
  fflate: { browser: ['module', '/vendor/lib/fflate/esm/browser.js'], node: 'fflate' },
  xlsx: { browser: ['module', '/vendor/lib/xlsx/xlsx.mjs'], node: 'xlsx' },
  'pdf-lib': { browser: ['module', '/vendor/lib/pdf-lib/dist/pdf-lib.esm.js'], node: 'pdf-lib' },
  'pdfjs-dist': {
    browser: ['module', '/vendor/lib/pdfjs-dist/build/pdf.mjs'],
    // Node 端必须用 legacy 构建：它不依赖 DOM，也不使用 worker
    node: 'pdfjs-dist/legacy/build/pdf.mjs',
  },
  mammoth: {
    browser: ['script', '/vendor/lib/mammoth/mammoth.browser.min.js', 'mammoth'],
    node: 'mammoth',
  },
  docx: { browser: ['module', '/vendor/lib/docx/dist/index.mjs'], node: 'docx' },
  marked: { browser: ['module', '/vendor/lib/marked/lib/marked.esm.js'], node: 'marked' },
  turndown: { browser: ['module', '/vendor/lib/turndown/lib/turndown.browser.es.js'], node: 'turndown' },
  'js-yaml': { browser: ['module', '/vendor/lib/js-yaml/dist/js-yaml.mjs'], node: 'js-yaml' },
  '@ffmpeg/ffmpeg': { browser: ['module', '/vendor/lib/@ffmpeg/ffmpeg/dist/esm/index.js'], node: '@ffmpeg/ffmpeg' },
  'libheif-js': {
    browser: ['module', '/vendor/lib/libheif-js/libheif-wasm/libheif-bundle.mjs'],
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
  // 浏览器侧走 /vendor/lib/<同一相对路径>，Node 侧按裸 specifier 解析。
  const spec = LIBS[name] ?? { browser: ['module', `/vendor/lib/${name}`], node: name };

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
 * 大体积静态资源（wasm 等）的 URL。
 * 浏览器里是可直接 fetch 的路径；Node 里给绝对路径（ffmpeg core 在 Node 不可用，由调用方处理）。
 */
export function assetUrl(name) {
  const table = {
    // 关键：@ffmpeg/ffmpeg 0.12 的 worker 是 module worker，它用 `await import(coreURL)` 取 core，
    // 所以必须给 dist/esm 的构建（有 `export default createFFmpegCore`）。
    // 给 umd 版会失败在 importScripts 上，报 "failed to import ffmpeg-core.js"。
    'ffmpeg-core.js': '/vendor/lib/@ffmpeg/core/dist/esm/ffmpeg-core.js',
    'ffmpeg-core.wasm': '/vendor/lib/@ffmpeg/core/dist/esm/ffmpeg-core.wasm',
    'pdf.worker.mjs': '/vendor/lib/pdfjs-dist/build/pdf.worker.mjs',
    'pdfjs-standard_fonts': '/vendor/lib/pdfjs-dist/standard_fonts/',
    'pdfjs-cmaps': '/vendor/lib/pdfjs-dist/cmaps/',
  };
  return table[name] ?? null;
}

export function listLibs() {
  return Object.keys(LIBS);
}
