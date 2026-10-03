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
    'pdf.worker.mjs': vendorUrl('pdfjs-dist/build/pdf.worker.mjs'),
    'pdfjs-standard_fonts': vendorUrl('pdfjs-dist/standard_fonts/'),
    'pdfjs-cmaps': vendorUrl('pdfjs-dist/cmaps/'),
  };
  return table[name] ?? null;
}

export function listLibs() {
  return Object.keys(LIBS);
}

