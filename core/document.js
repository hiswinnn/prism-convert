/**
 * 文档模块：docx / txt / md / html / htm / rtf / epub / odt 互转。
 *
 * 为什么内部只有两种中间表示（Markdown + HTML）：
 * 8 种输入扩展名 × 5 种输出 = 40 条边，逐条实现既写不完也测不完。
 * 读取器只负责把任何输入变成 { markdown, html }，写出器只从这两种表示产出结果：
 * Markdown 承载结构（标题/列表/表格/代码/强调），HTML 承载排版保真（docx、epub、网页原文）。
 *
 * 环境约束（浏览器与 Node 共用同一份代码）：
 * - 没有 DOM：HTML 一律用正则/词法处理，不 new DOMParser；
 * - 没有 canvas：图片只做 base64 透传，不解码像素。
 */
import { ConversionError } from './errors.js';
import { lastEncodeWarning } from './encoding.js';
import { baseNameOf, clamp, htmlEscape, mimeOfExt } from './util.js';

/** @typedef {import('./types.js').Api} Api */

export const meta = {
  id: 'document',
  category: 'document',
  label: '文档',
  from: ['docx', 'txt', 'md', 'html', 'htm', 'rtf', 'epub', 'odt'],
  to: ['txt', 'md', 'html', 'docx', 'epub'],
  priority: 70,
  options: [
    {
      key: 'headingStyle', type: 'select', label: '标题样式', default: 'hash',
      choices: [
        { value: 'hash', label: '# 号（Markdown）' },
        { value: 'number', label: '一、二、三' },
        { value: 'plain', label: '不加标记' },
      ],
    },
    { key: 'keepImages', type: 'boolean', label: 'docx 转出时保留图片（html 输出为内嵌 base64）', default: true },
    { key: 'encoding', type: 'encoding', label: '输出编码', default: 'utf-8' },
    { key: 'title', type: 'text', label: '导出文档标题', default: '' },
  ],
};

const HEADING_STYLES = new Set(['hash', 'number', 'plain']);

/** 正文与代码字体：东亚字形必须走 eastAsia，否则 Word 里中文会掉到默认字体、字重也跟着错 */
const FONT_BODY = { ascii: 'Microsoft YaHei', hAnsi: 'Microsoft YaHei', eastAsia: '宋体', cs: 'Microsoft YaHei' };
const FONT_CODE = { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: '宋体', cs: 'Consolas' };

const ORDERED_LIST_REFERENCE = 'prism-ordered-list';

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * @param {import('./types.js').Input} input
 * @param {Api} api
 */
export async function convert(input, api) {
  // 契约把输入信息挂在 api.input 上，但引擎同时把 input 传了进来；两边取并集，缺谁都能跑
  const inputInfo = { ...(input ?? {}), ...(api.input ?? {}) };
  const options = readOptions(api, inputInfo);
  const notes = [];
  const note = (level, message) => {
    notes.push({ level, message });
    api.note(level, message);
  };

  const source = normalizeExt(inputInfo.ext || inputInfo.name);
  const target = readTarget(api, inputInfo);

  api.progress(0.05, '识别文档格式');
  const docModel = await readDocument(source, api, options, note);

  api.progress(0.55, '生成输出文件');
  const produced = await writeDocument(target, docModel, options, api, note);

  api.progress(1, '转换完成');
  return {
    files: [{ name: produced.name, bytes: produced.bytes, mime: produced.mime }],
    preview: produced.previewText.slice(0, 2000),
    notes,
  };
}

function readOptions(api, inputInfo) {
  const headingStyle = String(api.opt('headingStyle', 'hash') ?? 'hash');
  const keepImages = api.opt('keepImages', true);
  return {
    headingStyle: HEADING_STYLES.has(headingStyle) ? headingStyle : 'hash',
    // 界面可能把布尔传成字符串，显式识别 'false'
    keepImages: !(keepImages === false || keepImages === 'false' || keepImages === 0),
    encoding: String(api.opt('encoding', 'utf-8') ?? 'utf-8'),
    title: String(api.opt('title', '') ?? '').trim(),
    // 输出文件名与默认书名都用它，避免文件名在各处重复推导
    stem: baseNameOf(inputInfo.name || '未命名文档'),
  };
}

function normalizeExt(value) {
  const raw = String(value ?? '').split(/[\\/]/).pop() ?? '';
  const dot = raw.lastIndexOf('.');
  const ext = (dot > 0 ? raw.slice(dot + 1) : raw).trim().toLowerCase();
  if (ext === 'markdown' || ext === 'mdx') return 'md';
  if (ext === 'htm') return 'html';
  return ext;
}

/**
 * 目标格式由引擎选择。契约没有把 target 写进 options 表，各家引擎叫法不一，
 * 因此从所有合理的位置取一遍；都取不到时退回 txt（纯文本永远能生成）。
 */
function readTarget(api, inputInfo) {
  const candidates = [
    inputInfo.target, inputInfo.to, api.target,
    api.opt('target', ''), api.opt('format', ''), api.opt('output', ''),
  ];
  for (const candidate of candidates) {
    const ext = normalizeExt(typeof candidate === 'object' ? candidate?.ext ?? candidate?.name : candidate);
    if (ext) return ext;
  }
  return 'txt';
}

/* ------------------------------------------------------------------ *
 * 库加载：浏览器是 UMD/全局，Node 是 CJS 或 ESM 命名空间，取法必须兼容
 * ------------------------------------------------------------------ */

function bindLib(mod, probe, name) {
  for (const candidate of [mod, mod?.default]) {
    if (candidate && probe(candidate)) return candidate;
  }
  throw new ConversionError('LIB_UNAVAILABLE', `${name} 组件加载失败，页面可能没有完整预热 vendor 目录。请刷新页面后重试。`, {
    detail: `api.lib('${name}') 返回的对象不符合预期`,
  });
}

async function loadMammoth(api) {
  return bindLib(await api.lib('mammoth'), (m) => typeof m.convertToHtml === 'function', 'mammoth');
}

async function loadDocx(api) {
  return bindLib(await api.lib('docx'), (m) => typeof m.Document === 'function' && typeof m.Packer === 'function', 'docx');
}

async function loadFflate(api) {
  return bindLib(await api.lib('fflate'), (m) => typeof m.unzipSync === 'function' && typeof m.zipSync === 'function', 'fflate');
}

async function loadMarked(api) {
  const mod = await api.lib('marked');
  const marked = mod?.marked ?? mod?.default?.marked ?? mod?.default ?? mod;
  if (!marked || typeof marked.lexer !== 'function') {
    throw new ConversionError('LIB_UNAVAILABLE', 'marked 组件加载失败，无法解析 Markdown。请刷新页面后重试。');
  }
  return marked;
}

async function loadTurndown(api) {
  const mod = await api.lib('turndown');
  const Service = typeof mod === 'function' ? mod : mod?.default;
  if (typeof Service !== 'function') {
    throw new ConversionError('LIB_UNAVAILABLE', 'turndown 组件加载失败，无法把网页转换为 Markdown。请刷新页面后重试。');
  }
  return Service;
}

/* ------------------------------------------------------------------ *
 * 读取器：任何输入 → { markdown, html, title }
 * ------------------------------------------------------------------ */

async function readDocument(source, api, options, note) {
  switch (source) {
    case 'docx':
      return readDocx(api, options, note);
    case 'md':
    case 'txt':
    case '':
      return readPlainText(api, options);
    case 'html':
      return readHtml(api, options, note);
    case 'rtf':
      return readRtf(api, options, note);
    case 'epub':
      return readEpub(api, options, note);
    case 'odt':
      return readOdt(api, options, note);
    default:
      throw new ConversionError(
        'UNSUPPORTED_SOURCE',
        `文档模块不支持 .${source || '未知'} 格式的输入。可接受：docx、txt、md、html、rtf、epub、odt。`,
      );
  }
}

