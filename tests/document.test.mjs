/**
 * 文档模块测试：docx / md / html / epub / rtf / txt 的正向、往返、边界与坏文件路径。
 * fixture 全部现场生成，不提交二进制。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { convert, meta } from '../src/core/document.js';
import { ConversionError } from '../src/core/errors.js';
import { decodeBytes, detectEncoding, encodeText } from '../src/core/encoding.js';
import { extOf, mimeOfExt, sanitizeFileName } from '../src/core/util.js';

/* ------------------------------------------------------------------ *
 * api 桩：与 CONTRACT.md 第 3 节的 Api 表一一对应
 * ------------------------------------------------------------------ */

function createApi(name, bytes, options = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const input = { name, ext: extOf(name), mime: mimeOfExt(extOf(name)), size: data.length, bytes: data };
  const noteLog = [];
  const progressLog = [];
  return {
    input,
    env: 'node',
    detected: detectEncoding(data),
    opt: (key, fallback) => (options[key] === undefined ? fallback : options[key]),
    bytes: () => input.bytes,
    text: (encoding) => decodeBytes(input.bytes, encoding ?? 'auto'),
    encode: (text, encoding) => encodeText(text, encoding ?? 'utf-8'),
    decode: (value, encoding) => decodeBytes(value, encoding ?? 'auto'),
    // Node 侧 api.lib 就是动态 import；CJS 默认导出由被测模块自己兼容
    lib: async (libName) => await import(libName),
    progress: (ratio, label) => progressLog.push({ ratio, label }),
    note: (level, message) => noteLog.push({ level, message }),
    fileName: (value) => sanitizeFileName(value),
    zip: (entries) => zipEntries(entries),
    unzip: (value) => unzipEntries(value),
    // 测试观察点
    noteLog,
    progressLog,
  };
}

async function fflate() {
  return await import('fflate');
}

async function zipEntries(entries) {
  const { zipSync } = await fflate();
  const bundle = {};
  for (const entry of entries) bundle[entry.name] = [entry.bytes, { level: 6 }];
  return zipSync(bundle);
}

async function unzipEntries(bytes) {
  const { unzipSync } = await fflate();
  return unzipSync(bytes);
}

const textOf = (bytes) => new TextDecoder('utf-8').decode(bytes);

/* ------------------------------------------------------------------ *
 * fixture 生成
 * ------------------------------------------------------------------ */

/** 最小合法 PNG 编码器：docx/EPUB 里塞图片不需要真图像库 */
function makePng(width, height, rgb) {
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (buffer) => {
    let c = -1;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([head, body, tail]);
  };
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      raw[rowStart + 1 + x * 3] = rgb[0];
      raw[rowStart + 2 + x * 3] = rgb[1];
      raw[rowStart + 3 + x * 3] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 真彩色
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** 含中文标题 / 段落 / 列表 / 表格 / 图片的 docx */
async function buildFixtureDocx() {
  const docx = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, ImageRun } = docx;
  const doc = new Document({
    creator: 'Prism 测试',
    title: '起风了',
    sections: [{
      properties: {},
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('第一章 起风了')] }),
        new Paragraph({ children: [new TextRun('这是一个中文段落，用来验证 docx 解析不会乱码。')] }),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('1.1 小节标题')] }),
        new Paragraph({ text: '列表项甲', bullet: { level: 0 } }),
        new Paragraph({ text: '列表项乙', bullet: { level: 0 } }),
        new Table({
          rows: [
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph('姓名')] }),
                new TableCell({ children: [new Paragraph('年龄')] }),
              ],
            }),
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph('张三')] }),
                new TableCell({ children: [new Paragraph('三十')] }),
              ],
            }),
          ],
        }),
        new Paragraph({
          children: [new ImageRun({
            type: 'png',
            data: Buffer.from(makePng(4, 4, [200, 30, 30])),
            transformation: { width: 8, height: 8 },
          })],
        }),
      ],
    }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

