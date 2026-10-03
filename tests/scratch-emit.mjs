// 临时脚本：把模块生成的 docx / epub 落到临时目录，交给外部工具做兼容性验证
import { mkdirSync, writeFileSync } from 'node:fs';
import { convert } from '../src/core/document.js';
import { decodeBytes, encodeText, detectEncoding } from '../src/core/encoding.js';
import { sanitizeFileName, extOf, mimeOfExt } from '../src/core/util.js';
import { unzipSync } from 'fflate';

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

const markdown = `# 第一章 起风了

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

mkdirSync(new URL('./.tmp/', import.meta.url), { recursive: true });
const outDir = new URL('./.tmp/', import.meta.url);

for (const target of ['docx', 'epub']) {
  const api = mk('书.md', encodeText(markdown, 'utf-8'), { target, title: '风起时' });
  const result = await convert(api.input, api);
  writeFileSync(new URL(result.files[0].name, outDir), result.files[0].bytes);
  console.log('已写出', result.files[0].name, result.files[0].bytes.length, 'B');
}