/** 书名/标题优先级：用户填的 → 源文件自带的（docx 属性、<title>、dc:title）→ 输入文件名 */
function fallbackTitle(options, sourceTitle) {
  return options.title || String(sourceTitle ?? '').trim() || options.stem;
}

/* ---------- docx ---------- */

async function readDocx(api, options, note) {
  const mammoth = await loadMammoth(api);
  const imageCount = { embedded: 0, skipped: 0 };

  let result;
  try {
    // mammoth 在 Node 用 { buffer }、浏览器用 { arrayBuffer }，两个都给才两边都能跑
    const arrayBuffer = toArrayBuffer(api.bytes());
    result = await mammoth.convertToHtml(
      { arrayBuffer, buffer: arrayBuffer },
      {
        // keepImages=false 时仍然接管图片转换，只是不写 src：这样能数出「忽略了 N 张图片」，
        // 而不是让 mammoth 的默认 dataUri 转换器悄悄把 base64 塞进结果。
        convertImage: mammoth.images.imgElement(async (image) => {
          if (!options.keepImages) {
            imageCount.skipped += 1;
            return {};
          }
          imageCount.embedded += 1;
          const base64 = await image.read('base64');
          return { src: `data:${image.contentType};base64,${base64}` };
        }),
        // 我们自己生成的 docx 用这两个样式标记代码块与引用；mammoth 默认不认，
        // 不补映射的话往返一次代码块就退化成普通段落。
        styleMap: [
          "p[style-name='Prism Code'] => pre:separator('\\n')",
          "p[style-name='Prism Quote'] => blockquote:fresh",
        ],
      },
    );
  } catch (err) {
    throw new ConversionError(
      'DOCX_CORRUPT',
      'docx 解析失败：文件可能已损坏，或者并不是真正的 Word 文档（把 .doc、.rtf 直接改后缀是不行的）。请用 Word/WPS 打开后另存为 .docx 再试。',
      { cause: err },
    );
  }

  let html = stripNoiseHtml(String(result.value ?? ''));
  if (!options.keepImages) {
    html = html.replace(/<img\b[^>]*>/gi, '');
  }

  const turndown = await createTurndown(api);
  const markdown = toMarkdown(turndown, html || '<p></p>');

  const ignored = countIgnoredElements(result.messages ?? [], note);
  if (imageCount.embedded > 0) note('info', `已内嵌 ${imageCount.embedded} 张图片（base64 直接写进结果文件）`);
  if (imageCount.skipped > 0) note('info', `按设置忽略了 ${imageCount.skipped} 张图片`);
  if (ignored > 0) note('warn', `忽略了 ${ignored} 个 docx 里不支持的元素（如文本框、艺术字、批注）`);

  return {
    markdown,
    html,
    title: fallbackTitle(options, ''),
    hasEmbeddedImages: imageCount.embedded > 0,
  };
}

function countIgnoredElements(messages, note) {
  let ignored = 0;
  for (const message of messages) {
    if (message?.type === 'error') {
      note('warn', `docx 内容有损坏片段，已跳过：${message.message}`);
    } else if (/unrecognis|not supported|unsupported|ignored/i.test(String(message?.message ?? ''))) {
      ignored += 1;
    }
  }
  return ignored;
}

/* ---------- txt / md ---------- */

function readPlainText(api, options) {
  const text = String(api.text() ?? '').replace(/^\uFEFF/, '');
  return { markdown: text.trim(), html: null, title: fallbackTitle(options, '') };
}

/* ---------- html ---------- */

async function readHtml(api, options, note) {
  const raw = String(api.text() ?? '');
  const sourceTitle = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(raw)?.[1] ?? '';
  const body = stripNoiseHtml(extractBodyHtml(raw));
  const { text: plain, ignored } = htmlToPlainText(body, 'plain');
  if (ignored > 0) note('info', `忽略了 ${ignored} 个脚本/样式元素，只保留可读正文`);
  if (!plain) note('warn', '网页里没有提取到可读正文，输出可能为空');
  const turndown = await createTurndown(api);
  return {
    markdown: toMarkdown(turndown, body),
    html: body,
    title: fallbackTitle(options, decodeHtmlEntities(sourceTitle)),
  };
}

function extractBodyHtml(html) {
  const source = String(html ?? '');
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(source);
  if (body) return body[1].trim();
  return source
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '')
    .trim();
}

/* ---------- rtf ---------- */

const CODEPAGE_TO_ENCODING = {
  437: 'windows-1252', 850: 'windows-1252', 936: 'gb18030', 950: 'big5',
  932: 'shift_jis', 949: 'euc-kr', 1252: 'windows-1252', 65001: 'utf-8',
  10000: 'windows-1252', 1200: 'utf-16le',
};

/** 整组丢弃的 RTF 目的地：字体表/颜色表/批注/页眉页脚等对纯文本没有意义 */
const RTF_SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'themedata', 'datastore',
  'latentstyles', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator',
  'filetbl', 'revtbl', 'colorschememapping', 'mmathpr', 'wgrffmtfilter', 'header', 'headerl',
  'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'footnote', 'annotation',
  'comment', 'docvar', 'bkmkstart', 'bkmkend', 'nonshppict', 'shppict', 'falt', 'xmlopen',
]);