const CHAPTER_ONE = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title>
<style>p { color: red; }</style></head>
<body><h1>第一章 起风了</h1><p>第一章正文：风从东边来，吹动了院子里的槐树。</p>
<script>console.log('should be ignored')</script>
</body></html>`;

const CHAPTER_TWO = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head>
<body><h1>第二章 雨停了</h1><p>第二章正文：雨停了，屋檐还在滴水。</p></body></html>`;

/** 手写最小 EPUB：中文文件名走 URL 编码，spine 顺序与 manifest 顺序刻意不一致 */
async function buildFixtureEpub() {
  const { zipSync } = await fflate();
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test-book</dc:identifier>
    <dc:title>风起时</dc:title>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="c2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;
  return zipSync({
    mimetype: [encodeText('application/epub+zip', 'utf-8'), { level: 0 }],
    'META-INF/container.xml': [encodeText(container, 'utf-8'), { level: 9 }],
    'OEBPS/content.opf': [encodeText(opf, 'utf-8'), { level: 9 }],
    'OEBPS/text/第一章.xhtml': [encodeText(CHAPTER_ONE, 'utf-8'), { level: 9 }],
    'OEBPS/text/chapter2.xhtml': [encodeText(CHAPTER_TWO, 'utf-8'), { level: 9 }],
    'OEBPS/style.css': [encodeText('body { margin: 0; }', 'utf-8'), { level: 9 }],
  }, { level: 6 });
}

/* ------------------------------------------------------------------ *
 * 契约与静态检查
 * ------------------------------------------------------------------ */

test('meta 与契约一致', () => {
  assert.equal(meta.id, 'document');
  assert.equal(meta.category, 'document');
  assert.deepEqual(meta.to, ['txt', 'md', 'html', 'docx', 'epub']);
  for (const ext of ['docx', 'txt', 'md', 'html', 'htm', 'rtf', 'epub', 'odt']) {
    assert.ok(meta.from.includes(ext), `from 应包含 ${ext}`);
  }
  assert.equal(meta.options.find((o) => o.key === 'headingStyle').default, 'hash');
  assert.equal(meta.options.find((o) => o.key === 'keepImages').default, true);
  assert.equal(meta.options.find((o) => o.key === 'encoding').default, 'utf-8');
  assert.equal(meta.options.find((o) => o.key === 'title').default, '');
});

