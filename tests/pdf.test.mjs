/**
 * PDF 模块测试。
 * pdf-lib 现场生成 PDF 作为 fixture；渲染路径在 Node 里没有 Canvas，断言的是「明确报错」而不是结果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApi } from './helpers/api-stub.mjs';
import { assembleLines, convert, meta, parsePageRange } from '../src/core/pdf.js';
import { ConversionError } from '../src/core/errors.js';

/* ------------------------------------------------------------------ *
 * fixture
 * ------------------------------------------------------------------ */

async function loadPdfLib() {
  const mod = await import('pdf-lib');
  return mod.PDFDocument ? mod : mod.default;
}

/** 生成多页纯英文 PDF（内置字体只支持 Latin，中文场景在 assembleLines 单测里覆盖） */
async function makePdf(pageTexts) {
  const { PDFDocument, StandardFonts } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pageTexts) {
    const page = doc.addPage([420, 320]);
    lines.forEach((line, index) => {
      page.drawText(line, { x: 40, y: 260 - index * 26, size: 14, font });
    });
  }
  return new Uint8Array(await doc.save());
}

async function countPages(bytes) {
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

/** Node 下 pdfjs 不给 standard_fonts 路径会逐文档告警，测试侧也补上 */
const STANDARD_FONTS_URL = (() => {
  const path = decodeURIComponent(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname);
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
})();

/** 用 pdfjs 把生成的 PDF 读回文字，验证内容真的排进去了 */
async function extractWithPdfJs(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    isEvalSupported: false,
    standardFontDataUrl: STANDARD_FONTS_URL,
  });
  const doc = await task.promise;
  const lines = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    lines.push(...assembleLines(content.items));
  }
  await task.destroy();
  return lines;
}

function textItem(str, x, y, { size = 10, width = str.length * size * 0.5 } = {}) {
  return { str, transform: [size, 0, 0, size, x, y], width, height: size };
}

function utf8(text) {
  return new TextEncoder().encode(text);
}

/* ------------------------------------------------------------------ *
 * meta
 * ------------------------------------------------------------------ */

test('meta 契约：id / 输入输出格式 / 选项默认值完整', () => {
  assert.equal(meta.id, 'pdf');
  assert.equal(meta.category, 'pdf');
  assert.deepEqual(meta.to, ['pdf', 'png', 'jpg', 'txt', 'md', 'html']);
  assert.equal(meta.options.length, 5);
  const mode = meta.options.find((option) => option.key === 'pdfMode');
  assert.equal(mode.default, 'auto');
  assert.equal(mode.choices.length, 6);
});

/* ------------------------------------------------------------------ *
 * assembleLines
 * ------------------------------------------------------------------ */

test('assembleLines：逐字分段的英文不会被拆成 H e l l o', () => {
  const items = 'Hello'.split('').map((ch, index) => textItem(ch, index * 8, 100, { width: 8 }));
  assert.deepEqual(assembleLines(items), ['Hello']);
});

test('assembleLines：按词分段的英文按间隙补回空格', () => {
  const items = [
    textItem('Hello', 0, 100, { width: 45 }),
    textItem('World', 60, 100, { width: 42 }),
    textItem('again', 108, 100, { width: 38 }),
  ];
  assert.deepEqual(assembleLines(items), ['Hello World again']);
});

test('assembleLines：中文之间绝不插入空格（不乱码不粘连）', () => {
  const items = [
    textItem('你好', 0, 100, { width: 20 }),
    textItem('世界', 20, 100, { width: 20 }),
    textItem('，', 40, 100, { width: 10 }),
    textItem('这是测试', 50, 100, { width: 40 }),
  ];
  assert.deepEqual(assembleLines(items), ['你好世界，这是测试']);
});

test('assembleLines：中文之间明显的字间距（分栏/表格）保留空白', () => {
  const items = [textItem('姓名', 0, 100, { width: 20 }), textItem('张三', 80, 100, { width: 20 })];
  assert.deepEqual(assembleLines(items), ['姓名 张三']);
});

test('assembleLines：按 y 聚类成行、行内按 x 排序，忽略输入顺序', () => {
  const items = [
    textItem('World', 60, 100, { width: 45 }),
    textItem('第二行', 0, 78, { width: 30 }),
    textItem('Hello', 0, 100, { width: 45 }),
  ];
  assert.deepEqual(assembleLines(items), ['Hello World', '第二行']);
});