function readRtf(api, options, note) {
  const raw = String(api.text() ?? '');
  if (!/^\s*\{\\rtf/.test(raw.replace(/^\uFEFF/, ''))) {
    throw new ConversionError(
      'RTF_UNSUPPORTED',
      '这不是 RTF 文件：文件开头缺少 {\\rtf 标记。RTF 是纯文本格式，如果你手上的其实是 .doc，请用 Word 另存为 .docx 或 .rtf。',
    );
  }
  const { text, ignoredDestinations, usedCodepage } = parseRtf(raw, api);
  const cleaned = normalizeBlankLines(text);
  if (!cleaned) note('warn', 'RTF 里没有提取到正文文字（可能整篇都是图片或表格对象）');
  if (ignoredDestinations > 0) note('info', `忽略了 ${ignoredDestinations} 个 RTF 目标组（字体表、颜色表、批注等）`);
  if (usedCodepage && usedCodepage !== 65001 && /[^\x00-\x7f]/.test(raw)) {
    // 只在文件确实含高位字节时提示，避免给纯 ASCII 的 RTF 添噪音
    note('info', `RTF 声明的代码页是 ${usedCodepage}，已按对应字符集解码中文`);
  }
  return { markdown: cleaned, html: null, title: fallbackTitle(options, '') };
}

/**
 * 够用的 RTF 解析器：不做完整还原，只保证中文不乱码、段落与缩进不丢。
 * 坑：\'hh 是「按 \ansicpg 解释的字节」，必须攒成字节串整体解码，
 * 逐个字节转字符会把 GBK 双字节拆成乱码。
 */
function parseRtf(source, api) {
  const src = String(source);
  let i = 0;
  let ansicpg = 1252;
  let ucCount = 1;
  let ignoredDestinations = 0;
  let sawCodepage = false;
  const out = [];
  let hexBytes = [];
  const skipStack = [false];
  const skipping = () => skipStack[skipStack.length - 1];

  const flushHex = () => {
    if (!hexBytes.length) return;
    const bytes = Uint8Array.from(hexBytes);
    hexBytes = [];
    out.push(api.decode(bytes, CODEPAGE_TO_ENCODING[ansicpg] ?? 'windows-1252'));
  };
  const emit = (text) => {
    if (skipping()) return;
    flushHex();
    out.push(text);
  };

  function skipGroup() {
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          return;
        }
      }
      i += 1;
    }
  }

  function readControl() {
    const ch = src[i];
    if (ch === undefined) return {};
    if (ch === "'") {
      const hex = src.slice(i + 1, i + 3);
      i += 3;
      const byte = Number.parseInt(hex, 16);
      if (!skipping() && Number.isFinite(byte)) hexBytes.push(byte);
      return {};
    }
    if (ch === '*') {
      i += 1;
      return { skipGroup: true };
    }
    if (!/[A-Za-z]/.test(ch)) {
      i += 1;
      if (ch === '~') emit('\u00a0');
      else if (ch === '_') emit('-');
      else if (ch === '{' || ch === '}' || ch === '\\') emit(ch);
      // \- 可选连字符、\<换行> 之类没有可见输出
      return {};
    }
    let word = '';
    while (i < src.length && /[A-Za-z]/.test(src[i])) {
      word += src[i];
      i += 1;
    }
    let sign = 1;
    if (src[i] === '-') {
      sign = -1;
      i += 1;
    }
    let digits = '';
    while (i < src.length && /[0-9]/.test(src[i])) {
      digits += src[i];
      i += 1;
    }
    if (src[i] === ' ') i += 1; // 控制字后的一个空格是分隔符，不属于正文
    return applyControl(word.toLowerCase(), digits === '' ? null : sign * Number(digits));
  }

  function applyControl(word, param) {
    if (RTF_SKIP_DESTINATIONS.has(word)) {
      ignoredDestinations += 1;
      return { skipGroup: true };
    }
    switch (word) {
      case 'u': {
        if (param === null) return {};
        const code = param < 0 ? param + 65536 : param;
        if (code >= 0 && code <= 0x10ffff) emit(String.fromCodePoint(code));
        // \uN 后面跟的是 ANSI 回退字符（通常是 ?），按 \ucN 声明的个数丢掉
        let remaining = Math.max(0, ucCount);
        while (remaining > 0 && i < src.length && !'{}'.includes(src[i]) && src[i] !== '\\') {
          i += 1;
          remaining -= 1;
        }
        return {};
      }
      case 'uc':
        if (param !== null) ucCount = param;
        return {};
      case 'ansicpg':
        if (param !== null) {
          ansicpg = param;
          sawCodepage = true;
        }
        return {};
      case 'par':
      case 'sect':
        emit('\n\n');
        return {};
      case 'line':
        emit('\n');
        return {};
      case 'tab':
        emit('\t');
        return {};
      case 'lquote':
        emit('\u2018');
        return {};
      case 'rquote':
        emit('\u2019');
        return {};
      case 'ldblquote':
        emit('\u201c');
        return {};
      case 'rdblquote':
        emit('\u201d');
        return {};
      case 'endash':
        emit('\u2013');
        return {};
      case 'emdash':
        emit('\u2014');
        return {};
      case 'bullet':
        emit('\u2022');
        return {};
      case 'ud':
        // \ud 后面是给老阅读器的替代表示，收到 Unicode 后应整组丢弃
        return { skipNextGroup: true };
      default:
        // 字体、字号、颜色、对齐、域代码……对纯文本没有意义，一律忽略
        return {};
    }
  }

  function parseGroup() {
    i += 1; // 吃掉 '{'
    skipStack.push(skipping());
    let pendingSkipNext = false;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '}') {
        i += 1;
        break;
      }
      if (ch === '{') {
        if (pendingSkipNext) {
          pendingSkipNext = false;
          skipGroup();
        } else parseGroup();
        continue;
      }
      if (ch === '\\') {
        i += 1;
        const directive = readControl();
        if (directive.skipGroup) skipStack[skipStack.length - 1] = true;
        if (directive.skipNextGroup) pendingSkipNext = true;
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        // RTF 规范里裸换行只是为了排版，不产生输出
        i += 1;
        continue;
      }
      if (!skipping()) {
        flushHex();
        out.push(ch);
      }
      i += 1;
    }
    skipStack.pop();
  }

  parseGroup();
  flushHex();
  return {
    text: out.join(''),
    ignoredDestinations,
    usedCodepage: sawCodepage ? ansicpg : null,
  };
}

/* ---------- epub ---------- */

async function readEpub(api, options, note) {
  const fflate = await loadFflate(api);
  const entries = unzipOrThrow(fflate, api, 'EPUB_INVALID', 'EPUB 解压失败：文件可能已损坏。EPUB 本质是 zip，普通 zip 缺少 META-INF/container.xml 也会被拒绝。');
  const byName = indexEntries(entries);

  const containerBytes = lookupEntry(byName, 'META-INF/container.xml');
  if (!containerBytes) {
    throw new ConversionError('EPUB_INVALID', '这本 EPUB 缺少 META-INF/container.xml，不是标准的 EPUB 文件。');
  }
  const containerXml = api.decode(containerBytes, 'utf-8');
  const opfPath = /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i.exec(containerXml)?.[1];
  if (!opfPath) {
    throw new ConversionError('EPUB_INVALID', 'EPUB 的 container.xml 里没有声明 OPF 清单文件，文件结构不完整。');
  }
  const opfBytes = lookupEntry(byName, decodeUriPath(opfPath));
  if (!opfBytes) {
    throw new ConversionError('EPUB_INVALID', `EPUB 内找不到清单文件 ${opfPath}，文件可能被截断或目录结构异常。`);
  }

  const opf = parseOpf(api.decode(opfBytes, 'utf-8'), opfPath);
  const chapterDocs = [];
  let ignored = 0;

  for (const [position, idref] of opf.spine.entries()) {
    const item = opf.manifest.get(idref);
    if (!item || !isXhtmlItem(item)) continue;
    const bytes = lookupEntry(byName, item.path);
    if (!bytes) {
      note('warn', `EPUB 的 spine 指向 ${item.path}，但压缩包里没有这个文件，已跳过`);
      continue;
    }
    const { bodyHtml, title, ignoredElements } = extractXhtmlChapter(api, bytes, position, opf, idref);
    ignored += ignoredElements;
    chapterDocs.push({ title, bodyHtml });
  }

  if (!chapterDocs.length) {
    // spine 为空/全部缺失时退而求其次：把 manifest 里所有 XHTML 按文件名顺序排出来
    for (const item of [...opf.manifest.values()]) {
      if (!isXhtmlItem(item)) continue;
      const bytes = lookupEntry(byName, item.path);
      if (!bytes) continue;
      const chapter = extractXhtmlChapter(api, bytes, chapterDocs.length, opf, item.id);
      ignored += chapter.ignoredElements;
      chapterDocs.push({ title: chapter.title, bodyHtml: chapter.bodyHtml });
    }
  }
  if (!chapterDocs.length) {
    throw new ConversionError('EPUB_INVALID', '这本 EPUB 里没有可显示的正文（spine 与 manifest 都没有 XHTML 章节）。');
  }

  const turndown = await createTurndown(api);
  const markdown = chapterDocs
    .map((chapter) => `# ${chapter.title}\n\n${toMarkdown(turndown, chapter.bodyHtml)}`.trim())
    .join('\n\n');

  const title = fallbackTitle(options, opf.title);
  const bodyHtml = chapterDocs
    .map((chapter) => `<h1>${htmlEscape(chapter.title)}</h1>\n${chapter.bodyHtml}`)
    .join('\n');

  note('info', `按 spine 顺序提取了 ${chapterDocs.length} 个章节`);
  if (ignored > 0) note('info', `忽略了 ${ignored} 个脚本/样式元素`);

  return { markdown, html: bodyHtml, title };
}

