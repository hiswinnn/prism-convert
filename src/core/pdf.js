/**
 * PDF 模块。
 *
 * 分工来自两个库的能力边界，不是随意拆分：
 *  - pdf-lib 负责「结构」：合并、拆页、旋转、把图片/文字排进新 PDF。它不解析内容流，也不渲染；
 *  - pdfjs-dist 负责「读懂」：抽取文字层、把页面画成位图。
 *
 * 两个最容易踩的坑在这里显式处理：
 *  1) PDF → 文字的中文粘连：pdfjs 把一行拆成若干 text item，直接拼会得到「你 好 世 界」之类的结果。
 *     assembleLines() 按基线聚类成行、按 x 排序，再按「中文不加空格、西文按间隙补空格」拼接。
 *  2) 文字 → PDF 的中文：pdf-lib 的内置字体只覆盖 WinAnsi，塞中文会直接抛错。这里提前检测并给出
 *     可执行的替代路径（导出 HTML 后用浏览器打印为 PDF），而不是让用户看到乱码或底层异常。
 */
import { ConversionError } from './errors.js';
import { baseNameOf, extOf, htmlEscape, mimeOfExt } from './util.js';
import { canvasToBlob, getCanvas, toPngBytes } from './image.js';

export const meta = {
  id: 'pdf',
  category: 'pdf',
  label: 'PDF',
  from: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'txt', 'md', 'html', 'svg'],
  to: ['pdf', 'png', 'jpg', 'txt', 'md', 'html'],
  priority: 85,
  options: [
    {
      key: 'pdfMode',
      type: 'select',
      label: 'PDF 处理方式',
      default: 'auto',
      choices: [
        { value: 'auto', label: '自动判断' },
        { value: 'extractText', label: '提取文字 → TXT/MD' },
        { value: 'render', label: '渲染成图片（每页一张）' },
        { value: 'merge', label: '图片/PDF 合并成一个 PDF' },
        { value: 'split', label: '拆分/抽取页面' },
        { value: 'rotate', label: '旋转页面' },
      ],
    },
    { key: 'renderScale', type: 'range', label: '渲染倍率（清晰度）', default: 2, min: 1, max: 3, step: 0.5 },
    { key: 'pages', type: 'text', label: '页码范围（如 1-3,7；留空=全部）', default: '' },
    { key: 'rotate', type: 'select', label: '旋转角度', default: '0', choices: [{ value: '0', label: '不旋转' }, { value: '90', label: '顺时针 90°' }, { value: '180', label: '180°' }, { value: '270', label: '270°' }] },
    { key: 'pageSize', type: 'select', label: '图片转 PDF 页面尺寸', default: 'fit', choices: [{ value: 'fit', label: '按图片比例' }, { value: 'a4', label: 'A4 居中' }] },
  ],
};

const A4 = { width: 595.28, height: 841.89 };
const TEXT_LAYOUT = { margin: 56, fontSize: 11, leading: 16.5 };
const RENDER_JPEG_QUALITY = 0.92;
/**
 * pdfjs 在浏览器里需要的静态资源路径。
 * 必须与 src/core/lib-loader.js 的 /vendor/lib 映射一致——dev-server 把 /vendor/lib/* 直接镜像到 node_modules，
 * 自己另编一套路径（例如 /vendor/pdfjs/）会 404，表现为「PDF 解析失败」或 worker 起不来。
 */
const PDFJS_ASSETS = {
  worker: '/vendor/lib/pdfjs-dist/build/pdf.worker.mjs',
  standardFonts: '/vendor/lib/pdfjs-dist/standard_fonts/',
  cmaps: '/vendor/lib/pdfjs-dist/cmaps/',
};

/* ------------------------------------------------------------------ *
 * 1. 文字拼接：PDF 文字层 → 行
 * ------------------------------------------------------------------ */

// 中日韩文字与全角标点：这些字符之间不能补空格，否则会得到「你 好 世 界」
const CJK_RE = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

function isCjkChar(ch) {
  return typeof ch === 'string' && ch.length > 0 && CJK_RE.test(ch);
}

function lastChar(text) {
  return text.length ? String.fromCodePoint(text.codePointAt(text.length - 1)) : '';
}

/**
 * 行内片段拼接。
 * 逐字分段的 PDF（很多排版软件都这样导出）里 item 之间的间隙是 0，靠固定加空格会变成「H e l l o」；
 * 而按词分段的 PDF 里词间间隙约等于一个空格宽，必须补空格。所以用间隙相对字号判断。
 */