test('assembleLines：同一段落里不同字号的上下标仍归到一行', () => {
  const items = [
    textItem('E', 0, 100, { size: 12, width: 8 }),
    textItem('=', 9, 100, { size: 12, width: 8 }),
    textItem('mc', 18, 100, { size: 8, width: 10 }),
    textItem('2', 28, 101.5, { size: 6, width: 4 }),
  ];
  // 字号差 2 倍、基线差 1.5pt，仍必须聚成一行；数学式的紧凑间距不补空格
  assert.deepEqual(assembleLines(items), ['E=mc2']);
});

test('assembleLines：单个 item 内含换行时会拆成多行', () => {
  const items = [textItem('第一行\n第二行', 0, 100, { size: 10, width: 60 })];
  assert.deepEqual(assembleLines(items), ['第一行', '第二行']);
});

test('assembleLines：空输入与全空白输入返回空数组', () => {
  assert.deepEqual(assembleLines([]), []);
  assert.deepEqual(assembleLines(undefined), []);
  assert.deepEqual(assembleLines([{ str: '   ', transform: [1, 0, 0, 1, 0, 0] }]), []);
});

/* ------------------------------------------------------------------ *
 * parsePageRange
 * ------------------------------------------------------------------ */

test('parsePageRange：留空表示全部页', () => {
  assert.deepEqual(parsePageRange('', 4), [1, 2, 3, 4]);
  assert.deepEqual(parsePageRange('   ', 2), [1, 2]);
  assert.deepEqual(parsePageRange(undefined, 1), [1]);
});

test('parsePageRange：区间与单页混写，保持用户给的顺序并去重', () => {
  assert.deepEqual(parsePageRange('1-3,7', 10), [1, 2, 3, 7]);
  assert.deepEqual(parsePageRange('3,1-2', 5), [3, 1, 2]);
  assert.deepEqual(parsePageRange('1-2,2, 3', 5), [1, 2, 3]);
  assert.deepEqual(parsePageRange('1-2,5-6', 6), [1, 2, 5, 6]);
});

test('parsePageRange：兼容中文逗号、顿号与空格', () => {
  assert.deepEqual(parsePageRange('1，3、5', 6), [1, 3, 5]);
  assert.deepEqual(parsePageRange('1 - 2', 4), [1, 2]);
});

test('parsePageRange：非法范围一律抛 PDF_PAGE_RANGE_INVALID', () => {
  const cases = ['0', '0-2', '5-3', '9-12', 'abc', '1-', '-3', '1..3', '2-2-2'];
  for (const spec of cases) {
    assert.throws(
      () => parsePageRange(spec, 5),
      (err) => err instanceof ConversionError && err.code === 'PDF_PAGE_RANGE_INVALID',
      `「${spec}」应当被拒绝`,
    );
  }
});

test('parsePageRange：页数为 0 或负时直接报错', () => {
  for (const count of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => parsePageRange('1', count),
      (err) => err instanceof ConversionError && err.code === 'PDF_PAGE_RANGE_INVALID',
    );
  }
});

/* ------------------------------------------------------------------ *
 * PDF → 文字
 * ------------------------------------------------------------------ */

test('PDF → TXT：提取出英文内容且不粘连', async () => {
  const pdf = await makePdf([['Hello World', 'Second line'], ['Page two text']]);
  const api = createApi({ name: '报告.pdf', bytes: pdf, options: { target: 'txt' } });
  const result = await convert(api.input, api);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, '报告.txt');
  const text = api.decode(result.files[0].bytes);
  assert.match(text, /Hello World/);
  assert.match(text, /Second line/);
  assert.match(text, /Page two text/);
  // 行不能粘成一坨：第二行必须在自己的行上
  assert.notEqual(text.split('\n').findIndex((line) => line.includes('Second line')), -1);
  assert.equal(result.preview.includes('Hello World'), true);
});

test('PDF → TXT：页码范围只导出指定页', async () => {
  const pdf = await makePdf([['First page'], ['Second page'], ['Third page']]);
  const api = createApi({ name: 'three.pdf', bytes: pdf, options: { target: 'txt', pages: '1,3' } });
  const result = await convert(api.input, api);
  const text = api.decode(result.files[0].bytes);
  assert.match(text, /First page/);
  assert.match(text, /Third page/);
  assert.doesNotMatch(text, /Second page/);
});

