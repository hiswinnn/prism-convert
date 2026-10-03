// QA 临时探针：确认 fixture 生成与识别行为，测试写完后删除
import { analyzeFile } from '../src/core/engine.js';
import { encodeText, decodeBytes, detectEncoding } from '../src/core/encoding.js';
import { zipBytes, unzipBytes } from '../src/core/zip.js';
import { loadLib } from '../src/core/lib-loader.js';

const show = (label, value) => console.log(label, '=>', typeof value === 'string' ? JSON.stringify(value) : value);

const tw = '繁體中文測試：這是一段用來驗證編碼識別的句子。';
const big5 = encodeText(tw, 'big5');
show('big5 bytes', big5.length);
const dBig5 = detectEncoding(big5);
show('big5 detect', { enc: dBig5.encoding, conf: dBig5.confidence, cand: dBig5.candidates.map((c) => `${c.encoding}:${c.score.toFixed(3)}`) });
show('big5 decode back', decodeBytes(big5, 'big5') === tw);

const zh = '你好，世界。这是一段中文测试，用于验证 GBK 编码识别与转换。';
const gbk = encodeText(zh, 'gbk');
show('gbk detect', detectEncoding(gbk).encoding);
show('gbk back', decodeBytes(gbk, 'gbk') === zh);

const u16 = encodeText(zh, 'utf-16le');
show('utf16le bytes[0..4]', Array.from(u16.slice(0, 4)));
show('utf16le detect', detectEncoding(u16).encoding);
show('utf16le back', decodeBytes(u16, 'utf-16le') === zh);
show('utf8bom detect', detectEncoding(encodeText(zh, 'utf-8-bom')).encoding);

const docxLib = await loadLib('docx');
show('docx keys', Object.keys(docxLib).slice(0, 12));
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docxLib;
const doc = new Document({ sections: [{ children: [
  new Paragraph({ text: '季度报告标题', heading: HeadingLevel.HEADING_1 }),
  new Paragraph({ children: [new TextRun('这是第一段中文正文，用来验证 docx 转 Markdown。')] }),
] }] });
const docxBytes = new Uint8Array(await Packer.toBuffer(doc));
show('docx size', docxBytes.length);
const docxA = await analyzeFile({ name: '报告.docx', bytes: docxBytes });
show('docx analyze', { ext: docxA.ext, family: docxA.family, label: docxA.label, conf: docxA.typeConfidence, targets: docxA.targets.map((t) => t.ext).join(',') });

const XLSX = await loadLib('xlsx');
const ws = XLSX.utils.aoa_to_sheet([['姓名', '城市', '备注'], ['张三', '北京', '中文测试'], ['李四', '上海', 'data']]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, '人员表');
const xlsxBytes = new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
show('xlsx size', xlsxBytes.length);
const xlsxA = await analyzeFile({ name: '人员.xlsx', bytes: xlsxBytes });
show('xlsx analyze', { ext: xlsxA.ext, family: xlsxA.family, label: xlsxA.label, targets: xlsxA.targets.map((t) => t.ext).join(',') });

const { PDFDocument, StandardFonts } = await loadLib('pdf-lib');
const pdfDoc = await PDFDocument.create();
const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
const page = pdfDoc.addPage([400, 200]);
page.drawText('PrismConvert Hello World 12345', { x: 30, y: 150, size: 14, font });
const pdfBytes = new Uint8Array(await pdfDoc.save());
const pdfA = await analyzeFile({ name: 'sample.pdf', bytes: pdfBytes });
show('pdf analyze', { ext: pdfA.ext, family: pdfA.family, targets: pdfA.targets.map((t) => t.ext).join(',') });

const zbytes = await zipBytes([
  { name: '中文文件名.txt', bytes: encodeText('压缩包内的中文内容。', 'utf-8') },
  { name: '目录/说明.md', bytes: encodeText('# 说明\n中文内容', 'utf-8') },
]);
show('zip size', zbytes.length);
const back = await unzipBytes(zbytes);
show('zip names', back.map((e) => e.name));
const zipA = await analyzeFile({ name: '包.zip', bytes: zbytes });
show('zip analyze', { ext: zipA.ext, family: zipA.family, label: zipA.label, targets: zipA.targets.map((t) => t.ext).join(',') });

const rnd = Uint8Array.from({ length: 512 }, (_, i) => (i * 97 + 13) % 256);
const rndA = await analyzeFile({ name: 'blob.bin', bytes: rnd });
show('random analyze', { ext: rndA.ext, family: rndA.family, label: rndA.label, isText: rndA.isText });
const emptyA = await analyzeFile({ name: 'empty.txt', bytes: new Uint8Array(0) });
show('empty analyze', { ext: emptyA.ext, family: emptyA.family, label: emptyA.label, isText: emptyA.isText });

const srt = '1\n00:00:01,000 --> 00:00:03,500\n你好，世界\n\n2\n00:00:04,000 --> 00:00:06,000\n这是第二行字幕\n';
const srtA = await analyzeFile({ name: '字幕.srt', bytes: encodeText(srt, 'utf-8') });
show('srt analyze', { ext: srtA.ext, family: srtA.family, label: srtA.label, targets: srtA.targets.map((t) => t.ext).join(',') });

const chat = [{ title: '中文会话', create_time: 1710000000, mapping: {
  n1: { id: 'n1', message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['你好，请帮我写一段中文测试。'] }, create_time: 1710000000 }, parent: null, children: ['n2'] },
  n2: { id: 'n2', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['当然可以，这是一段中文回答。'] }, create_time: 1710000010 }, parent: 'n1', children: [] },
} }];
const chatA = await analyzeFile({ name: 'conversations.json', bytes: encodeText(JSON.stringify(chat), 'utf-8') });
show('chat analyze', { ext: chatA.ext, family: chatA.family, label: chatA.label, conf: chatA.typeConfidence, targets: chatA.targets.map((t) => t.ext).join(',') });
