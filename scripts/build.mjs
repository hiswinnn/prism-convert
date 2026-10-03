/**
 * 发行版构建：把 src/ 与所需的第三方资源拼成一个纯静态 dist/。
 *
 * 为什么要拷 node_modules 的一部分而不是打包：
 * 浏览器侧所有库都通过 /vendor/lib/<与 node_modules 相同的相对路径> 引用，
 * 库内部的相对 import 因此天然可用（pdfjs 的 worker、cmaps、字体，ffmpeg 的 esm 分块都是这种），
 * 既免去打包器，又保证 dist/ 与 node --test 用的是同一份模块代码。
 *
 * 用法：node scripts/build.mjs [--out dist]
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i]);
}
const OUT = resolve(ROOT, args.get('out') ?? 'dist');

/** 需要原样进入 dist 的第三方资源（相对 node_modules 的路径） */
const VENDOR = [
  'fflate/esm/browser.js',
  'xlsx/xlsx.mjs',
  'pdf-lib/dist/pdf-lib.esm.js',
  'pdfjs-dist/build/pdf.mjs',
  'pdfjs-dist/build/pdf.worker.mjs',
  'pdfjs-dist/standard_fonts',
  'pdfjs-dist/cmaps',
  'mammoth/mammoth.browser.min.js',
  // docx 的 ESM 构建是自包含的（内部无 import），只拷这一个，别把 umd/iife/cjs 变体也带上
  'docx/dist/index.mjs',
  'marked/lib/marked.esm.js',
  'turndown/lib/turndown.browser.es.js',
  'js-yaml/dist/js-yaml.mjs',
  '@ffmpeg/ffmpeg/dist/esm',
  // 只要 esm 版 core：module worker 用 `import(coreURL)` 加载它，umd 版加载不了（见 lib-loader.js 注释）。
  // 刻意不拷贝 30.7MB 的原始 .wasm——离线兜底用下面的 .gz（浏览器里 fflate 就地解压），
  // 省下 30MB 体积，安装器才能压在 100MB 以内（GitHub 单个 blob 的上限）。
  '@ffmpeg/core/dist/esm/ffmpeg-core.js',
  'libheif-js/libheif-wasm',
];

// 轻量版（桌面安装器用）：不内置音视频引擎、HEIC 解码、Word 生成、PDF 字体映射，
// 前两类首次用时走国内镜像秒级下载，后两类桌面版暂时退化为「只读不生成/依赖内嵌字体」。
// 目的只有一个：把安装器压在 GitHub 单文件 100MB 上限以内。Web 版（完整 dist）功能不受影响。
if (args.has('lite')) {
  const LITE_EXCLUDE = [
    '@ffmpeg/core/dist/esm/ffmpeg-core.js',
    'libheif-js/libheif-wasm',
    'docx/dist/index.mjs',
    'pdfjs-dist/cmaps',
    'pdfjs-dist/standard_fonts',
  ];
  for (let i = VENDOR.length - 1; i >= 0; i -= 1) {
    if (LITE_EXCLUDE.includes(VENDOR[i])) VENDOR.splice(i, 1);
  }
}

async function walk(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else out.push({ path: full, size: (await stat(full)).size, rel: relative(base, full) });
  }
  return out;
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

const t0 = Date.now();
console.log('清理输出目录…');
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

console.log('拷贝应用代码 src/ → dist/ …');
await cp(join(ROOT, 'src'), OUT, { recursive: true });

console.log('拷贝第三方资源到 dist/vendor/lib/ …');
const missing = [];
for (const rel of VENDOR) {
  const from = join(ROOT, 'node_modules', rel);
  if (!existsSync(from)) {
    missing.push(rel);
    continue;
  }
  const to = join(OUT, 'vendor', 'lib', rel);
  await mkdir(join(to, '..'), { recursive: true });
  await cp(from, to, { recursive: true });
}
if (missing.length) {
  console.warn(`  ⚠ 缺失（请检查依赖是否安装）：${missing.join(', ')}`);
}

// 音视频引擎额外产出 gzip 版：30.7MB → 约 9.8MB。
// 同源兜底时优先传它（浏览器用 fflate 解开），海外托管也能忍。
const wasmSource = join(ROOT, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm', 'ffmpeg-core.wasm');
if (existsSync(wasmSource) && !args.has('lite')) {
  const { gzipSync } = await import('node:zlib');
  const { readFileSync } = await import('node:fs');
  const gz = gzipSync(readFileSync(wasmSource), { level: 9 });
  const gzDest = join(OUT, 'vendor', 'lib', '@ffmpeg', 'core', 'dist', 'esm', 'ffmpeg-core.wasm.gz');
  await mkdir(join(gzDest, '..'), { recursive: true });
  await writeFile(gzDest, gz);
  console.log(`  引擎 gzip：${(gz.length / 1024 / 1024).toFixed(1)} MB（原始 ${(statSync(wasmSource).size / 1024 / 1024).toFixed(1)} MB）`);
}

// GitHub Pages 默认用 Jekyll 处理站点，会忽略下划线开头的文件/目录
await writeFile(join(OUT, '.nojekyll'), '');

const files = await walk(OUT);
const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
const sorted = [...files].sort((a, b) => b.size - a.size);
const oversize = sorted.filter((f) => f.size > 25 * 1024 * 1024);

const manifest = {
  builtAt: new Date().toISOString(),
  totalBytes,
  fileCount: files.length,
  biggest: sorted.slice(0, 8).map((f) => ({ path: f.rel.replace(/\\/g, '/'), mb: +(f.size / 1024 / 1024).toFixed(2) })),
  vendor: {},
};
// 关键资源留指纹，部署后能核对「线上是不是这份」
for (const rel of ['index.html', 'main.js', 'core/engine.js', 'vendor/lib/@ffmpeg/core/dist/umd/ffmpeg-core.wasm']) {
  const target = join(OUT, rel);
  if (existsSync(target)) manifest.vendor[rel] = (await sha256(target)).slice(0, 16);
}
await writeFile(join(OUT, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\n构建完成：${files.length} 个文件，共 ${(totalBytes / 1024 / 1024).toFixed(1)} MB，用时 ${Date.now() - t0} ms`);
for (const f of manifest.biggest) console.log(`  ${String(f.mb).padStart(6)} MB  ${f.path}`);
if (oversize.length) {
  console.log(`\n注意：有 ${oversize.length} 个文件超过 25MB（Cloudflare Pages 的单文件上限），GitHub Pages 可以，Cloudflare 需要另想办法。`);
}
console.log(`\ndist 目录：${OUT}`);