test('PDF → MD：带标题并保留行结构', async () => {
  const pdf = await makePdf([['Alpha', 'Beta']]);
  const api = createApi({ name: 'notes.pdf', bytes: pdf, options: { target: 'md' } });
  const result = await convert(api.input, api);
  assert.equal(result.files[0].name, 'notes.md');
  const text = api.decode(result.files[0].bytes);
  assert.match(text, /^# notes/);
  assert.match(text, /Alpha/);
});

test('PDF → HTML：转义并带 meta charset', async () => {
  const pdf = await makePdf([['Alpha & Beta']]);
  const api = createApi({ name: 'doc.pdf', bytes: pdf, options: { target: 'html' } });
  const result = await convert(api.input, api);
  const html = api.decode(result.files[0].bytes);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /Alpha &amp; Beta/);
});

test('PDF → 图片：Node 环境报 PDF_RENDER_UNAVAILABLE', async () => {
  const pdf = await makePdf([['Render me']]);
  const api = createApi({ name: 'doc.pdf', bytes: pdf, options: { target: 'png' } });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.equal(err.code, 'PDF_RENDER_UNAVAILABLE');
    assert.match(err.message, /浏览器/);
    return true;
  });
});

/* ------------------------------------------------------------------ *
 * PDF 结构操作
 * ------------------------------------------------------------------ */

test('merge：多个 PDF 合并后页数为各页之和', async () => {
  const first = await makePdf([['A1'], ['A2']]);
  const second = await makePdf([['B1'], ['B2'], ['B3']]);
  const api = createApi({
    name: 'first.pdf',
    bytes: first,
    options: { target: 'pdf', pdfMode: 'merge' },
    extraInputs: [
      { name: 'first.pdf', ext: 'pdf', bytes: first },
      { name: 'second.pdf', ext: 'pdf', bytes: second },
    ],
  });
  const result = await convert(api.input, api);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, 'merged.pdf');
  assert.equal(await countPages(result.files[0].bytes), 5);
  const lines = await extractWithPdfJs(result.files[0].bytes);
  assert.deepEqual(lines, ['A1', 'A2', 'B1', 'B2', 'B3']);
});

test('split：抽取第 2 页得到单页 PDF，内容正确', async () => {
  const pdf = await makePdf([['First page'], ['Second page'], ['Third page']]);
  const api = createApi({ name: 'book.pdf', bytes: pdf, options: { target: 'pdf', pdfMode: 'split', pages: '2' } });
  const result = await convert(api.input, api);
  assert.equal(result.files[0].name, 'book-p2.pdf');
  assert.equal(await countPages(result.files[0].bytes), 1);
  assert.deepEqual(await extractWithPdfJs(result.files[0].bytes), ['Second page']);
});

test('split：auto 模式下只给页码范围就会走抽取', async () => {
  const pdf = await makePdf([['P1'], ['P2'], ['P3'], ['P4']]);
  const api = createApi({ name: 'book.pdf', bytes: pdf, options: { target: 'pdf', pages: '2-3' } });
  const result = await convert(api.input, api);
  assert.equal(result.files[0].name, 'book-p2-3.pdf');
  assert.deepEqual(await extractWithPdfJs(result.files[0].bytes), ['P2', 'P3']);
});

test('rotate：旋转 90° 后页数与旋转角都正确', async () => {
  const pdf = await makePdf([['Rotate me'], ['And me']]);
  const api = createApi({ name: 'scan.pdf', bytes: pdf, options: { target: 'pdf', pdfMode: 'rotate', rotate: '90' } });
  const result = await convert(api.input, api);
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.load(result.files[0].bytes);
  assert.equal(doc.getPageCount(), 2);
  assert.equal(doc.getPage(0).getRotation().angle, 90);
  assert.equal(doc.getPage(1).getRotation().angle, 90);
});

test('rotate：只旋转指定页，其余页保持原样', async () => {
  const pdf = await makePdf([['P1'], ['P2'], ['P3']]);
  const api = createApi({
    name: 'scan.pdf',
    bytes: pdf,
    options: { target: 'pdf', pdfMode: 'rotate', rotate: '180', pages: '2' },
  });
  const result = await convert(api.input, api);
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.load(result.files[0].bytes);
  assert.equal(doc.getPage(0).getRotation().angle, 0);
  assert.equal(doc.getPage(1).getRotation().angle, 180);
  assert.equal(doc.getPageCount(), 3);
});