function joinFragments(previous, next, gap, fontSize) {
  if (!previous) return next;
  if (/\s$/.test(previous) || /^\s/.test(next)) return previous + next;
  const boundaryIsCjk = isCjkChar(lastChar(previous)) || isCjkChar(next[0]);
  if (boundaryIsCjk) {
    // 中文字间距通常为 0；间隙超过一个半字宽说明是表格列/分栏，保留空白
    return gap > fontSize * 1.5 ? `${previous} ${next}` : previous + next;
  }
  return gap > fontSize * 0.25 ? `${previous} ${next}` : previous + next;
}

/**
 * 把 pdfjs 的 TextItem 数组整理成行数组。
 * @param {Array<{str:string, transform:number[], width?:number, height?:number}>} items
 * @returns {string[]}
 */
export function assembleLines(items) {
  const entries = [];
  for (const item of items ?? []) {
    const text = typeof item?.str === 'string' ? item.str : '';
    if (!text) continue;
    const transform = Array.isArray(item.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    const fontSize = Math.abs(Number(transform[3])) || Math.abs(Number(transform[1])) || 10;
    const width = Number(item.width);
    // 少数生成器会把整段塞进一个 item，内含换行；按行高降序拆开近似定位
    const parts = text.split('\n');
    parts.forEach((part, index) => {
      if (!part) return;
      entries.push({
        text: part,
        x,
        y: y - index * fontSize * 1.2,
        size: fontSize,
        width: Number.isFinite(width) ? width : part.length * fontSize * 0.5,
        breakBefore: index > 0,
      });
    });
  }
  if (!entries.length) return [];

  // PDF 的 y 轴向上，所以按 y 降序就是阅读顺序；同一行内再按 x 升序
  entries.sort((a, b) => b.y - a.y || a.x - b.x);

  const rows = [];
  let current = null;
  for (const entry of entries) {
    // 聚类阈值取半个字高：足够合并上下标/轻微抖动，又不会把相邻两行并成一行
    const tolerance = Math.max(2, Math.max(current?.size ?? entry.size, entry.size) * 0.5);
    if (!current || entry.breakBefore || Math.abs(entry.y - current.y) > tolerance) {
      current = { y: entry.y, size: entry.size, items: [entry] };
      rows.push(current);
    } else {
      current.items.push(entry);
    }
  }

  const lines = [];
  for (const row of rows) {
    const sorted = [...row.items].sort((a, b) => a.x - b.x);
    let text = '';
    let previous = null;
    for (const entry of sorted) {
      if (!previous) text = entry.text;
      else text = joinFragments(text, entry.text, entry.x - (previous.x + previous.width), Math.max(previous.size, entry.size));
      previous = entry;
    }
    if (text.trim()) lines.push(text);
  }
  return lines;
}

/* ------------------------------------------------------------------ *
 * 2. 页码范围
 * ------------------------------------------------------------------ */

/**
 * 解析「1-3,7」这类页码范围，返回 1 起的页码数组。
 * 严格校验：任何一段超出实际页数或写反都会报错——页码范围写错却静默产出半份文档，用户很难发现。
 * @param {string} spec
 * @param {number} pageCount
 * @returns {number[]}
 */
export function parsePageRange(spec, pageCount) {
  const total = Number(pageCount);
  if (!Number.isInteger(total) || total <= 0) {
    throw new ConversionError('PDF_PAGE_RANGE_INVALID', 'PDF 里没有可用的页面。');
  }
  const raw = String(spec ?? '').trim();
  if (!raw) return Array.from({ length: total }, (_, index) => index + 1);

  // 先把连字符两侧的空白吃掉（用户会写成「1 - 3」），再按中英文逗号、顿号、空白切分
  const normalized = raw.replace(/\s*([-\u2013\u2014~])\s*/g, '$1');
  const pages = [];
  const seen = new Set();
  for (const token of normalized.split(/[,\uFF0C\u3001\s]+/).filter(Boolean)) {
    const match = /^(\d+)(?:\s*[-\u2013\u2014~]\s*(\d+))?$/.exec(token);
    if (!match) {
      throw new ConversionError('PDF_PAGE_RANGE_INVALID', `页码范围里的「${token}」无法识别，请写成 1-3,7 这样的格式。`);
    }
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start < 1 || end < 1) {
      throw new ConversionError('PDF_PAGE_RANGE_INVALID', `页码范围里的「${token}」包含 0 或负数，PDF 页码从 1 开始。`);
    }
    if (end < start) {
      throw new ConversionError('PDF_PAGE_RANGE_INVALID', `页码范围里的「${token}」结束页小于起始页。`);
    }
    if (end > total) {
      throw new ConversionError('PDF_PAGE_RANGE_INVALID', `页码范围里的「${token}」超出文档页数（共 ${total} 页）。`);
    }
    for (let page = start; page <= end; page += 1) {
      if (seen.has(page)) continue;
      seen.add(page);
      pages.push(page);
    }
  }
  if (!pages.length) throw new ConversionError('PDF_PAGE_RANGE_INVALID', `页码范围「${raw}」没有解析出任何页面。`);
  return pages;
}

