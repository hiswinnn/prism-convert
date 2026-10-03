// 临时脚本：跑满 8×5 转换矩阵 + 用 xmldom 校验产物 XML 合法性（不属于交付测试）
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { convert, meta } from '../src/core/document.js';
import { detectEncoding, decodeBytes, encodeText } from '../src/core/encoding.js';
import { extOf, mimeOfExt, sanitizeFileName } from '../src/core/util.js';

const { zipSync, unzipSync } = await import('fflate');
const docxLib = await import('docx');

function createApi(name, bytes, options = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const input = { name, ext: extOf(name), mime: mimeOfExt(extOf(name)), size: data.length, bytes: data };
  return {
    input, env: 'node', detected: detectEncoding(data),
    opt: (k, f) => (options[k] === undefined ? f : options[k]),
    bytes: () => input.bytes,
    text: (e) => decodeBytes(input.bytes, e ?? 'auto'),
    encode: (t, e) => encodeText(t, e ?? 'utf-8'),
    decode: (v, e) => decodeBytes(v, e ?? 'auto'),
    lib: async (n) => await import(n),
    progress() {}, note() {},
    fileName: (v) => sanitizeFileName(v),
    zip: (entries) => zipSync(Object.fromEntries(entries.map((e) => [e.name, e.bytes]))),
    unzip: (b) => unzipSync(b),
  };
}

const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell } = docxLib;
const docxBytes = new Uint8Array(await Packer.toBuffer(new Document({
  sections: [{ children: [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('第一章 起风了')] }),
    new Paragraph('中文段落，含**粗体**与列表。'),
    new Paragraph({ text: '列表项甲', bullet: { level: 0 } }),
    new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('甲')] })] })] }),
  ] }],
})));

const md = '# 第一章 起风了\n\n正文**粗**。\n\n- 甲\n- 乙\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n';
const html = '<!DOCTYPE html><html><head><title>页面</title></head><body><h1>标题</h1><p>正文 &amp; 更多</p><ul><li>甲</li></ul></body></html>';
const rtf = String.raw`{\rtf1\ansi\ansicpg936 \u31532?\u19968?\u31456? \par 正文\par}`;
const odt = zipSync({
  mimetype: [encodeText('application/vnd.oasis.opendocument.text', 'utf-8'), { level: 0 }],
  'content.xml': [encodeText(`<?xml version="1.0" encoding="utf-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
<office:body><office:text>
<text:h text:outline-level="1">第一章 起风了</text:h>
<text:p>这是 ODT 的中文段落，含<text:span>行内文字</text:span>。</text:p>
<text:list><text:list-item><text:p>列表项甲</text:p></text:list-item></text:list>
<table:table><table:table-row><table:table-cell><text:p>单元格甲</text:p></table:table-cell></table:table-row></table:table>
</office:text></office:body></office:document-content>`, 'utf-8'), { level: 9 }],
}, { level: 6 });

const epubBytes = (() => {
  const container = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>风起时</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
  const ch = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1><p>EPUB 正文</p></body></html>`;
  return zipSync({
    mimetype: [encodeText('application/epub+zip', 'utf-8'), { level: 0 }],
    'META-INF/container.xml': [encodeText(container, 'utf-8')],
    'OEBPS/content.opf': [encodeText(opf, 'utf-8')],
    'OEBPS/c1.xhtml': [encodeText(ch, 'utf-8')],
  }, { level: 6 });
})();

const fixtures = {
  docx: ['示例.docx', docxBytes], txt: ['示例.txt', encodeText('纯文本\n\n第二段', 'utf-8')],
  md: ['示例.md', encodeText(md, 'utf-8')], html: ['示例.html', encodeText(html, 'utf-8')],
  htm: ['示例.htm', encodeText(html, 'utf-8')], rtf: ['示例.rtf', encodeText(rtf, 'utf-8')],
  epub: ['示例.epub', epubBytes], odt: ['示例.odt', odt],
};

let failures = 0;
for (const source of meta.from) {
  for (const target of meta.to) {
    const [name, bytes] = fixtures[source];
    const api = createApi(name, bytes, { target });
    try {
      const result = await convert(api.input, api);
      const file = result.files[0];
      if (!(file.bytes instanceof Uint8Array)) throw new Error('bytes 不是 Uint8Array');
      if (!file.name.endsWith(`.${target}`)) throw new Error(`文件名不对：${file.name}`);
      if (typeof result.preview !== 'string') throw new Error('preview 缺失');
      const text = decodeBytes(file.bytes, 'utf-8');
      if (target === 'docx' || target === 'epub') {
        const parts = unzipSync(file.bytes);
        for (const [partName, partBytes] of Object.entries(parts)) {
          if (!/\.(xml|opf|ncx|xhtml)$/.test(partName)) continue;
          const errors = [];
          new DOMParser({ onError: (level, msg) => { if (level === 'error' || level === 'fatalError') errors.push(msg); } })
            .parseFromString(decodeBytes(partBytes, 'utf-8'), 'application/xml');
          if (errors.length) throw new Error(`${partName} XML 非法：${errors[0]}`);
        }
      }
      console.log(`OK   ${source} → ${target}  ${file.name}  ${file.bytes.length}B  ${text.length}字`);
    } catch (err) {
      failures += 1;
      console.log(`FAIL ${source} → ${target}  ${err.code ?? ''} ${err.message}`);
    }
  }
}
console.log(failures === 0 ? '\n全部方向通过' : `\n${failures} 个方向失败`);
