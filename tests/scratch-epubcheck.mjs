// 临时脚本：EPUB 内容完整性自检（manifest/spine/nav 与 zip 条目是否对得上）
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';

const bytes = new Uint8Array(readFileSync('E:/Projects/PrismConvert/tests/.tmp/书.epub'));
const entries = unzipSync(bytes);
const textOf = (b) => new TextDecoder('utf-8').decode(b);
const opf = textOf(entries['OEBPS/content.opf']);
const nav = textOf(entries['OEBPS/nav.xhtml']);
const ncx = textOf(entries['OEBPS/toc.ncx']);

const manifest = [...opf.matchAll(/<item\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"[^>]*\/>/g)]
  .map((m) => ({ id: m[1], href: m[2] }));
const spine = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)].map((m) => m[1]);

let problems = 0;
for (const item of manifest) {
  if (!entries[`OEBPS/${item.href}`]) {
    console.log('缺失 manifest 条目:', item.href);
    problems += 1;
  }
}
const ids = new Set(manifest.map((i) => i.id));
for (const idref of spine) {
  if (!ids.has(idref)) {
    console.log('spine 指向了不存在的 item:', idref);
    problems += 1;
  }
}
for (const href of spine.map((id) => manifest.find((i) => i.id === id)?.href)) {
  if (!nav.includes(`href="${href}"`)) {
    console.log('nav.xhtml 缺少章节链接:', href);
    problems += 1;
  }
  if (!ncx.includes(`src="${href}"`)) {
    console.log('toc.ncx 缺少章节:', href);
    problems += 1;
  }
}
console.log('zip 条目:', Object.keys(entries).join(', '));
console.log('spine:', spine.join(' → '), '| manifest:', manifest.map((i) => i.id).join(', '));
console.log(problems === 0 ? 'EPUB 自检通过' : `EPUB 自检发现 ${problems} 个问题`);