/** 把页码数组压成 1-3_7 这样的短标签，用于输出文件名 */
function pageLabel(pages) {
  const runs = [];
  for (const page of pages) {
    const last = runs[runs.length - 1];
    if (last && page === last.end + 1) last.end = page;
    else runs.push({ start: page, end: page });
  }
  return runs.map((run) => (run.start === run.end ? String(run.start) : `${run.start}-${run.end}`)).join('_');
}

/* ------------------------------------------------------------------ *
 * 3. 环境与库
 * ------------------------------------------------------------------ */

const isNodeRuntime = (api) =>
  api.env === 'node' ||
  (api.env === undefined && typeof document === 'undefined' && typeof createImageBitmap === 'undefined');

async function loadPdfLib(api) {
  const loaded = await api.lib('pdf-lib');
  const pdfLib = loaded?.PDFDocument ? loaded : (loaded?.default ?? loaded);
  if (typeof pdfLib?.PDFDocument !== 'function') {
    throw new ConversionError('PDF_ENGINE_UNAVAILABLE', 'PDF 生成引擎（pdf-lib）不可用。');
  }
  return pdfLib;
}

async function loadPdfJs(api) {
  // pdfjs 6 的现代构建依赖 DOM，在 Node 里会直接抛 UnknownErrorException，必须用 legacy 构建
  const specifier = isNodeRuntime(api) ? 'pdfjs-dist/legacy/build/pdf.mjs' : 'pdfjs-dist';
  const loaded = await api.lib(specifier);
  const pdfjs = loaded?.getDocument ? loaded : (loaded?.default ?? loaded);
  if (typeof pdfjs?.getDocument !== 'function') {
    throw new ConversionError('PDF_ENGINE_UNAVAILABLE', 'PDF 解析引擎（pdfjs-dist）不可用。');
  }
  if (!isNodeRuntime(api) && pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_ASSETS.worker;
  }
  return pdfjs;
}

function pdfjsDocumentOptions(api) {
  const options = {
    // pdfjs 会把 data 转移给 worker（原缓冲区会被 detach），必须传副本，否则上层拿到的输入字节会变空
    data: api.bytes().slice(),
    useSystemFonts: false,
    isEvalSupported: false,
  };
  if (!isNodeRuntime(api)) {
    options.standardFontDataUrl = PDFJS_ASSETS.standardFonts;
    options.cMapUrl = PDFJS_ASSETS.cmaps;
    options.cMapPacked = true;
    return options;
  }
  // Node 下不给这个参数，pdfjs 会对每个文档打一条告警，渲染标准字体时还会失败
  const fontsDir = nodeStandardFontsDir();
  if (fontsDir) options.standardFontDataUrl = fontsDir;
  return options;
}