function unzipOrThrow(fflate, api, code, message) {
  try {
    const entries = fflate.unzipSync(api.bytes());
    if (!entries || typeof entries !== 'object') throw new Error('解压结果为空');
    return entries;
  } catch (err) {
    throw new ConversionError(code, message, { cause: err });
  }
}

/** zip 条目名可能带 URL 编码（中文文件名很常见），统一成解码后的正斜杠路径 */
function normalizeZipPath(name) {
  return decodeUriPath(String(name ?? '').replace(/\\/g, '/').replace(/^\.\//, ''));
}

function decodeUriPath(path) {
  return String(path ?? '')
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment; // 名字里本来就有 % 且不是合法转义，保持原样
      }
    })
    .join('/');
}

function indexEntries(entries) {
  const byName = new Map();
  for (const [name, data] of Object.entries(entries)) {
    byName.set(normalizeZipPath(name), data);
  }
  return byName;
}

function lookupEntry(byName, path) {
  const wanted = normalizeZipPath(path);
  if (byName.has(wanted)) return byName.get(wanted);
  // 常见坑：OPF 写绝对路径、zip 里带 ./ 前缀、目录层级大小写不一致
  const trimmed = wanted.replace(/^\/+/, '');
  if (byName.has(trimmed)) return byName.get(trimmed);
  const lower = trimmed.toLowerCase();
  for (const [name, data] of byName) {
    if (name.toLowerCase() === lower || name.toLowerCase().endsWith(`/${lower}`)) return data;
  }
  return undefined;
}

function resolveRelativePath(basePath, href) {
  const baseDir = String(basePath ?? '').split('/').slice(0, -1);
  for (const segment of decodeUriPath(String(href ?? '').split('#')[0].split('?')[0]).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') baseDir.pop();
    else baseDir.push(segment);
  }
  return baseDir.join('/');
}

function parseOpf(xml, opfPath) {
  const manifest = new Map();
  for (const match of xml.matchAll(/<item\b([^>]*)\/?>/gi)) {
    const attributes = parseAttributes(match[1]);
    if (!attributes.id || !attributes.href) continue;
    manifest.set(attributes.id, {
      id: attributes.id,
      mediaType: attributes['media-type'] ?? '',
      properties: attributes.properties ?? '',
      path: resolveRelativePath(opfPath, attributes.href),
    });
  }
  const spine = [];
  for (const match of xml.matchAll(/<itemref\b([^>]*)\/?>/gi)) {
    const attributes = parseAttributes(match[1]);
    if (attributes.idref && attributes.linear !== 'no') spine.push(attributes.idref);
  }
  const title = decodeHtmlEntities(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(xml)?.[1] ?? '').trim();
  return { manifest, spine, title };
}

function parseAttributes(source) {
  const attributes = {};
  for (const match of String(source ?? '').matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    attributes[match[1].toLowerCase()] = match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function isXhtmlItem(item) {
  return /xhtml|html/i.test(item.mediaType) || /\.x?html?$/i.test(item.path);
}

/** 章节标题：优先文档内第一个标题，其次 nav/toc 里的标签，最后退回「第 N 章」 */
function extractXhtmlChapter(api, bytes, position, opf, idref) {
  const raw = api.decode(bytes, declaredCharset(api, bytes));
  const { ignored } = htmlToPlainText(raw, 'plain');
  const headingMatch = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]\s*>/i.exec(raw);
  const headingText = headingMatch ? decodeHtmlEntities(stripTags(headingMatch[1])).trim() : '';
  const title = headingText || opf.tocLabels?.get(idref) || `第 ${position + 1} 章`;
  let bodyHtml = stripNoiseHtml(extractBodyHtml(raw));
  if (headingText) {
    // 这个标题已经被拿去当章节名了（输出时会重新加一次），正文里再留一份就是重复标题
    bodyHtml = bodyHtml.replace(/<h[1-3]\b[^>]*>[\s\S]*?<\/h[1-3]\s*>/i, '').trim();
  }
  return { title, bodyHtml, ignoredElements: ignored };
}

/** 脚本/样式/注释进 Markdown 或纯文本只会污染正文 */
function stripNoiseHtml(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|noscript|template)\b[^>]*\/?>/gi, '');
}

/** XHTML 声明里可能写 gbk/big5，尊重它比自己猜更准 */
function declaredCharset(api, bytes) {
  const head = api.decode(bytes.slice(0, 512), 'windows-1252');
  const declared = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1]
    ?? /charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  if (!declared) return 'utf-8';
  const label = declared.toLowerCase();
  if (label === 'gb2312' || label === 'gbk' || label === 'gb18030') return 'gb18030';
  if (label === 'big5' || label === 'big5-hkscs') return 'big5';
  if (label === 'utf-8' || label === 'utf8') return 'utf-8';
  try {
    // 让 TextDecoder 自己校验标签合法性
    new TextDecoder(label);
    return label;
  } catch {
    return 'utf-8';
  }
}

/* ---------- odt ---------- */

async function readOdt(api, options, note) {
  const fflate = await loadFflate(api);
  const entries = unzipOrThrow(fflate, api, 'ODT_CORRUPT', 'ODT 解压失败：文件可能已损坏（ODT 本质是 zip）。');
  const byName = indexEntries(entries);
  const contentBytes = lookupEntry(byName, 'content.xml');
  if (!contentBytes) {
    throw new ConversionError('ODT_CORRUPT', '这份 ODT 里找不到 content.xml，不是标准的 OpenDocument 文本文件。');
  }

  const xml = api.decode(contentBytes, 'utf-8');
  const body = /<office:body\b[^>]*>([\s\S]*?)<\/office:body\s*>/i.exec(xml)?.[1] ?? xml;
  const html = odfBodyToHtml(body);
  const turndown = await createTurndown(api);
  const markdown = toMarkdown(turndown, html);

  const sourceTitle = decodeHtmlEntities(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(xml)?.[1] ?? '').trim();
  note('info', 'ODT 按 ODF 正文元素尽力提取，复杂版式（浮动文本框、分栏）可能丢失');

  return { markdown, html, title: fallbackTitle(options, sourceTitle) };
}

/**
 * ODF 正文元素 → HTML：复用后面一套 html/turndown 管线，不再单独写 ODT 的内容模型。
 * 注意：ODF 标签名里带连字符（text:list-item），用 \b 判断标签名结束会把
 * <text:list> 也匹配到 <text:list-item> 上，必须用 (?=[\s/>])。
 */