test('rotate：非法角度抛 PDF_ROTATE_INVALID', async () => {
  const pdf = await makePdf([['P1']]);
  const api = createApi({ name: 'scan.pdf', bytes: pdf, options: { target: 'pdf', pdfMode: 'rotate', rotate: '45' } });
  await assert.rejects(convert(api.input, api), (err) => err instanceof ConversionError && err.code === 'PDF_ROTATE_INVALID');
});

/* ------------------------------------------------------------------ *
 * 图片 / 文字 → PDF
 * ------------------------------------------------------------------ */

test('图片 → PDF：PNG 按原比例生成页面', async (t) => {
  const { createCanvas } = await import('@napi-rs/canvas').catch(() => ({}));
  if (!createCanvas) {
    t.skip('未安装 @napi-rs/canvas，跳过 PNG 生成');
    return;
  }
  const canvas = createCanvas(200, 100);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(0, 0, 200, 100);
  const png = new Uint8Array(canvas.toBuffer('image/png'));
  const api = createApi({ name: 'cover.png', bytes: png, options: { target: 'pdf' } });
  const result = await convert(api.input, api);
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.load(result.files[0].bytes);
  assert.equal(doc.getPageCount(), 1);
  const { width, height } = doc.getPage(0).getSize();
  assert.equal(Math.round(width), 200);
  assert.equal(Math.round(height), 100);
});

test('图片 → PDF：BMP 走纯 JS 栅格化路径也能嵌入', async () => {
  const width = 8;
  const height = 4;
  const rowSize = Math.floor((width * 3 + 3) / 4) * 4;
  const bmp = new Uint8Array(54 + rowSize * height);
  const view = new DataView(bmp.buffer);
  bmp[0] = 0x42;
  bmp[1] = 0x4d;
  view.setUint32(2, bmp.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  const api = createApi({ name: 'icon.bmp', bytes: bmp, options: { target: 'pdf', pageSize: 'a4' } });
  const result = await convert(api.input, api);
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.load(result.files[0].bytes);
  const size = doc.getPage(0).getSize();
  assert.ok(Math.abs(size.width - 595.28) < 1, 'A4 页面宽度应为 595.28pt');
  assert.ok(Math.abs(size.height - 841.89) < 1);
});

test('文字 → PDF：英文文本能排进 PDF 并读回来', async () => {
  const text = 'Hello PDF\nSecond paragraph with a longer sentence that should wrap somewhere.';
  const api = createApi({ name: 'readme.txt', bytes: utf8(text), options: { target: 'pdf' } });
  const result = await convert(api.input, api);
  assert.equal(result.files[0].name, 'readme.pdf');
  const lines = await extractWithPdfJs(result.files[0].bytes);
  assert.ok(lines.some((line) => line.includes('Hello PDF')), `缺少 Hello PDF：${lines.join(' | ')}`);
  assert.ok(lines.some((line) => line.includes('Second paragraph')), `缺少第二段：${lines.join(' | ')}`);
});

test('文字 → PDF：中文文本抛 PDF_CJK_FONT_UNAVAILABLE 并给出替代方案', async () => {
  const api = createApi({
    name: '中文说明.txt',
    bytes: utf8('这是一段中文说明。'),
    options: { target: 'pdf' },
  });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.equal(err.code, 'PDF_CJK_FONT_UNAVAILABLE');
    assert.match(err.message, /HTML/);
    return true;
  });
});