/** 从本文件位置推出 pdfjs 的 standard_fonts 目录（仅 Node 用；浏览器里 import.meta.url 不是 file: 协议） */
function nodeStandardFontsDir() {
  try {
    const url = new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url);
    if (url.protocol !== 'file:') return null;
    const path = decodeURIComponent(url.pathname);
    // Windows 的 pathname 形如 /E:/...，去掉前导斜杠才是合法路径；POSIX 下前导斜杠必须保留
    return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/** 打开 PDF，并把 pdfjs 的底层异常翻译成用户能理解的错误 */
async function openPdf(api) {
  const pdfjs = await loadPdfJs(api);
  let task;
  try {
    task = pdfjs.getDocument(pdfjsDocumentOptions(api));
  } catch (err) {
    throw new ConversionError('PDF_PARSE_FAILED', 'PDF 解析失败：文件可能已损坏。', { cause: err });
  }
  try {
    const doc = await task.promise;
    return { doc, destroy: async () => { await task.destroy?.(); } };
  } catch (err) {
    await task.destroy?.().catch?.(() => {});
    const name = err?.name ?? '';
    if (name === 'PasswordException') {
      throw new ConversionError('PDF_ENCRYPTED', '这个 PDF 有密码保护，请先去掉密码再转换。', { cause: err });
    }
    throw new ConversionError('PDF_PARSE_FAILED', 'PDF 解析失败：文件可能已损坏或不是标准 PDF。', { cause: err });
  }
}

/* ------------------------------------------------------------------ *
 * 4. PDF → 文字
 * ------------------------------------------------------------------ */

async function extractText(api, pagesSpec) {
  const { doc, destroy } = await openPdf(api);
  try {
    const pages = parsePageRange(pagesSpec, doc.numPages);
    const lines = [];
    for (let index = 0; index < pages.length; index += 1) {
      api.progress(0.1 + (index / pages.length) * 0.75, `提取第 ${pages[index]} 页文字`);
      const page = await doc.getPage(pages[index]);
      const content = await page.getTextContent();
      lines.push(...assembleLines(content.items));
      page.cleanup?.();
    }
    return { lines, pages };
  } finally {
    await destroy();
  }
}

function textToMarkdown(text, title) {
  const heading = title ? `# ${title}\n\n` : '';
  // PDF 里没有可靠的段落信息，硬凑段落只会丢换行；每行按独立段落输出最忠实
  return `${heading}${text.split('\n').join('\n\n')}\n`;
}

function textToHtml(text, title) {
  const body = text
    .split('\n')
    .map((line) => (line.trim() ? `    <p>${htmlEscape(line)}</p>` : '    <p class="blank">&nbsp;</p>'))
    .join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title || 'PDF 文字')}</title>
