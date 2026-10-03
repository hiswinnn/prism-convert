import { convert } from '../src/core/document.js';
import { decodeBytes, encodeText, detectEncoding } from '../src/core/encoding.js';
import { sanitizeFileName, extOf, mimeOfExt } from '../src/core/util.js';
import { unzipSync } from 'fflate';
import mammoth from 'mammoth';

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

const md = '# 章一\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\n结尾段落。\n';
const a1 = mk('书.md', encodeText(md, 'utf-8'), { target: 'docx' });
const docx = (await convert(a1.input, a1)).files[0].bytes;
const a2 = mk('书.docx', docx, { target: 'md' });
const out = decodeBytes((await convert(a2.input, a2)).files[0].bytes, 'utf-8');
console.log('md 输出:', JSON.stringify(out));

const withMap = await mammoth.convertToHtml({ buffer: Buffer.from(docx) }, {
  styleMap: [
    "p[style-name='Prism Code'] => pre:separator('\n')",
    "p[style-name='Prism Quote'] => blockquote:fresh",
  ],
});
console.log('mammoth html（同样 styleMap）:', JSON.stringify(withMap.value));
