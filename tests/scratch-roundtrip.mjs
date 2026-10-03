// 临时脚本：检查 md → docx → md 的往返保真与 docx 内部结构
import { convert } from '../src/core/document.js';
import { decodeBytes, encodeText, detectEncoding } from '../src/core/encoding.js';
import { sanitizeFileName, extOf, mimeOfExt } from '../src/core/util.js';
const { unzipSync } = await import('fflate');

const mk = (name, bytes, options = {}) => {
  const input = { name, ext: extOf(name), mime: mimeOfExt(extOf(name)), size: bytes.length, bytes };
  return {
    input, env: 'node', detected: detectEncoding(bytes),
    opt: (k, f) => (options[k] === undefined ? f : options[k]),
    bytes: () => bytes, text: (e) => decodeBytes(bytes, e ?? 'auto'),
    encode: (t, e) => encodeText(t, e ?? 'utf-8'), decode: (v, e) => decodeBytes(v, e ?? 'auto'),
    lib: async (n) => await import(n), progress() {}, note() {},
    fileName: sanitizeFileName, zip: () => {}, unzip: (b) => unzipSync(b),
  };
};

const md = `# 章一

1. 有序甲
2. 有序乙

- 无序甲
- 无序乙

> 引用一句话

\`\`\`js
const a = 1;
\`\`\`

| 列甲 | 列乙 |
| --- | --- |
| 1 | 2 |
`;
const a1 = mk('书.md', encodeText(md, 'utf-8'), { target: 'docx' });
const docx = (await convert(a1.input, a1)).files[0].bytes;
const a2 = mk('书.docx', docx, { target: 'md' });
console.log('--- md → docx → md ---');
console.log(decodeBytes((await convert(a2.input, a2)).files[0].bytes, 'utf-8'));

const parts = unzipSync(docx);
console.log('--- docx 部件 ---', Object.keys(parts).join(', '));
const docXml = decodeBytes(parts['word/document.xml'], 'utf-8');
console.log('eastAsia 出现次数:', (docXml.match(/w:eastAsia="宋体"/g) ?? []).length);
console.log('有序编号:', /w:numPr/.test(docXml), '| 表格:', /<w:tbl>/.test(docXml), '| 代码底纹:', /w:shd/.test(docXml), '| 引用缩进:', /w:ind /.test(docXml));
console.log('numbering.xml:', 'word/numbering.xml' in parts);