<style>
  body { margin: 0 auto; max-width: 46rem; padding: 2.5rem 1.25rem; background: #f5f5f7; color: #1d1d1f;
    font: 16px/1.75 -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; }
  h1 { font-size: 1.5rem; margin: 0 0 1.5rem; }
  p { margin: 0 0 0.35rem; white-space: pre-wrap; }
  p.blank { margin: 0; }
  @media print { body { background: #fff; max-width: none; padding: 0; } }
</style>
</head>
<body>
  <h1>${htmlEscape(title || 'PDF 文字')}</h1>
${body}
</body>
</html>
`;
}

/* ------------------------------------------------------------------ *
 * 5. PDF → 图片
 * ------------------------------------------------------------------ */

async function renderPdfPages(api, pagesSpec, scale, target, baseName) {
  if (isNodeRuntime(api)) {
    throw new ConversionError('PDF_RENDER_UNAVAILABLE', '当前环境不支持 PDF 渲染，请在浏览器中使用。');
  }
  const mime = mimeOfExt(target);
  const canvasFactory = typeof api.getCanvas === 'function' ? api.getCanvas : getCanvas;
  const { doc, destroy } = await openPdf(api);
  const files = [];
  let pages = [];
  try {
    pages = parsePageRange(pagesSpec, doc.numPages);
    for (let index = 0; index < pages.length; index += 1) {
      api.progress(0.1 + (index / pages.length) * 0.8, `渲染第 ${pages[index]} 页`);
      const page = await doc.getPage(pages[index]);
      const viewport = page.getViewport({ scale });
      const surface = canvasFactory(Math.ceil(viewport.width), Math.ceil(viewport.height));
      if (!surface) {
        throw new ConversionError('PDF_RENDER_UNAVAILABLE', '当前环境没有 Canvas，无法渲染 PDF 页面，请在浏览器中使用。');
      }
      // 白底：PDF 页面本身没有背景色，不铺白的话 JPEG 里透明区会变黑
      surface.ctx.fillStyle = '#ffffff';
      surface.ctx.fillRect(0, 0, surface.canvas.width, surface.canvas.height);
      await page.render({ canvas: surface.canvas, canvasContext: surface.ctx, viewport }).promise;
      const blob = await canvasToBlob(surface.canvas, mime, target === 'jpg' ? RENDER_JPEG_QUALITY : undefined);
      files.push({
        name: `${baseName}-p${pages[index]}.${target}`,
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mime,
      });
      page.cleanup?.();
    }
  } finally {
    await destroy();
  }
  return { files, pages };
}

/* ------------------------------------------------------------------ *
 * 6. 图片 / 文字 → PDF
 * ------------------------------------------------------------------ */

/** pdf-lib 只认 PNG/JPEG；其余格式（BMP/WebP/HEIC/PNM…）先借图片模块栅格化成 PNG */
async function embedImage(pdfDoc, bytes, ext, api) {
  if (ext === 'jpg' || ext === 'jpeg') {
    try {
      return await pdfDoc.embedJpg(bytes);
    } catch {
      /* 少见的 JPEG 变体（如 CMYK）交给栅格化路径 */
    }
  }
  if (ext === 'png') {
    try {
      return await pdfDoc.embedPng(bytes);
    } catch {
      /* 16 位 / 隔行 PNG pdf-lib 解析不了，重新编码一份 */
    }
  }
  return pdfDoc.embedPng(await toPngBytes(bytes, ext, api));
}

function fitInside(size, page) {
  const scale = Math.min(page.width / size.width, page.height / size.height);
  const width = size.width * scale;
  const height = size.height * scale;
  return { x: (page.width - width) / 2, y: (page.height - height) / 2, width, height };
}

function addImagePage(pdfDoc, embedded, pageSize) {
  if (pageSize === 'a4') {
    const page = pdfDoc.addPage([A4.width, A4.height]);
    const box = fitInside({ width: embedded.width, height: embedded.height }, A4);
    page.drawImage(embedded, box);
    return page;
  }
  // 「按图片比例」：1 像素 = 1 点，页面与图片同比例，不做 DPI 猜测（打印尺寸让打印机缩放）
  const page = pdfDoc.addPage([embedded.width, embedded.height]);
  page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  return page;
}

const WINANSI_EXTRAS = new Set('\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178');

/** 内置标准字体只覆盖 WinAnsi；其它字符替换成 ? 并计数，避免 pdf-lib 直接抛底层异常 */
function toWinAnsiSafe(text) {
  let dropped = 0;
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === '\n' || ch === '\t') {
      out += ch;
      continue;
    }
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255) || WINANSI_EXTRAS.has(ch)) out += ch;
    else {
      dropped += 1;
      out += '?';
    }
  }
  return { text: out, dropped };
}

function wrapLine(text, font, size, maxWidth) {
  const lines = [];
  let current = '';
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${token}` : token;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = '';
    }
    if (font.widthOfTextAtSize(token, size) <= maxWidth) {
      current = token;
      continue;
    }
    let chunk = ''; // 超长单词（URL/长串）按字符硬切，否则会溢出版心
    for (const ch of token) {
      if (chunk && font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
        lines.push(chunk);
        chunk = ch;
      } else chunk += ch;
    }
    current = chunk;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function addTextPages(pdfDoc, text, font, rgb) {
  const { margin, fontSize, leading } = TEXT_LAYOUT;
  const maxWidth = A4.width - margin * 2;
  const lines = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    if (!paragraph.trim()) {
      lines.push('');
      continue;
    }
    lines.push(...wrapLine(paragraph, font, fontSize, maxWidth));
  }
  const perPage = Math.max(1, Math.floor((A4.height - margin * 2) / leading));
  for (let start = 0; start < lines.length; start += perPage) {
    const page = pdfDoc.addPage([A4.width, A4.height]);
    let y = A4.height - margin;
    for (const line of lines.slice(start, start + perPage)) {
      if (line) page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0.13, 0.13, 0.15) });
      y -= leading;
    }
  }
  if (!lines.length) pdfDoc.addPage([A4.width, A4.height]);
}

/* ---------------------------- 纯文本化 ---------------------------- */

function decodeEntities(text) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    mdash: '\u2014', ndash: '\u2013', hellip: '\u2026',
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function htmlToPlainText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|h[1-6]|tr|li|blockquote)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\u2022 ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function markdownToPlainText(markdown) {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/, '') // front-matter 不属于正文
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '\u2022 ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/* ------------------------------------------------------------------ *
 * 7. 输入收集与模式判定
 * ------------------------------------------------------------------ */

function describeInput(item, fallbackName) {
  const name = String(item?.name ?? fallbackName ?? 'input');
  const ext = (item?.ext || extOf(name) || '').toLowerCase();
  const bytes = item?.bytes instanceof Uint8Array ? item.bytes : new Uint8Array(item?.bytes ?? []);
  return { name, ext, bytes };
}

/**
 * 支持多输入（合并 PDF 的典型用法）。
 * 语义：input.files 存在时它就是完整输入列表；没有 files 时才退回单输入 api.input。
 * 二者混着算会把主输入重复算一次，合并出来的页数直接翻倍。
 */