function odfBodyToHtml(body) {
  return String(body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<text:h(?=[\s/>])[^>]*outline-level="(\d+)"[^>]*>([\s\S]*?)<\/text:h\s*>/gi, (m, level, inner) => {
      const depth = clamp(Number(level) || 1, 1, 6);
      return `<h${depth}>${inner}</h${depth}>`;
    })
    .replace(/<text:h(?=[\s/>])[^>]*>([\s\S]*?)<\/text:h\s*>/gi, '<h1>$1</h1>')
    .replace(/<text:p(?=[\s/>])[^>]*>([\s\S]*?)<\/text:p\s*>/gi, '<p>$1</p>')
    .replace(/<text:span(?=[\s/>])[^>]*>/gi, '')
    .replace(/<\/text:span\s*>/gi, '')
    .replace(/<text:s(?=[\s/>])[^>]*\/?>/gi, ' ')
    .replace(/<text:tab(?=[\s/>])[^>]*\/?>/gi, '\t')
    .replace(/<text:line-break(?=[\s/>])[^>]*\/?>/gi, '<br>')
    .replace(/<table:table-cell(?=[\s/>])[^>]*>/gi, '<td>')
    .replace(/<\/table:table-cell\s*>/gi, '</td>')
    .replace(/<table:table-row(?=[\s/>])[^>]*>/gi, '<tr>')
    .replace(/<\/table:table-row\s*>/gi, '</tr>')
    .replace(/<table:table(?=[\s/>])[^>]*>/gi, '<table>')
    .replace(/<\/table:table\s*>/gi, '</table>')
    .replace(/<text:list-item(?=[\s/>])[^>]*>/gi, '<li>')
    .replace(/<\/text:list-item\s*>/gi, '</li>')
    .replace(/<text:list(?=[\s/>])[^>]*>/gi, '<ul>')
    .replace(/<\/text:list\s*>/gi, '</ul>')
    .replace(/<(?!\/?(?:p|h[1-6]|ul|ol|li|table|tr|td|th|br)\b)[^>]*>/gi, '');
}

/* ------------------------------------------------------------------ *
 * 写出器
 * ------------------------------------------------------------------ */

async function writeDocument(target, docModel, options, api, note) {
  const outExt = target === 'htm' ? 'html' : target;
  if (!meta.to.includes(outExt)) {
    throw new ConversionError(
      'UNSUPPORTED_TARGET',
      `文档模块暂不支持输出 .${outExt || '未知'} 格式，可输出：${meta.to.join('、')}。`,
    );
  }

  const name = api.fileName(`${options.stem}.${outExt}`);
  const mime = mimeOfExt(outExt);
  const marked = await loadMarked(api);

  if (outExt === 'docx') {
    const built = await buildDocx(api, marked, docModel, note);
    return {
      name, mime, bytes: built.bytes,
      previewText: markdownToPlainText(marked, shrinkDataUris(docModel.markdown), options.headingStyle),
    };
  }

  if (outExt === 'epub') {
    const built = await buildEpub(api, marked, docModel, note);
    return {
      name, mime, bytes: built.bytes,
      previewText: markdownToPlainText(marked, shrinkDataUris(docModel.markdown), options.headingStyle),
    };
  }

  let text;
  if (outExt === 'md') {
    text = restyleMarkdown(marked, docModel.markdown, options);
    if (docModel.hasEmbeddedImages) {
      note('warn', 'Markdown 里内嵌了图片 base64，文件会明显变大；只要文字请在选项里关闭「保留图片」');
    }
  } else if (outExt === 'txt') {
    text = markdownToPlainText(marked, docModel.markdown, options.headingStyle);
  } else {
    // HTML 保留语义标题（h1-h6）：'#' 之类文本标记在网页里没有意义
    const bodyHtml = docModel.html ?? marked.parse(restyleMarkdown(marked, docModel.markdown, options));
    text = buildHtmlDocument({ title: docModel.title, bodyHtml, charset: charsetOf(options.encoding) });
  }

  lastEncodeWarning.value = null;
  const bytes = api.encode(text, options.encoding);
  if (lastEncodeWarning.value?.dropped) {
    note('warn', `输出编码无法表示 ${lastEncodeWarning.value.dropped} 个字符，已替换为 ?，建议改用 UTF-8`);
  }
  return { name, mime, bytes, previewText: text };
}

function charsetOf(encoding) {
  const label = String(encoding ?? 'utf-8').toLowerCase();
  if (label === 'utf-8-bom' || label === 'utf-8') return 'utf-8';
  if (label === 'gbk') return 'gb18030';
  if (label === 'utf-16le' || label === 'utf-16be') return 'utf-16';
  return label;
}

/** 预览里的 base64 图片会把 2000 字塞满，先压掉 */
function shrinkDataUris(markdown) {
  return String(markdown ?? '').replace(/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, 'data:…');
}

/* ---------- HTML / 文本工具 ---------- */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae',
  trade: '\u2122', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', middot: '\u00b7', times: '\u00d7', divide: '\u00f7',
  deg: '\u00b0', plusmn: '\u00b1', laquo: '\u00ab', raquo: '\u00bb', sect: '\u00a7', para: '\u00b6',
  dagger: '\u2020', ddagger: '\u2021', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2',
  frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be', sup2: '\u00b2', sup3: '\u00b3', micro: '\u00b5',
  emsp: '\u2003', ensp: '\u2002', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', shy: '\u00ad',
  lrm: '\u200e', rlm: '\u200f', prime: '\u2032', Prime: '\u2033', infin: '\u221e', ne: '\u2260',
  le: '\u2264', ge: '\u2265', larr: '\u2190', rarr: '\u2192', harr: '\u2194', spades: '\u2660',
  clubs: '\u2663', hearts: '\u2665', diams: '\u2666', check: '\u2713', cross: '\u2717',
};

function decodeHtmlEntities(text) {
  return String(text ?? '').replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const value = NAMED_ENTITIES[body];
    return value === undefined ? match : value;
  });
}

const stripTags = (html) => String(html ?? '').replace(/<[^>]*>/g, '');

function attributeOf(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(String(tag ?? ''));
  return match ? match[2] ?? match[3] ?? match[4] ?? '' : '';
}

/**
 * HTML → 纯文本。不用 DOM，靠有序的标签替换实现：
 * 先处理标题/列表/表格这类有结构含义的标签，再统一去标签、解实体。
 */
function htmlToPlainText(html, headingStyle) {
  const counters = [];
  let ignored = 0;
  let source = String(html ?? '');
  source = source.replace(/<!--[\s\S]*?-->/g, '');
  source = source.replace(/<(script|style|noscript|iframe|object|embed|svg|canvas|head|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, () => {
    ignored += 1;
    return ' ';
  });
  source = source.replace(/<(script|style|noscript|iframe|svg|template)\b[^>]*\/?>/gi, () => {
    ignored += 1;
    return ' ';
  });
  // 图片降级为 alt 文字：纯文本里 base64 只是噪音
  source = source.replace(/<img\b[^>]*\/?>/gi, (tag) => {
    const alt = attributeOf(tag, 'alt').trim();
    return alt ? `[图片：${alt}]` : '[图片]';
  });
  source = source.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (match, depth, inner) =>
    `\n\n${headingLine(Number(depth), stripTags(inner), headingStyle, counters)}\n\n`);
  source = source.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol\s*>/gi, (match, inner) => {
    let index = 0;
    return inner.replace(/<li\b[^>]*>/gi, () => `\n${(index += 1)}. `);
  });
  source = source.replace(/<li\b[^>]*>/gi, '\n- ');
  source = source.replace(/<hr\b[^>]*\/?>/gi, '\n\n――――\n\n');
  source = source.replace(/<\/(p|div|section|article|blockquote|pre|tr|ul|ol|li|table|h[1-6]|dd|dt)\s*>/gi, '\n\n');
  source = source.replace(/<(td|th)\b[^>]*>/gi, '\t');
  source = source.replace(/<br\b[^>]*\/?>/gi, '\n');
  source = stripTags(source);
  source = decodeHtmlEntities(source).replace(/\u00a0/g, ' ');
  return { text: normalizeBlankLines(source), ignored };
}