test('模块内不出现第三方库的顶层 import', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/core/document.js', import.meta.url)), 'utf-8');
  const imports = [...source.matchAll(/^\s*import\s[^;]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  for (const specifier of imports) {
    assert.ok(specifier.startsWith('./'), `顶层 import 只允许本地模块，发现：${specifier}`);
  }
});

/* ------------------------------------------------------------------ *
 * docx → md / txt / html
 * ------------------------------------------------------------------ */

test('docx → md：中文不乱码，标题层级/列表/表格/图片都在', async () => {
  const api = createApi('小说.docx', await buildFixtureDocx(), { target: 'md' });
  const result = await convert(api.input, api);
  const out = textOf(result.files[0].bytes);

  assert.equal(result.files[0].name, '小说.md');
  assert.equal(result.files[0].mime, 'text/markdown');
  assert.match(out, /^# 第一章 起风了$/m);
  assert.match(out, /^## 1\.1 小节标题$/m);
  assert.match(out, /这是一个中文段落，用来验证 docx 解析不会乱码。/);
  assert.match(out, /列表项甲/);
  assert.match(out, /列表项乙/);
  assert.match(out, /^\| 姓名 \| 年龄 \|$/m);
  assert.match(out, /^\| --- \| --- \|$/m);
  assert.match(out, /\| 张三 \| 三十 \|/);
  assert.match(out, /!\[[^\]]*\]\(data:image\/png;base64,/);

  const messages = result.notes.map((n) => n.message).join(' ');
  assert.match(messages, /已内嵌 1 张图片/);
  assert.ok(result.preview.length > 0 && result.preview.length <= 2000);
  assert.match(result.preview, /第一章 起风了/);
});

test('docx → txt：中文与标题标记，图片降级为占位符', async () => {
  const api = createApi('小说.docx', await buildFixtureDocx(), { target: 'txt' });
  const result = await convert(api.input, api);
  const out = textOf(result.files[0].bytes);

  assert.equal(result.files[0].name, '小说.txt');
  assert.match(out, /# 第一章 起风了/);
  assert.match(out, /## 1\.1 小节标题/);
  assert.match(out, /- 列表项甲/);
  assert.match(out, /这是一个中文段落/);
  assert.match(out, /姓名\t年龄/);
  assert.match(out, /\[图片\]/);
  assert.ok(!out.includes('base64'), 'txt 里不应出现 base64');
});

test('docx → html：内嵌 base64 图片，keepImages=false 时不保留', async () => {
  const bytes = await buildFixtureDocx();

  const withImages = createApi('小说.docx', bytes, { target: 'html' });
  const htmlResult = await convert(withImages.input, withImages);
  const html = textOf(htmlResult.files[0].bytes);
  assert.equal(htmlResult.files[0].name, '小说.html');
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<h1>第一章 起风了<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /data:image\/png;base64/);

  const withoutImages = createApi('小说.docx', bytes, { target: 'html', keepImages: false });
  const plainResult = await convert(withoutImages.input, withoutImages);
  const plainHtml = textOf(plainResult.files[0].bytes);
  assert.ok(!plainHtml.includes('data:image'), 'keepImages=false 时不应有内嵌图片');
  assert.match(plainHtml, /第一章 起风了/);
  assert.match(plainResult.notes.map((n) => n.message).join(' '), /忽略了 1 张图片/);
});

test('docx → md：headingStyle=number / plain 改变标题输出形式', async () => {
  const bytes = await buildFixtureDocx();

  const numbered = createApi('小说.docx', bytes, { target: 'md', headingStyle: 'number' });
  const numberedOut = textOf((await convert(numbered.input, numbered)).files[0].bytes);
  assert.match(numberedOut, /^一、第一章 起风了$/m);
  assert.match(numberedOut, /^（一）1\.1 小节标题$/m);
  assert.ok(!numberedOut.includes('# 第一章'));

  const plain = createApi('小说.docx', bytes, { target: 'md', headingStyle: 'plain' });
  const plainOut = textOf((await convert(plain.input, plain)).files[0].bytes);
  assert.match(plainOut, /^第一章 起风了$/m);
  assert.ok(!plainOut.includes('# 第一章'));
});

/* ------------------------------------------------------------------ *
 * md / txt / html → docx（往返）
 * ------------------------------------------------------------------ */

const SAMPLE_MARKDOWN = `# 第一章 起风了

风从东边来，院子里**很安静**。

## 一、小节

- 列表项甲
- 列表项乙

1. 有序甲
2. 有序乙

| 姓名 | 年龄 |
| --- | --- |
| 张三 | 三十 |

\`\`\`js
const 风 = '起风了';
\`\`\`

> 引用一段古诗。
`;

test('md → docx → md 往返：中文与结构不丢', async () => {
  const toDocx = createApi('小说.md', encodeText(SAMPLE_MARKDOWN, 'utf-8'), { target: 'docx' });
  const docxResult = await convert(toDocx.input, toDocx);
  const docxBytes = docxResult.files[0].bytes;

  assert.equal(docxResult.files[0].name, '小说.docx');
  assert.equal(String.fromCharCode(...docxBytes.slice(0, 2)), 'PK', 'docx 应该是 zip 容器');
  assert.ok(docxBytes.length > 1000, 'docx 体量应明显大于空文件');

  const back = createApi('小说.docx', docxBytes, { target: 'md' });
  const backResult = await convert(back.input, back);
  const roundTripped = textOf(backResult.files[0].bytes);

  assert.match(roundTripped, /第一章 起风了/);
  assert.match(roundTripped, /风从东边来/);
  assert.match(roundTripped, /很安静/);
  assert.match(roundTripped, /列表项甲/);
  assert.match(roundTripped, /^1\. 有序甲$/m);
  assert.match(roundTripped, /^2\. 有序乙$/m);
  assert.match(roundTripped, /张三/);
  assert.match(roundTripped, /^> .*引用一段古诗/m);
  assert.match(roundTripped, /```[\s\S]*const 风 = '起风了';[\s\S]*```/);
});

test('txt → docx：无标记的纯文本也能生成可打开的 docx', async () => {
  const text = '第一段中文。\n\n第二段中文，含数字 123 与英文 hello。';
  const api = createApi('随笔.txt', encodeText(text, 'utf-8'), { target: 'docx' });
  const result = await convert(api.input, api);
  const bytes = result.files[0].bytes;
  assert.equal(result.files[0].name, '随笔.docx');
  assert.equal(String.fromCharCode(...bytes.slice(0, 2)), 'PK');

  const entries = await unzipEntries(bytes);
  const documentXml = textOf(entries['word/document.xml']);
  assert.match(documentXml, /第一段中文/);
  assert.match(documentXml, /第二段中文/);
  // 东亚字体必须写在 run 的 rFonts 上，否则 Word 会回退到默认字体
  assert.match(documentXml, /eastAsia="宋体"/);
});

test('html → md / txt：turndown 保结构，纯文本实体解码正确', async () => {
  const html = `<!DOCTYPE html><html><head><title>测试页</title>
<style>p{color:red}</style></head><body>
<h1>标题一</h1>
<p>北京 &amp; 上海 &#20013;&#x6587; &nbsp;收尾</p>
<ul><li>甲</li><li>乙</li></ul>
<ol><li>第一</li><li>第二</li></ol>
<table><thead><tr><th>列甲</th><th>列乙</th></tr></thead>
<tbody><tr><td>1</td><td>2</td></tr></tbody></table>
<script>var a = 1;</script>
</body></html>`;

  const toText = createApi('页面.html', encodeText(html, 'utf-8'), { target: 'txt' });
  const textResult = await convert(toText.input, toText);
  const plain = textOf(textResult.files[0].bytes);
  assert.match(plain, /# 标题一/);
  assert.match(plain, /北京 & 上海 中文/);
  assert.match(plain, /- 甲/);
  assert.match(plain, /1\. 第一/);
  assert.match(plain, /列甲\t列乙/);
  assert.ok(!plain.includes('var a = 1'), '脚本内容不应出现在正文里');

  const toMarkdown = createApi('页面.html', encodeText(html, 'utf-8'), { target: 'md' });
  const markdownResult = await convert(toMarkdown.input, toMarkdown);
  const markdown = textOf(markdownResult.files[0].bytes);
  assert.match(markdown, /^# 标题一$/m);
  assert.match(markdown, /北京 & 上海 中文/);
  assert.match(markdown, /^\| 列甲 \| 列乙 \|$/m);
  assert.match(markdown, /^\| --- \| --- \|$/m);

  const toHtml = createApi('页面.html', encodeText(html, 'utf-8'), { target: 'html' });
  const htmlResult = await convert(toHtml.input, toHtml);
  assert.match(textOf(htmlResult.files[0].bytes), /<h1>标题一<\/h1>/);
});

/* ------------------------------------------------------------------ *
 * epub
 * ------------------------------------------------------------------ */

test('epub → txt / md / html：按 spine 顺序取章节，识别中文文件名', async () => {
  const bytes = await buildFixtureEpub();

  const toText = createApi('风起时.epub', bytes, { target: 'txt' });
  const textResult = await convert(toText.input, toText);
  const plain = textOf(textResult.files[0].bytes);
  assert.equal(textResult.files[0].name, '风起时.txt');
  assert.match(plain, /第一章 起风了/);
  assert.match(plain, /风从东边来/);
  assert.match(plain, /雨停了/);
  assert.ok(plain.indexOf('第一章') < plain.indexOf('第二章'), '章节顺序应与 spine 一致');
  assert.ok(!plain.includes('should be ignored'), '脚本内容不应进入正文');
  assert.match(textResult.notes.map((n) => n.message).join(' '), /2 个章节/);

  const toMarkdown = createApi('风起时.epub', bytes, { target: 'md' });
  const markdown = textOf((await convert(toMarkdown.input, toMarkdown)).files[0].bytes);
  assert.match(markdown, /^# 第一章 起风了$/m);
  assert.match(markdown, /^# 第二章 雨停了$/m);
  // 章节标题只应出现一次：不能既当章节名又留在正文里
  assert.equal(markdown.match(/第一章 起风了/g).length, 1);
  assert.equal(markdown.match(/第二章 雨停了/g).length, 1);

  const toHtml = createApi('风起时.epub', bytes, { target: 'html' });
  const htmlResult = await convert(toHtml.input, toHtml);
  const html = textOf(htmlResult.files[0].bytes);
  assert.match(html, /<title>风起时<\/title>/);
  assert.match(html, /<h1>第一章 起风了<\/h1>/);
});

test('md → epub：mimetype 未压缩且是第一个条目，OPF/nav/ncx 齐全', async () => {
  const markdown = `# 第一章 起风了

风从东边来。院子里**很安静**。

## 小节甲

- 列表项

# 第二章 雨停了

雨停了，屋檐还在滴水。
`;
  const api = createApi('书.md', encodeText(markdown, 'utf-8'), { target: 'epub' });
  const result = await convert(api.input, api);
  const epub = result.files[0].bytes;

  assert.equal(result.files[0].name, '书.epub');
  assert.equal(result.files[0].mime, 'application/epub+zip');

  // 直接读 zip 本地文件头：第一个条目必须是未压缩的 mimetype
  assert.equal(String.fromCharCode(...epub.slice(0, 4)), 'PK\x03\x04', 'zip 本地文件头');
  const method = epub[8] | (epub[9] << 8);
  assert.equal(method, 0, 'mimetype 必须以「存储」方式写入（压缩方式 0）');
  const nameLength = epub[26] | (epub[27] << 8);
  const extraLength = epub[28] | (epub[29] << 8);
  assert.equal(textOf(epub.slice(30, 30 + nameLength)), 'mimetype');
  const contentStart = 30 + nameLength + extraLength;
  assert.equal(textOf(epub.slice(contentStart, contentStart + 20)), 'application/epub+zip');

  const entries = await unzipEntries(epub);
  assert.equal(Object.keys(entries)[0], 'mimetype', 'mimetype 必须是第一个条目');
  for (const required of ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/toc.ncx']) {
    assert.ok(entries[required], `EPUB 应包含 ${required}`);
  }
  const opf = textOf(entries['OEBPS/content.opf']);
  // 书名优先级：选项 title > 输入文件名（第一章 是章节名，不适合当书名）
  assert.match(opf, /<dc:title>书<\/dc:title>/);
  assert.match(opf, /<dc:language>zh-CN<\/dc:language>/);
  assert.match(opf, /properties="nav"/);
  assert.match(opf, /dcterms:modified/);

  const titled = createApi('书.md', encodeText(markdown, 'utf-8'), { target: 'epub', title: '风起时' });
  const titledOpf = textOf((await unzipEntries((await convert(titled.input, titled)).files[0].bytes))['OEBPS/content.opf']);
  assert.match(titledOpf, /<dc:title>风起时<\/dc:title>/);

  const chapterOne = textOf(entries['OEBPS/chapter-1.xhtml']);
  const chapterTwo = textOf(entries['OEBPS/chapter-2.xhtml']);
  assert.match(chapterOne, /第一章 起风了/);
  assert.match(chapterOne, /风从东边来/);
  assert.match(chapterOne, /xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  assert.match(chapterTwo, /第二章 雨停了/);
  assert.ok(!/<br>/.test(chapterOne), 'XHTML 里空元素必须自闭合');
});

test('md → epub → txt 回环：章节与正文都还在', async () => {
  const api = createApi('书.md', encodeText(SAMPLE_MARKDOWN, 'utf-8'), { target: 'epub' });
  const epub = (await convert(api.input, api)).files[0].bytes;

  const back = createApi('书.epub', epub, { target: 'txt' });
  const plain = textOf((await convert(back.input, back)).files[0].bytes);
  assert.match(plain, /第一章 起风了/);
  assert.match(plain, /风从东边来/);
  assert.match(plain, /列表项甲/);
  assert.match(plain, /引用一段古诗/);
});

test('md → epub：无一级标题时整体一章', async () => {
  const api = createApi('无标题.md', encodeText('只有一段正文，没有标题。', 'utf-8'), { target: 'epub' });
  const epub = (await convert(api.input, api)).files[0].bytes;
  const entries = await unzipEntries(epub);
  assert.ok(entries['OEBPS/chapter-1.xhtml']);
  assert.ok(!entries['OEBPS/chapter-2.xhtml']);
  assert.match(textOf(entries['OEBPS/chapter-1.xhtml']), /只有一段正文/);
});

/* ------------------------------------------------------------------ *
 * rtf
 * ------------------------------------------------------------------ */

test('rtf → txt：\\uN? 转义、\\\'hh 十六进制字节、段落与跳过目标组', async () => {
  const rtf = String.raw`{\rtf1\ansi\ansicpg936\deff0{\fonttbl{\f0\fnil\fcharset134 宋体;}}{\*\generator Riched20 10.0;}\f0\fs21
第一章 起风了\par
Hello \u20013?\u25991? world\par
十六进制：\'d6\'d0\'ce\'c4\par
带\tab 制表符\line 换行\par
{\colortbl;\red0\green0\blue0;}颜色表应当被忽略\par
}`;
  const api = createApi('样例.rtf', encodeText(rtf, 'utf-8'), { target: 'txt' });
  const result = await convert(api.input, api);
  const out = textOf(result.files[0].bytes);

  assert.equal(result.files[0].name, '样例.txt');
  assert.match(out, /第一章 起风了/);
  assert.match(out, /Hello 中文 world/);
  assert.match(out, /十六进制：中文/);
  assert.match(out, /带\t制表符\n换行/);
  assert.match(out, /颜色表应当被忽略/);
  assert.ok(!out.includes('Riched20'), '\\*\\generator 目标组应被跳过');
  assert.ok(!out.includes('宋体'), '字体表应被跳过');
  assert.ok(!out.includes('red0'), '颜色表应被跳过');
});

test('rtf → md：输出仍是可用的 Markdown 文本', async () => {
  const rtf = String.raw`{\rtf1\ansi\ansicpg936 \u31532?\u19968?\u31456? \par 正文一段。\par}`;
  const api = createApi('样例.rtf', encodeText(rtf, 'utf-8'), { target: 'md' });
  const out = textOf((await convert(api.input, api)).files[0].bytes);
  assert.match(out, /第一章/);
  assert.match(out, /正文一段。/);
});

/* ------------------------------------------------------------------ *
 * odt（from 里声明了就得能用）
 * ------------------------------------------------------------------ */

const ODT_CONTENT = `<?xml version="1.0" encoding="utf-8"?>
<office:document-content
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
  <office:body><office:text>
    <text:h text:outline-level="1">第一章 起风了</text:h>
    <text:p>这是 ODT 的中文段落，含<text:span>行内文字</text:span>。</text:p>
    <text:list><text:list-item><text:p>列表项甲</text:p></text:list-item></text:list>
    <table:table><table:table-row><table:table-cell><text:p>单元格甲</text:p></table:table-cell></table:table-row></table:table>
  </office:text></office:body>
</office:document-content>`;

async function buildFixtureOdt() {
  const { zipSync } = await fflate();
  return zipSync({
    mimetype: [encodeText('application/vnd.oasis.opendocument.text', 'utf-8'), { level: 0 }],
    'META-INF/manifest.xml': [encodeText('<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>', 'utf-8')],
    'content.xml': [encodeText(ODT_CONTENT, 'utf-8'), { level: 9 }],
  }, { level: 6 });
}

test('odt → txt / md / docx：中文与结构', async () => {
  const odt = await buildFixtureOdt();

  const toText = createApi('文稿.odt', odt, { target: 'txt' });
  const textResult = await convert(toText.input, toText);
  const plain = textOf(textResult.files[0].bytes);
  assert.equal(textResult.files[0].name, '文稿.txt');
  assert.match(plain, /第一章 起风了/);
  assert.match(plain, /这是 ODT 的中文段落，含行内文字。/);
  assert.match(plain, /- 列表项甲/);
  assert.match(plain, /单元格甲/);
  assert.match(textResult.notes.map((n) => n.message).join(' '), /ODT 按 ODF 正文元素尽力提取/);

  const toMarkdown = createApi('文稿.odt', odt, { target: 'md' });
  const markdown = textOf((await convert(toMarkdown.input, toMarkdown)).files[0].bytes);
  assert.match(markdown, /^# 第一章 起风了$/m);
  assert.match(markdown, /\| 单元格甲 \|/);

  const toDocx = createApi('文稿.odt', odt, { target: 'docx' });
  const docxBytes = (await convert(toDocx.input, toDocx)).files[0].bytes;
  assert.equal(String.fromCharCode(...docxBytes.slice(0, 2)), 'PK');
});

test('坏 odt 抛 ODT_CORRUPT', async () => {
  const { zipSync } = await fflate();
  const zip = zipSync({ 'mimetype': encodeText('application/vnd.oasis.opendocument.text', 'utf-8') });
  const api = createApi('坏.odt', zip, { target: 'txt' });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.equal(err.code, 'ODT_CORRUPT');
    return true;
  });
});

/* ------------------------------------------------------------------ *
 * 边界与错误路径
 * ------------------------------------------------------------------ */

test('空文件不崩，产出空结果文件', async () => {
  const api = createApi('空.txt', new Uint8Array(0), { target: 'md' });
  const result = await convert(api.input, api);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, '空.md');
  assert.equal(result.files[0].bytes.length, 0);

  const toDocx = createApi('空.txt', new Uint8Array(0), { target: 'docx' });
  const docxResult = await convert(toDocx.input, toDocx);
  assert.equal(String.fromCharCode(...docxResult.files[0].bytes.slice(0, 2)), 'PK');
});

test('输出文件名沿用输入名并换扩展名，非法字符被消毒', async () => {
  const api = createApi('我的 小说:第一版?.md', encodeText('# 标题\n\n正文', 'utf-8'), { target: 'txt' });
  const result = await convert(api.input, api);
  assert.equal(result.files[0].name, '我的 小说_第一版_.txt');
});

test('gbk 输出编码：中文按 GBK 落盘仍可解回', async () => {
  const api = createApi('编码.md', encodeText('# 标题\n\n中文正文', 'utf-8'), { target: 'txt', encoding: 'gbk' });
  const result = await convert(api.input, api);
  const decoded = decodeBytes(result.files[0].bytes, 'gbk');
  assert.match(decoded, /中文正文/);
});

test('坏 docx 抛 DOCX_CORRUPT', async () => {
  const api = createApi('坏.docx', Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8), { target: 'md' });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError, '必须是 ConversionError');
    assert.equal(err.code, 'DOCX_CORRUPT');
    assert.match(err.message, /docx 解析失败/);
    assert.ok(err.message.length > 10);
    return true;
  });
});

test('坏 epub 抛 EPUB_INVALID', async () => {
  const api = createApi('坏.epub', encodeText('这不是 zip 文件', 'utf-8'), { target: 'txt' });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.equal(err.code, 'EPUB_INVALID');
    return true;
  });
});

test('缺少 container.xml 的 zip 也抛 EPUB_INVALID', async () => {
  const { zipSync } = await fflate();
  const zip = zipSync({ 'readme.txt': encodeText('普通压缩包', 'utf-8') });
  const api = createApi('假.epub', zip, { target: 'txt' });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.equal(err.code, 'EPUB_INVALID');
    assert.match(err.message, /container\.xml/);
    return true;
  });
});

test('非 RTF 文件抛 RTF_UNSUPPORTED', async () => {
  const api = createApi('假.rtf', encodeText('这只是一段普通文本', 'utf-8'), { target: 'txt' });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.equal(err.code, 'RTF_UNSUPPORTED');
    return true;
  });
});

test('不支持的输出格式抛 UNSUPPORTED_TARGET', async () => {
  const api = createApi('文档.md', encodeText('# 标题', 'utf-8'), { target: 'pdf' });
  await assert.rejects(convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.equal(err.code, 'UNSUPPORTED_TARGET');
    return true;
  });
});