function collectInputs(input, api) {
  const primary = describeInput(api.input ?? input, 'input.pdf');
  const extras = Array.isArray(input?.files)
    ? input.files.map((item) => describeInput(item, primary.name))
    : [];
  const list = extras.length ? extras : [primary];
  const usable = list.filter((item) => item.bytes.length > 0);
  return usable.length ? usable : list.slice(0, 1);
}

function resolveTarget(api, input) {
  const explicit = api.opt('target', undefined) ?? api.opt('format', undefined) ?? input?.target ?? input?.to;
  const value = String(explicit ?? '').trim().toLowerCase().replace(/^\./, '');
  return value === 'jpeg' ? 'jpg' : value;
}

/** 每种处理方式能产出什么；显式指定了不匹配的组合时要当场说清楚，而不是产出扩展名与选项矛盾的文件 */
const MODES = {
  extractText: { label: '提取文字', outputs: ['txt', 'md', 'html'] },
  render: { label: '渲染成图片', outputs: ['png', 'jpg'] },
  merge: { label: '合并成一个 PDF', outputs: ['pdf'] },
  split: { label: '拆分/抽取页面', outputs: ['pdf'] },
  rotate: { label: '旋转页面', outputs: ['pdf'] },
};

function resolveMode(api, sources, target) {
  const requested = String(api.opt('pdfMode', 'auto') ?? 'auto');
  if (requested && requested !== 'auto') {
    if (!MODES[requested]) {
      throw new ConversionError('PDF_MODE_UNSUPPORTED', `不认识的处理方式「${requested}」。`);
    }
    if (!MODES[requested].outputs.includes(target)) {
      throw new ConversionError(
        'PDF_MODE_TARGET_CONFLICT',
        `「${MODES[requested].label}」产出的是 ${MODES[requested].outputs.join('/').toUpperCase()}，与目标 .${target} 不一致，请二选一。`,
      );
    }
    return requested;
  }
  const hasPdf = sources.some((item) => item.ext === 'pdf');
  if (!hasPdf) return target === 'pdf' ? 'merge' : null;
  if (target === 'txt' || target === 'md' || target === 'html') return 'extractText';
  if (target === 'png' || target === 'jpg') return 'render';
  if (target !== 'pdf') return null;
  if (String(api.opt('pages', '') ?? '').trim()) return 'split';
  if (String(api.opt('rotate', '0') ?? '0') !== '0') return 'rotate';
  return 'merge';
}

/* ------------------------------------------------------------------ *
 * 8. convert
 * ------------------------------------------------------------------ */

