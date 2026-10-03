// QA 探针：确认 docx fixture 本身合法（用 mammoth 交叉验证），并定位 document.js 的解析失败点
import { loadLib } from '../src/core/lib-loader.js';
import { unzipBytes } from '../src/core/zip.js';

const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await loadLib('docx');
const doc = new Document({ sections: [{ children: [
  new Paragraph({ text: '季度报告标题', heading: HeadingLevel.HEADING_1 }),
  new Paragraph({ children: [new TextRun('这是第一段中文正文，用来验证docx转Markdown。')] }),
] }] });
const bytes = new Uint8Array(await Packer.toBuffer(doc));
console.log('docx size', bytes.length);

// 1) mammoth 能否读出中文（参考实现）
try {
  const mammoth = await loadLib('mammoth');
  const out = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  console.log('mammoth OK, html head:', JSON.stringify(out.value.slice(0, 160)));
} catch (err) {
  console.log('mammoth ERROR', err.code ?? err.name, err.message);
}

// 2) 模块自己的 zip 入口能否解开
try {
  const entries = await unzipBytes(bytes);
  console.log('engine unzip entries:', entries.map((e) => e.name).slice(0, 10));
  const docXml = entries.find((e) => e.name === 'word/document.xml');
  console.log('document.xml size', docXml?.bytes.length, 'head:', JSON.stringify(new TextDecoder().decode(docXml?.bytes ?? new Uint8Array()).slice(0, 120)));
} catch (err) {
  console.log('engine unzip ERROR', err.code ?? err.name, err.message);
}

// 3) JSZip（document.js 可能用它）能否解开
try {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  console.log('jszip entries:', Object.keys(zip.files).slice(0, 10));
} catch (err) {
  console.log('jszip ERROR', err.code ?? err.name, err.message);
}

// 4) document.js 导出的内部函数（若导出）是否能定位
const documentModule = await import('../src/core/document.js');
console.log('document.js exports:', Object.keys(documentModule));