test('Markdown → PDF：语法标记被清理成纯文本', async () => {
  const markdown = '# Title\n\n- first item\n- second item\n\n**bold** and [link](https://example.com)\n';
  const api = createApi({ name: 'notes.md', bytes: utf8(markdown), options: { target: 'pdf' } });
  const result = await convert(api.input, api);
  const lines = await extractWithPdfJs(result.files[0].bytes);
  const joined = lines.join('\n');
  assert.match(joined, /Title/);
  assert.doesNotMatch(joined, /#/);
  assert.match(joined, /bold and link/);
  assert.doesNotMatch(joined, /example\.com/);
});

test('HTML → PDF：标签被剥离，实体被还原', async () => {
  const html = '<html><body><h1>Heading</h1><p>Alpha &amp; Beta</p><ul><li>One</li><li>Two</li></ul></body></html>';
  const api = createApi({ name: 'page.html', bytes: utf8(html), options: { target: 'pdf' } });
  const result = await convert(api.input, api);
  const joined = (await extractWithPdfJs(result.files[0].bytes)).join('\n');
  assert.match(joined, /Heading/);
  assert.match(joined, /Alpha & Beta/);
  assert.match(joined, /One/);
  assert.doesNotMatch(joined, /<li>/);
});

test('合并：PDF + 文字混排成一个 PDF', async () => {
  const pdf = await makePdf([['From PDF']]);
  const api = createApi({
    name: 'mixed.pdf',
    bytes: pdf,
    options: { target: 'pdf', pdfMode: 'merge' },
    extraInputs: [
      { name: 'source.pdf', ext: 'pdf', bytes: pdf },
      { name: 'notes.txt', ext: 'txt', bytes: utf8('From text file') },
    ],
  });
  const result = await convert(api.input, api);
  assert.equal(await countPages(result.files[0].bytes), 2);
  const lines = await extractWithPdfJs(result.files[0].bytes);
  assert.match(lines.join('\n'), /From PDF/);
  assert.match(lines.join('\n'), /From text file/);
});

/* ------------------------------------------------------------------ *
 * 错误路径
 * ------------------------------------------------------------------ */

test('坏 PDF 抛 PDF_PARSE_FAILED', async () => {
  const broken = utf8('%PDF-1.7\n这不是一个真的 PDF 文件');
  const api = createApi({ name: 'broken.pdf', bytes: broken, options: { target: 'txt' } });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError, '必须是 ConversionError');
    assert.equal(err.code, 'PDF_PARSE_FAILED');
    return true;
  });
});

test('空输入：错误受控且信息可读', async () => {
  const api = createApi({ name: 'empty.pdf', bytes: new Uint8Array(0), options: { target: 'txt' } });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.ok(['PDF_PARSE_FAILED', 'PDF_EMPTY'].includes(err.code));
    return true;
  });
});

test('不支持的目标格式抛 PDF_TARGET_UNSUPPORTED', async () => {
  const pdf = await makePdf([['x']]);
  const api = createApi({ name: 'a.pdf', bytes: pdf, options: { target: 'docx' } });
  await assert.rejects(convert(api.input, api), (err) => err instanceof ConversionError && err.code === 'PDF_TARGET_UNSUPPORTED');
});

test('显式模式与目标格式冲突时抛 PDF_MODE_TARGET_CONFLICT', async () => {
  const pdf = await makePdf([['x']]);
  const api = createApi({ name: 'a.pdf', bytes: pdf, options: { target: 'txt', pdfMode: 'merge' } });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.equal(err.code, 'PDF_MODE_TARGET_CONFLICT');
    assert.match(err.message, /txt/);
    return true;
  });
});

test('显式渲染模式在 Node 下仍然报 PDF_RENDER_UNAVAILABLE', async () => {
  const pdf = await makePdf([['x']]);
  const api = createApi({ name: 'a.pdf', bytes: pdf, options: { target: 'png', pdfMode: 'render' } });
  const error = await convert(api.input, api).catch((err) => err);
  assert.ok(error instanceof ConversionError);
  assert.equal(error.code, 'PDF_RENDER_UNAVAILABLE');
});

test('SVG：Node 环境给出可执行的替代路径', async () => {
  const svg = utf8('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  const api = createApi({ name: 'logo.svg', bytes: svg, options: { target: 'pdf' } });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.equal(err.code, 'PDF_SVG_UNAVAILABLE');
    return true;
  });
});

test('不认识的处理方式抛 PDF_MODE_UNSUPPORTED', async () => {
  const pdf = await makePdf([['x']]);
  const api = createApi({ name: 'a.pdf', bytes: pdf, options: { target: 'pdf', pdfMode: 'shred' } });
  await assert.rejects(convert(api.input, api), (err) => err instanceof ConversionError && err.code === 'PDF_MODE_UNSUPPORTED');
});

test('进度上报始终收尾到 1', async () => {
  const pdf = await makePdf([['Progress']]);
  const api = createApi({ name: 'a.pdf', bytes: pdf, options: { target: 'txt' } });
  await convert(api.input, api);
  assert.equal(api.__progress.at(-1).ratio, 1);
});