export async function convert(input, api) {
  const sources = collectInputs(input, api);
  const primary = sources[0];
  const target = resolveTarget(api, input) || (primary.ext === 'pdf' ? 'txt' : 'pdf');
  if (!meta.to.includes(target)) {
    throw new ConversionError('PDF_TARGET_UNSUPPORTED', `PDF 模块不支持输出 .${target}；可选：${meta.to.join(' / ')}。`);
  }
  const mode = resolveMode(api, sources, target);
  if (!mode) {
    throw new ConversionError(
      'PDF_MODE_UNSUPPORTED',
      `无法自动判断怎么把 ${primary.ext ? `.${primary.ext}` : '这个文件'} 转成 .${target}；请手动选择「PDF 处理方式」。`,
    );
  }

  const baseName = baseNameOf(primary.name) || 'document';
  const notes = [];
  const addNote = (level, message) => {
    notes.push({ level, message });
    api.note?.(level, message);
  };
  const files = [];
  let preview;

  if (mode === 'extractText') {
    if (primary.ext !== 'pdf') {
      throw new ConversionError('PDF_MODE_UNSUPPORTED', '「提取文字」只适用于 PDF 输入。');
    }
    const { lines, pages } = await extractText(api, api.opt('pages', ''));
    api.progress(0.9, '整理文字');
    const text = lines.join('\n');
    if (!text.trim()) {
      addNote('warn', '这个 PDF 没有可提取的文字层（扫描件或纯图 PDF），可以改用「渲染成图片」后做 OCR。');
    }
    if (target === 'html') {
      files.push({ name: api.fileName(`${baseName}.html`), bytes: api.encode(textToHtml(text, baseName)), mime: 'text/html' });
    } else if (target === 'md') {
      files.push({ name: api.fileName(`${baseName}.md`), bytes: api.encode(textToMarkdown(text, baseName)), mime: 'text/markdown' });
    } else {
      files.push({ name: api.fileName(`${baseName}.txt`), bytes: api.encode(text), mime: 'text/plain' });
    }
    addNote('info', `已提取 ${pages.length} 页、${lines.length} 行文字。`);
    preview = text.slice(0, 2000);
  } else if (mode === 'render') {
    if (primary.ext !== 'pdf') throw new ConversionError('PDF_MODE_UNSUPPORTED', '「渲染成图片」只适用于 PDF 输入。');
    const scale = Math.min(3, Math.max(1, Number(api.opt('renderScale', 2)) || 2));
    const { files: rendered, pages } = await renderPdfPages(api, api.opt('pages', ''), scale, target, baseName);
    if (rendered.length > 1) {
      // 多页必然是一堆图，打包下载比让用户点 20 次更合适
      files.push({
        name: api.fileName(`${baseName}-${target}.zip`),
        bytes: api.zip(rendered),
        mime: 'application/zip',
      });
      addNote('info', `已把 ${rendered.length} 页导出为 ${target.toUpperCase()} 并打包成 zip。`);
    } else {
      files.push({ name: api.fileName(rendered[0].name), bytes: rendered[0].bytes, mime: rendered[0].mime });
      addNote('info', `已渲染 ${pages.length} 页。`);
    }
    preview = `渲染 ${pages.length} 页，倍率 ${scale}x`;
  } else if (mode === 'split') {
    if (primary.ext !== 'pdf') throw new ConversionError('PDF_MODE_UNSUPPORTED', '「拆分/抽取页面」只适用于 PDF 输入。');
    const pdfLib = await loadPdfLib(api);
    const source = await loadPdfDocument(pdfLib, primary.bytes);
    const pages = parsePageRange(api.opt('pages', ''), source.getPageCount());
    const out = await pdfLib.PDFDocument.create();
    const copied = await out.copyPages(source, pages.map((page) => page - 1));
    copied.forEach((page) => out.addPage(page));
    files.push({
      name: api.fileName(`${baseName}-p${pageLabel(pages)}.pdf`),
      bytes: await out.save(),
      mime: 'application/pdf',
    });
    addNote('info', `已抽取 ${pages.length} 页（第 ${pageLabel(pages)} 页）。`);
    preview = `抽取第 ${pageLabel(pages)} 页`;
  } else if (mode === 'rotate') {
    if (primary.ext !== 'pdf') throw new ConversionError('PDF_MODE_UNSUPPORTED', '「旋转页面」只适用于 PDF 输入。');
    const angle = normalizeRotation(api.opt('rotate', '0'));
    if (angle === 0) throw new ConversionError('PDF_ROTATE_INVALID', '旋转角度是 0°，没有需要旋转的页面。');
    const pdfLib = await loadPdfLib(api);
    const source = await loadPdfDocument(pdfLib, primary.bytes);
    const pages = parsePageRange(api.opt('pages', ''), source.getPageCount());
    for (const pageNumber of pages) {
      const page = source.getPage(pageNumber - 1);
      // 与已有旋转叠加：旋转过的扫描件再转 90° 不会转回原点
      const current = page.getRotation().angle ?? 0;
      page.setRotation(pdfLib.degrees((current + angle) % 360));
    }
    files.push({ name: api.fileName(`${baseName}.pdf`), bytes: await source.save(), mime: 'application/pdf' });
    addNote('info', `已把 ${pages.length} 页顺时针旋转 ${angle}°。`);
    preview = `旋转 ${pages.length} 页 ${angle}°`;
  } else if (mode === 'merge') {
    const merged = await mergeToPdf(sources, api, { addNote });
    files.push(...merged.files);
    preview = merged.preview;
  } else {
    throw new ConversionError('PDF_MODE_UNSUPPORTED', `不支持的处理方式「${mode}」。`);
  }

  api.progress(1, '完成');
  return { files, preview, notes: notes.length ? notes : undefined };
}

/** pdf-lib 载入 PDF；加密文档给出可执行的提示 */
async function loadPdfDocument(pdfLib, bytes) {
  if (!bytes?.length) throw new ConversionError('PDF_EMPTY', 'PDF 内容为空，无法处理。');
  try {
    return await pdfLib.PDFDocument.load(bytes.slice(), { ignoreEncryption: true, updateMetadata: false });
  } catch (err) {
    throw new ConversionError('PDF_PARSE_FAILED', 'PDF 解析失败：文件可能已损坏或受密码保护。', { cause: err });
  }
}

