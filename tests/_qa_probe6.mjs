// QA 探针：注入目标格式，判断「模块本体」是否正确（与引擎未下发 target 的缺陷分离）
import { analyzeFile, convertFile } from '../src/core/engine.js';
import { encodeText } from '../src/core/encoding.js';
import { loadLib } from '../src/core/lib-loader.js';
import { zipBytes, unzipBytes } from '../src/core/zip.js';
import { defaultTargetFor, findCandidates, formatLabel, targetsFor } from '../src/core/registry.js';

const show = (l, v) => console.log(l, '=>', typeof v === 'string' ? JSON.stringify(v) : v);
const inject = (ext) => ({ target: ext, to: ext, format: ext }); // 三种约定都注入，覆盖各模块的写法
const head = (v, n = 140) => String(v ?? '').slice(0, n);

async function tryConvert(label, file, config) {
  try {
    const res = await convertFile(file, config);
    show(label, `${res.converterId} → ${res.files.map((f) => f.name).join(',')} : ${head(res.files[0].text ?? '(binary)', 120)}`);
    return res;
  } catch (err) {
    show(label, `ERROR ${err.code} ${head(err.message, 160)}`);
    return null;
  }
}

// subtitle: SRT -> VTT（注入 to）
const SRT = '1\n00:00:01,000 --> 00:00:03,500\n你好，世界\n\n2\n00:00:04,000 --> 00:00:06,000\n这是第二行字幕\n';
await tryConvert('subtitle 注入 to=vtt', { name: '字幕.srt', bytes: encodeText(SRT, 'utf-8') },
  { target: 'vtt', options: inject('vtt') });

// chat-export: json -> txt / md
const chat = [{ title: '中文会话', create_time: 1710000000, mapping: {
  a: { id: 'a', message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['你好，请帮我写一段中文测试。'] } }, parent: null, children: ['b'] },
  b: { id: 'b', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['当然可以，这是一段中文回答。'] } }, parent: 'a', children: [] },
} }];
const chatFile = { name: 'conversations.json', bytes: encodeText(JSON.stringify(chat), 'utf-8') };
await tryConvert('chat-export 默认(不注入)', chatFile, { target: 'txt' });
await tryConvert('chat-export 注入 to=txt', chatFile, { target: 'txt', options: inject('txt') });

// data: json -> yaml
await tryConvert('data 注入 target=yaml', chatFile, { target: 'yaml', options: inject('yaml') });

// table: xlsx -> csv（先绕过 detect 缺陷，用强制 analysis）
const XLSX = await loadLib('xlsx');
const ws = XLSX.utils.aoa_to_sheet([['姓名', '城市'], ['张三', '北京']]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, '人员表');
const xlsxBytes = new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
const xlsxAnalysis = await analyzeFile({ name: '人员表.xlsx', bytes: xlsxBytes });
const forcedXlsx = { ...xlsxAnalysis, ext: 'xlsx', family: 'table', label: 'Excel 工作簿 (xlsx)',
  targets: targetsFor('xlsx').map((ext) => ({ ext, label: formatLabel(ext) })), defaultTarget: defaultTargetFor('xlsx'),
  candidates: findCandidates('xlsx', 'csv').map((c) => ({ id: c.id, label: c.label })) };
await tryConvert('table 注入 target=csv', { name: '人员表.xlsx', bytes: xlsxBytes }, { target: 'csv', options: inject('csv'), analysis: forcedXlsx });
show('findCandidates(xlsx,csv)', findCandidates('xlsx', 'csv').map((c) => c.id));

// document: docx -> md
const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await loadLib('docx');
const doc = new Document({ sections: [{ children: [
  new Paragraph({ text: '季度报告标题', heading: HeadingLevel.HEADING_1 }),
  new Paragraph({ children: [new TextRun('这是第一段中文正文，用来验证docx转Markdown。')] }),
] }] });
const docxBytes = new Uint8Array(await Packer.toBuffer(doc));
const docxAnalysis = await analyzeFile({ name: '季度报告.docx', bytes: docxBytes });
const forcedDocx = { ...docxAnalysis, ext: 'docx', family: 'document', label: 'Word 文档 (docx)',
  targets: targetsFor('docx').map((ext) => ({ ext, label: formatLabel(ext) })), defaultTarget: defaultTargetFor('docx'),
  candidates: findCandidates('docx', 'md').map((c) => ({ id: c.id, label: c.label })) };
await tryConvert('document 注入 target=md', { name: '季度报告.docx', bytes: docxBytes }, { target: 'md', options: inject('md'), analysis: forcedDocx });
show('findCandidates(docx,md)', findCandidates('docx', 'md').map((c) => c.id));

// archive: zip list / extract
const zipBytesValue = await zipBytes([
  { name: '中文文件名.txt', bytes: encodeText('压缩包内的中文内容。', 'utf-8') },
  { name: '目录/说明.md', bytes: encodeText('# 说明', 'utf-8') },
]);
await tryConvert('archive list 注入 target=txt', { name: '素材包.zip', bytes: zipBytesValue }, { target: 'txt', options: { ...inject('txt'), action: 'list' } });
const ex = await tryConvert('archive extract 注入 target=zip', { name: '素材包.zip', bytes: zipBytesValue }, { target: 'zip', options: { ...inject('zip'), action: 'extract' } });
if (ex) {
  const out = ex.files[0];
  show('extract 产出', { name: out.name, size: out.bytes.length, first2: Array.from(out.bytes.slice(0, 2)) });
  if (out.bytes[0] === 0x50) show('extract 解开条目', (await unzipBytes(out.bytes)).map((e) => e.name));
}

// image: bmp -> png / jpg（Node）
const bmp = (() => { const w = 7, h = 5, rs = Math.ceil(w * 3 / 4) * 4, px = rs * h; const b = new Uint8Array(54 + px); const v = new DataView(b.buffer);
  b[0] = 0x42; b[1] = 0x4d; v.setUint32(2, b.length, true); v.setUint32(10, 54, true); v.setUint32(14, 40, true); v.setInt32(18, w, true); v.setInt32(22, h, true);
  v.setUint16(26, 1, true); v.setUint16(28, 24, true); v.setUint32(34, px, true);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const o = 54 + (h - 1 - y) * rs + x * 3; b[o] = 128; b[o + 1] = 60; b[o + 2] = 200; } return b; })();
const pngRes = await tryConvert('image 注入 target=png', { name: '色块.bmp', bytes: bmp }, { target: 'png', options: inject('png') });
if (pngRes) show('png 头 32 字节', Array.from(pngRes.files[0].bytes.slice(0, 32)).join(','));
await tryConvert('image 注入 target=jpg（Node）', { name: '色块.bmp', bytes: bmp }, { target: 'jpg', options: inject('jpg') });