function normalizeBlankLines(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const CJK_DIGITS = '零一二三四五六七八九';

function toChineseNumber(value) {
  const n = Math.max(1, Math.floor(value));
  if (n < 10) return CJK_DIGITS[n];
  if (n === 10) return '十';
  if (n < 20) return `十${CJK_DIGITS[n % 10]}`;
  if (n < 100) return `${CJK_DIGITS[Math.floor(n / 10)]}十${n % 10 ? CJK_DIGITS[n % 10] : ''}`;
  return String(n); // 上百之后中文数字反而难读，直接给阿拉伯数字
}

/** 标题渲染的唯一入口：md / txt 两种输出都走这里，保证几种风格写法一致 */
function headingLine(depth, text, headingStyle, counters) {
  const label = String(text ?? '').trim();
  if (!label) return '';
  const level = clamp(Number(depth) || 1, 1, 6);
  counters[level] = (counters[level] ?? 0) + 1;
  for (let deeper = level + 1; deeper <= 6; deeper += 1) counters[deeper] = 0;
  if (headingStyle === 'plain') return label;
  if (headingStyle === 'number') {
    const index = counters[level];
    if (level === 1) return `${toChineseNumber(index)}、${label}`;
    if (level === 2) return `（${toChineseNumber(index)}）${label}`;
    if (level === 3) return `${index}. ${label}`;
    return `${'  '.repeat(level - 3)}(${index}) ${label}`;
  }
  return `${'#'.repeat(level)} ${label}`;
}

function inlineText(tokens) {
  if (!Array.isArray(tokens)) return '';
  return tokens
    .map((token) => {
      switch (token.type) {
        case 'br': return '\n';
        case 'image': return token.text ? `[图片：${token.text}]` : '[图片]';
        case 'codespan': return token.text ?? '';
        case 'text': return token.text ?? '';
        case 'escape': return token.text ?? '';
        case 'html': return htmlToPlainText(token.text ?? '', 'plain').text;
        case 'checkbox': return token.checked ? '[x] ' : '[ ] ';
        default:
          if (token.tokens) return inlineText(token.tokens);
          return token.text ?? '';
      }
    })
    .join('');
}

function restyleMarkdown(marked, markdown, options) {
  const tokens = marked.lexer(String(markdown ?? ''));
  const counters = [];
  return tokens
    .map((token) => {
      if (token.type !== 'heading') return token.raw ?? '';
      if (options.headingStyle === 'hash') return token.raw ?? '';
      return headingLine(token.depth, inlineText(token.tokens), options.headingStyle, counters);
    })
    .join('')
    .trim();
}

/** Markdown → 纯文本：走 marked 的 block token，避免自己写 Markdown 解析 */
function markdownToPlainText(marked, markdown, headingStyle) {
  const counters = [];
  const lines = [];
  blocksToPlain(marked, marked.lexer(String(markdown ?? '')), headingStyle, '', counters, lines);
  return normalizeBlankLines(lines.join('\n'));
}

function indentLines(indent, text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => (line ? indent + line : line))
    .join('\n');
}

function blocksToPlain(marked, tokens, headingStyle, indent, counters, lines) {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'space':
        lines.push('');
        break;
      case 'heading':
        lines.push(indent + headingLine(token.depth, inlineText(token.tokens), headingStyle, counters));
        break;
      case 'paragraph':
        lines.push(indentLines(indent, inlineText(token.tokens)));
        break;
      case 'text':
        lines.push(indentLines(indent, token.text ?? ''));
        break;
      case 'code':
        lines.push(indentLines(indent, token.text ?? ''));
        break;
      case 'blockquote': {
        const inner = [];
        blocksToPlain(marked, token.tokens ?? [], headingStyle, '', counters, inner);
        lines.push(...inner.map((line) => (line ? `> ${line}` : '>')));
        break;
      }
      case 'list': {
        let index = Number(token.start) || 1;
        for (const item of token.items ?? []) {
          const marker = token.ordered ? `${index}. ` : '- ';
          index += 1;
          const inner = [];
          blocksToPlain(marked, itemTokens(item), headingStyle, '  ', counters, inner);
          const [first = '', ...rest] = inner;
          lines.push(`${indent}${marker}${first.trimStart()}`);
          lines.push(...rest);
        }
        break;
      }
      case 'table': {
        const header = (token.header ?? []).map((cell) => cell.text ?? '').join('\t');
        if (header) lines.push(indent + header);
        for (const row of token.rows ?? []) {
          lines.push(indent + row.map((cell) => cell.text ?? '').join('\t'));
        }
        break;
      }
      case 'html': {
        const { text } = htmlToPlainText(token.text ?? '', headingStyle);
        if (text) lines.push(indentLines(indent, text));
        break;
      }
      case 'hr':
        lines.push(`${indent}――――`);
        break;
      case 'def':
        break;
      default:
        if (token.raw) lines.push(indent + String(token.raw).trim());
    }
  }
}

/** 列表项内容在 tight/loose 两种状态下 token 层级不同，这里抹平 */
function itemTokens(item) {
  const flattened = [];
  for (const token of item?.tokens ?? []) {
    if (token.type === 'paragraph') flattened.push(...(token.tokens ?? []));
    else if (token.type !== 'list') flattened.push(token);
  }
  if (!flattened.length && item?.text) flattened.push({ type: 'text', text: item.text });
  return flattened;
}