function normalizeRotation(value) {
  const angle = Number(value);
  if (![0, 90, 180, 270].includes(angle)) {
    throw new ConversionError('PDF_ROTATE_INVALID', `旋转角度 ${value} 无效，只支持 0/90/180/270。`);
  }
  return angle;
}

/**
 * 合并：图片 / 文本 / PDF → 一个 PDF。
 * 页面尺寸只对图片生效（pageSize 选项的文案就是这么写的），文字页固定 A4。
 */
async function mergeToPdf(sources, api, { addNote }) {
  const pdfLib = await loadPdfLib(api);
  const { PDFDocument, StandardFonts, rgb } = pdfLib;
  const out = await PDFDocument.create();
  const pageSize = String(api.opt('pageSize', 'fit')) === 'a4' ? 'a4' : 'fit';
  const pagesOption = api.opt('pages', '');
  if (sources.length > 1 && String(pagesOption).trim()) {
    addNote('warn', '合并多份文件时页码范围不生效（同一范围套到每份文档上没有意义），已整份合并。');
  }
  let font = null;
  let droppedChars = 0;
  const files = [];

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    api.progress(0.1 + (index / sources.length) * 0.7, `处理 ${source.name}`);
    if (source.ext === 'pdf') {
      const src = await loadPdfDocument(pdfLib, source.bytes);
      // 只有单输入时页码范围才无歧义；合并多份文件时同一个页码范围套到每份文档上一定是错的
      const useRange = sources.length === 1 && String(pagesOption).trim();
      const pages = useRange
        ? parsePageRange(pagesOption, src.getPageCount())
        : Array.from({ length: src.getPageCount() }, (_, i) => i + 1);
      const copied = await out.copyPages(src, pages.map((page) => page - 1));
      copied.forEach((page) => out.addPage(page));
      continue;
    }

    if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif', 'heic', 'heif', 'ico', 'pnm', 'ppm', 'pgm', 'pbm', 'tiff'].includes(source.ext)) {
      const embedded = await embedImage(out, source.bytes, source.ext, api);
      addImagePage(out, embedded, pageSize);
      continue;
    }

    if (source.ext === 'svg') {
      if (isNodeRuntime(api)) {
        throw new ConversionError('PDF_SVG_UNAVAILABLE', 'SVG 转 PDF 需要浏览器把矢量图栅格化；请在浏览器中转换，或先导出为 PNG。');
      }
      const embedded = await out.embedPng(await toPngBytes(source.bytes, 'svg', api));
      addImagePage(out, embedded, pageSize);
      continue;
    }

    if (['txt', 'md', 'html', 'htm'].includes(source.ext) || source.ext === '') {
      const raw = api.decode(source.bytes);
      const text = source.ext === 'md'
        ? markdownToPlainText(raw)
        : (source.ext === 'html' || source.ext === 'htm' ? htmlToPlainText(raw) : raw);
      assertLatinOnly(text);
      if (!font) font = await out.embedFont(StandardFonts.Helvetica);
      const safe = toWinAnsiSafe(text);
      droppedChars += safe.dropped;
      addTextPages(out, safe.text, font, rgb);
      continue;
    }

    throw new ConversionError('PDF_INPUT_UNSUPPORTED', `合并时无法处理 .${source.ext} 文件，请先转成 PDF 或 PNG。`);
  }

  if (out.getPageCount() === 0) {
    throw new ConversionError('PDF_EMPTY', '没有可以放进 PDF 的内容。');
  }
  if (droppedChars > 0) {
    addNote('warn', `有 ${droppedChars} 个字符无法用内置 Latin 字体排版（如 emoji、俄文），已替换为 ?。`);
  }
  const name = sources.length > 1 ? 'merged.pdf' : `${baseNameOf(sources[0].name) || 'document'}.pdf`;
  files.push({ name: api.fileName(name), bytes: await out.save(), mime: 'application/pdf' });
  return { files, preview: `合并 ${out.getPageCount()} 页` };
}

/** 内置标准字体没有中文字形，与其输出乱码不如直接告诉用户替代路径 */
function assertLatinOnly(text) {
  if (CJK_RE.test(text)) {
    throw new ConversionError(
      'PDF_CJK_FONT_UNAVAILABLE',
      '纯前端环境缺少中文字体，无法把中文文本排进 PDF；请改为导出 HTML，再用浏览器「打印 → 另存为 PDF」。',
    );
  }
}