function buildHtmlDocument({ title, bodyHtml, charset }) {
  const safeTitle = htmlEscape(title || '未命名文档');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="${charset || 'utf-8'}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  body { max-width: 46em; margin: 2em auto; padding: 0 1em; font-family: "Microsoft YaHei", "PingFang SC", 宋体, sans-serif; line-height: 1.75; color: #222; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.35; margin: 1.4em 0 0.6em; }
  table { border-collapse: collapse; margin: 1em 0; }
  th, td { border: 1px solid #ccc; padding: 0.35em 0.7em; }
  img { max-width: 100%; height: auto; }
  pre { background: #f6f8fa; padding: 0.8em 1em; overflow-x: auto; }
  code { font-family: Consolas, "Courier New", monospace; }
  blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #ddd; color: #555; }
</style>
</head>
<body>
${String(bodyHtml ?? '').trim()}
</body>
</html>
`;
}

/* ---------- docx 写出 ---------- */

async function buildDocx(api, marked, docModel, note) {
  const docx = await loadDocx(api);
  const tokens = marked.lexer(String(docModel.markdown ?? ''));
  const stats = { imagesDropped: 0 };
  const children = [];

  buildDocxBlocks(docx, tokens, children, { docx, stats, indent: 0, quote: false });
  if (!children.length) children.push(new docx.Paragraph({ children: [] }));

  const doc = new docx.Document({
    creator: 'Prism 棱镜',
    title: docModel.title || undefined,
    description: '由 Prism 棱镜转换生成',
    styles: {
      default: { document: { run: { font: FONT_BODY, size: 22 } } },
      // 代码块与引用用自定义样式承载：一是 Word 里能正确显示，二是往返转换时能认回来
      paragraphStyles: [
        {
          id: 'PrismCode', name: 'Prism Code', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { font: FONT_CODE, size: 20 },
          paragraph: { spacing: { before: 0, after: 0 }, shading: { fill: 'F6F8FA' } },
        },
        {
          id: 'PrismQuote', name: 'Prism Quote', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { italics: true, color: '555555' },
          paragraph: { indent: { left: 480 }, spacing: { before: 60, after: 60 } },
        },
      ],
    },
    numbering: {
      config: [{
        reference: ORDERED_LIST_REFERENCE,
        levels: [0, 1, 2, 3, 4].map((level) => ({
          level,
          format: 'decimal',
          text: `%${level + 1}.`,
          alignment: 'start',
        })),
      }],
    },
    sections: [{ properties: {}, children }],
  });

  const bytes = await packDocx(docx, doc);
  if (stats.imagesDropped > 0) {
    note('warn', `忽略了 ${stats.imagesDropped} 张图片：docx 输出暂不内嵌图片，需要图片请输出 html`);
  }
  return { bytes };
}

/** docx 各版本导出名不一致（toUint8Array / toArrayBuffer / toBuffer），统一成 Uint8Array */
async function packDocx(docx, doc) {
  if (typeof docx.Packer.toUint8Array === 'function') return await docx.Packer.toUint8Array(doc);
  if (typeof docx.Packer.toArrayBuffer === 'function') return new Uint8Array(await docx.Packer.toArrayBuffer(doc));
  const buffer = await docx.Packer.toBuffer(doc); // Node 专用，浏览器包里没有
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice();
}

function headingLevelOf(docx, depth) {
  const levels = [
    docx.HeadingLevel?.HEADING_1, docx.HeadingLevel?.HEADING_2, docx.HeadingLevel?.HEADING_3,
    docx.HeadingLevel?.HEADING_4, docx.HeadingLevel?.HEADING_5, docx.HeadingLevel?.HEADING_6,
  ];
  return levels[clamp(Number(depth) || 1, 1, 6) - 1];
}

function textRun(docx, text, format = {}) {
  const value = decodeHtmlEntities(String(text ?? ''));
  if (!value) return null;
  return new docx.TextRun({
    text: value,
    bold: format.bold,
    italics: format.italics,
    strike: format.strike,
    color: format.color,
    font: format.font ?? FONT_BODY,
  });
}

function inlineRuns(docx, tokens, stats, format = {}) {
  const runs = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'strong':
        runs.push(...inlineRuns(docx, token.tokens, stats, { ...format, bold: true }));
        break;
      case 'em':
        runs.push(...inlineRuns(docx, token.tokens, stats, { ...format, italics: true }));
        break;
      case 'del':
        runs.push(...inlineRuns(docx, token.tokens, stats, { ...format, strike: true }));
        break;
      case 'codespan':
        runs.push(textRun(docx, token.text ?? '', { ...format, font: FONT_CODE }));
        break;
      case 'br':
        runs.push(new docx.TextRun({ break: 1 }));
        break;
      case 'link':
        runs.push(...inlineRuns(docx, token.tokens, stats, format));
        // Word 里不做超链接跳转，但 URL 本身是信息，附在文本后面而不是丢掉
        if (token.href && token.href !== (token.text ?? '')) {
          runs.push(textRun(docx, `（${token.href}）`, { ...format, color: '5A6B7C' }));
        }
        break;
      case 'image':
        stats.imagesDropped += 1;
        runs.push(textRun(docx, token.text ? `[图片：${token.text}]` : '[图片]', { ...format, color: '8A8A8A' }));
        break;
      case 'html':
        runs.push(textRun(docx, stripTags(token.text ?? ''), format));
        break;
      default:
        runs.push(textRun(docx, token.text ?? token.raw ?? '', format));
    }
  }
  return runs.filter(Boolean);
}

function buildDocxBlocks(docx, tokens, out, context) {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'space':
        break;
      case 'heading':
        out.push(new docx.Paragraph({
          heading: headingLevelOf(docx, token.depth),
          spacing: { before: 240, after: 120 },
          children: inlineRuns(docx, token.tokens, context.stats),
        }));
        break;
      case 'paragraph':
        out.push(new docx.Paragraph({
          style: context.quote ? 'PrismQuote' : undefined,
          spacing: { after: 120 },
          indent: context.indent ? { left: context.indent } : undefined,
          children: inlineRuns(docx, token.tokens, context.stats, context.quote ? { italics: true } : {}),
        }));
        break;
      case 'text':
        out.push(new docx.Paragraph({
          indent: context.indent ? { left: context.indent } : undefined,
          children: inlineRuns(docx, [token], context.stats),
        }));
        break;
      case 'code': {
        for (const line of String(token.text ?? '').split('\n')) {
          out.push(new docx.Paragraph({
            style: 'PrismCode',
            spacing: { after: 0 },
            children: [textRun(docx, line, { font: FONT_CODE })].filter(Boolean),
          }));
        }
        break;
      }
      case 'blockquote': {
        const inner = [];
        // 标记 quote 让内部段落套上 PrismQuote 样式与斜体，mammoth 才能还原成引用
        buildDocxBlocks(docx, token.tokens ?? [], inner, { ...context, quote: true });
        out.push(...inner);
        break;
      }
      case 'list':
        buildDocxList(docx, token, out, context, 0);
        break;
      case 'table':
        out.push(buildDocxTable(docx, token, context.stats));
        break;
      case 'hr':
        out.push(new docx.Paragraph({
          spacing: { after: 120 },
          border: { bottom: { style: 'single', size: 6, color: '999999', space: 1 } },
          children: [],
        }));
        break;
      case 'html': {
        const { text } = htmlToPlainText(token.text ?? '', 'plain');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          out.push(new docx.Paragraph({
            indent: context.indent ? { left: context.indent } : undefined,
            children: [textRun(docx, line)].filter(Boolean),
          }));
        }
        break;
      }
      default:
        if (token.raw) {
          out.push(new docx.Paragraph({ children: [textRun(docx, String(token.raw).trim())].filter(Boolean) }));
        }
    }
  }
}

function buildDocxList(docx, token, out, context, level) {
  for (const item of token.items ?? []) {
    const options = {
      spacing: { after: 60 },
      indent: { left: context.indent + level * 360 },
      children: inlineRuns(docx, itemTokens(item), context.stats),
    };
    if (token.ordered) {
      // 序号交给 Word 的自动编号（上面配了 prism-ordered-list），文本里不写死数字
      options.numbering = { reference: ORDERED_LIST_REFERENCE, level: Math.min(level, 4) };
    } else {
      options.bullet = { level: Math.min(level, 8) };
    }
    out.push(new docx.Paragraph(options));
    for (const nested of (item.tokens ?? []).filter((child) => child.type === 'list')) {
      buildDocxList(docx, nested, out, context, level + 1);
    }
  }
}

function buildDocxTable(docx, token, stats) {
  const rows = [];
  const header = token.header ?? [];
  if (header.length) {
    rows.push(new docx.TableRow({
      tableHeader: true,
      children: header.map((cell) => new docx.TableCell({
        children: [new docx.Paragraph({
          children: inlineRuns(docx, cell.tokens ?? [{ type: 'text', text: cell.text ?? '' }], stats, { bold: true }),
        })],
      })),
    }));
  }
  for (const row of token.rows ?? []) {
    rows.push(new docx.TableRow({
      children: row.map((cell) => new docx.TableCell({
        children: [new docx.Paragraph({
          children: inlineRuns(docx, cell.tokens ?? [{ type: 'text', text: cell.text ?? '' }], stats),
        })],
      })),
    }));
  }
  return new docx.Table({
    rows,
    width: { size: 100, type: docx.WidthType?.PERCENTAGE ?? 'pct' },
  });
}

/* ---------- epub 写出 ---------- */

async function buildEpub(api, marked, docModel, note) {
  const fflate = await loadFflate(api);
  const chapters = splitChapters(docModel.markdown);
  const bookTitle = docModel.title || chapters[0]?.title || '未命名文档';
  const bookId = makeBookId();
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const encodePart = (text) => api.encode(text, 'utf-8'); // EPUB 内部一律 UTF-8 无 BOM，与输出编码选项无关

  const chapterItems = chapters.map((chapter, index) => {
    const fileName = `chapter-${index + 1}.xhtml`;
    return {
      fileName,
      id: `chapter-${index + 1}`,
      title: chapter.title,
      xhtml: buildChapterXhtml({ title: chapter.title, bodyHtml: marked.parse(chapter.markdown || '') }),
    };
  });

  const manifestItems = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="style" href="style.css" media-type="text/css"/>',
    ...chapterItems.map((item) =>
      `<item id="${item.id}" href="${item.fileName}" media-type="application/xhtml+xml"/>`),
  ];
  const spineItems = chapterItems.map((item) => `<itemref idref="${item.id}"/>`);

  const containerXml = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

  const contentOpf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${bookId}</dc:identifier>
    <dc:title>${htmlEscape(bookTitle)}</dc:title>
    <dc:language>zh-CN</dc:language>
    <dc:creator>Prism 棱镜</dc:creator>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spineItems.join('\n    ')}
  </spine>
</package>
`;

  const tocNcx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="zh-CN">
  <head>
    <meta name="dtb:uid" content="${bookId}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${htmlEscape(bookTitle)}</text></docTitle>
  <navMap>
    ${chapterItems.map((item, index) => `<navPoint id="navPoint-${index + 1}" playOrder="${index + 1}">
      <navLabel><text>${htmlEscape(item.title)}</text></navLabel>
      <content src="${item.fileName}"/>
    </navPoint>`).join('\n    ')}
  </navMap>
</ncx>
`;

  const navXhtml = buildNavXhtml({ chapters: chapterItems });

  const styleCss = `body { font-family: "Microsoft YaHei", "PingFang SC", 宋体, sans-serif; line-height: 1.75; margin: 1em; }
h1.chapter-title { font-size: 1.5em; margin: 1em 0 0.8em; }
table { border-collapse: collapse; }
th, td { border: 1px solid #bbb; padding: 0.3em 0.6em; }
pre { background: #f6f8fa; padding: 0.7em; }
img { max-width: 100%; }
`;

  // 键顺序即 zip 中的写入顺序：mimetype 必须第一个、且不压缩（EPUB 规范硬性要求）
  const bundle = {
    mimetype: [encodePart('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': [encodePart(containerXml), { level: 9 }],
    'OEBPS/content.opf': [encodePart(contentOpf), { level: 9 }],
    'OEBPS/nav.xhtml': [encodePart(navXhtml), { level: 9 }],
    'OEBPS/toc.ncx': [encodePart(tocNcx), { level: 9 }],
    'OEBPS/style.css': [encodePart(styleCss), { level: 9 }],
  };
  for (const item of chapterItems) {
    bundle[`OEBPS/${item.fileName}`] = [encodePart(item.xhtml), { level: 9 }];
  }

  const bytes = fflate.zipSync(bundle, { level: 6 });
  note('info', `已生成 EPUB3：${chapterItems.length} 个章节，mimetype 未压缩且排在首位`);
  return { bytes };
}

function buildNavXhtml({ chapters }) {
  const items = chapters
    .map((chapter) => `        <li><a href="${chapter.fileName}">${htmlEscape(chapter.title)}</a></li>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
  <head>
    <meta charset="utf-8"/>
    <title>目录</title>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>目录</h1>
      <ol>
${items}
      </ol>
    </nav>
  </body>
</html>
`;
}

function buildChapterXhtml({ title, bodyHtml }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
  <head>
    <meta charset="utf-8"/>
    <title>${htmlEscape(title)}</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body>
    <section epub:type="chapter">
      <h1 class="chapter-title">${htmlEscape(title)}</h1>
${toXhtmlVoidTags(stripForeignMarkup(bodyHtml))}
    </section>
  </body>
</html>
`;
}

/** marked 输出的是 HTML，EPUB 要求 XHTML：空元素必须自闭合 */
function toXhtmlVoidTags(html) {
  return String(html ?? '').replace(
    /<(br|hr|img|input|meta|link|col|area|base|source|track|wbr)((?:[^>"']|"[^"]*"|'[^']*')*?)\s*\/?>/gi,
    '<$1$2/>',
  );
}

/** 脚本/内联事件进 XHTML 既不合规也没意义，直接摘掉 */
function stripForeignMarkup(html) {
  return String(html ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function makeBookId() {
  const hex = (length) => Math.floor(Math.random() * 16 ** length).toString(16).padStart(length, '0');
  return `urn:uuid:${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
}

/** 按一级标题切章；没有一级标题就整体一章 */
function splitChapters(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const chapters = [];
  let title = '';
  let body = [];
  const flush = () => {
    const text = body.join('\n').trim();
    if (!title && !text) return;
    chapters.push({ title: title || `第 ${chapters.length + 1} 章`, markdown: text });
  };
  for (const line of lines) {
    const heading = /^#\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      flush();
      title = heading[1].trim();
      body = [];
      continue;
    }
    body.push(line);
  }
  flush();
  return chapters.length ? chapters : [{ title: '正文', markdown: '' }];
}

/* ---------- turndown ---------- */

async function createTurndown(api) {
  const TurndownService = await loadTurndown(api);
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  service.keep(['sub', 'sup']);
  // turndown 默认不认识表格，会把单元格拼成一堆碎文本。
  // 注意：不能依赖 <thead>——mammoth 输出的表格常常没有 thead，
  // 所以整张表一次生成，用第一行当表头再补 GFM 的分隔行。
  service.addRule('prismTable', {
    filter: ['table'],
    replacement: (content, node) => {
      const rows = collectTableRows(node).map((row) =>
        row.map((cell) => cellToMarkdown(service, cell)));
      if (!rows.length) return content;
      const width = Math.max(...rows.map((row) => row.length));
      const padded = (row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')];
      const lines = [`|${padded(rows[0]).map((cell) => ` ${cell} `).join('|')}|`];
      lines.push(`|${Array.from({ length: width }, () => ' --- ').join('|')}|`);
      for (const row of rows.slice(1)) lines.push(`|${padded(row).map((cell) => ` ${cell} `).join('|')}|`);
      return `\n\n${lines.join('\n')}\n\n`;
    },
  });
  return service;
}

function collectTableRows(node, rows = []) {
  for (const child of Array.from(node?.childNodes ?? [])) {
    if (child.nodeName === 'TR') {
      rows.push(Array.from(child.childNodes ?? []).filter((cell) => /^T[HD]$/.test(cell.nodeName)));
    } else {
      collectTableRows(child, rows);
    }
  }
  return rows;
}

function cellToMarkdown(service, cell) {
  // 单元格里的嵌套表格会让 turndown 递归到自己的表格规则，先摘掉
  const inner = String(cell.innerHTML ?? '').replace(/<table\b[\s\S]*?<\/table\s*>/gi, '');
  return service
    .turndown(inner)
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/** turndown 的输出再收一下口：列表标记后统一成一个空格，压掉多余空行 */
function toMarkdown(service, html) {
  const normalized = String(html ?? '').replace(
    /<pre\b([^>]*)>([\s\S]*?)<\/pre\s*>/gi,
    // turndown 的代码块规则只认 <pre><code>；mammoth 输出的是裸 <pre>，
    // 不补一层 <code> 的话代码块会退化成普通段落
    (match, attrs, inner) => (/<code\b/i.test(inner) ? match : `<pre${attrs}><code>${inner}</code></pre>`),
  );
  return service
    .turndown(normalized)
    .replace(/^([ \t]*)([-*+]|\d+\.)[ \t]{2,}/gm, '$1$2 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ---------- 杂项 ---------- */

function toArrayBuffer(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // 不能直接把 .buffer 交出去：切片视图会让 mammoth 读到整个底层缓冲
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}
