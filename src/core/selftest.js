/**
 * 浏览器 / Node 双环境自检：现场生成样本 → 走真实引擎（analyzeFile / convertFile）→ 断言输出内容。
 *
 * 三条纪律：
 *  1) 不碰 DOM：界面负责渲染，浏览器专属能力由被测模块自己探测；任何异常都转成 case 状态，绝不抛给调用方。
 *  2) 严格区分「模块文件缺失导致跑不了」（skip + 原因）与「跑了但结果不对」（fail + 期望/实际）。
 *  3) 中文用例断言「期望出现的子串」，不允许只断言长度或「没报错」。
 */
import { analyzeFile, convertFile } from './engine.js';
import { ConversionError } from './errors.js';
import { decodeBytes, encodeText } from './encoding.js';
import { env, loadLib } from './lib-loader.js';
import { unzipBytes, zipBytes } from './zip.js';

/* ------------------------------------------------------------------ *
 * 样本与工具
 * ------------------------------------------------------------------ */

/**
 * 生成 docx 字节。
 * docx 的 Packer.toBuffer() 走 JSZip 的 'nodebuffer'，在浏览器里会抛
 * "nodebuffer is not supported by this platform"——它在 Node 里跑得好好的，
 * 所以只有「在浏览器里跑一次自检」才能发现。toBlob() 两端都可用。
 */
async function packDocx(Packer, doc) {
  if (typeof Packer.toBlob === 'function') {
    const blob = await Packer.toBlob(doc);
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Uint8Array(await Packer.toBuffer(doc));
}

const SAMPLES = {  simplified: '你好，世界。这是一段中文测试，用于验证GBK编码识别与转换。',
  traditional: '繁體中文測試：這是一段用來驗證編碼識別的句子。',
  utf16: 'Hello 你好，UTF-16 测试。',
  chatUser: '你好，请帮我写一段中文测试。',
  chatAssistant: '当然可以，这是一段中文回答。',
  chatTitle: '中文会话',
  csvCell: '张三',
  csvCity: '北京',
  docxTitle: '季度报告标题',
  docxBody: '这是第一段中文正文，用来验证docx转Markdown。',
  srtLine: '你好，世界',
  srtLine2: '这是第二行字幕',
  zipEntry: '中文文件名.txt',
  zipContent: '压缩包内的中文内容。',
  pdfWord: 'PrismConvert',
};

const SRT_FIXTURE = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  SAMPLES.srtLine,
  '',
  '2',
  '00:00:04,000 --> 00:00:06,000',
  SAMPLES.srtLine2,
  '',
].join('\n');

const CSV_FIXTURE = ['姓名,城市,备注', '张三,北京,中文测试', '李四,上海,数据'].join('\n');

const MODULE_FILES = {
  'chat-export': './chat-export.js',
  document: './document.js',
  table: './table.js',
  data: './data.js',
  image: './image.js',
  pdf: './pdf.js',
  archive: './archive.js',
  subtitle: './subtitle.js',
  media: './media.js',
};

/** 用例自身判定失败：与「环境不支持」「模块缺失」区分开 */
class CaseFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'CaseFailure';
  }
}

const fail = (message) => {
  throw new CaseFailure(message);
};
const head = (value, length = 200) => String(value ?? '').slice(0, length);

const be32 = (bytes, offset) =>
  ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;

function strictUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 24 位 BMP：BMP 像素自下而上存储，每行 4 字节对齐 */
function makeBmp(width, height, colorAt) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const out = new Uint8Array(14 + 40 + pixelBytes);
  const view = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(2, out.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelBytes, true);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colorAt(x, y);
      const offset = 54 + (height - 1 - y) * rowSize + x * 3;
      out[offset] = b;
      out[offset + 1] = g;
      out[offset + 2] = r;
    }
  }
  return out;
}

/** ChatGPT 导出形态：会话数组 + mapping 树（含中文与时间） */
function makeChatExport() {
  return [
    {
      title: SAMPLES.chatTitle,
      create_time: 1710000000,
      update_time: 1710000060,
      mapping: {
        node_user: {
          id: 'node_user',
          parent: null,
          children: ['node_ai'],
          message: {
            id: 'm1',
            author: { role: 'user', name: null },
            create_time: 1710000000,
            content: { content_type: 'text', parts: [SAMPLES.chatUser] },
          },
        },
        node_ai: {
          id: 'node_ai',
          parent: 'node_user',
          children: [],
          message: {
            id: 'm2',
            author: { role: 'assistant', name: null },
            create_time: 1710000010,
            content: { content_type: 'text', parts: [SAMPLES.chatAssistant] },
          },
        },
      },
    },
  ];
}

/** 结果里第一个文件的文本正文（引擎对文本类输出会填 file.text） */
const resultText = (result) => String(result?.files?.[0]?.text ?? result?.preview ?? '');

/**
 * 统一校验产出：非空 + 文件名合理 + 逐条断言中文子串。
 * @returns {{name:string, text:string, bytes:Uint8Array}}
 */
function requireText(result, expects, section) {
  const files = result?.files ?? [];
  if (files.length === 0) fail(`${section}：转换没有产出任何文件`);
  const file = files[0];
  if (!file.name || !/\.[a-z0-9]+$/i.test(file.name)) fail(`${section}：产出文件名不合理「${file.name}」`);
  const text = file.text ?? resultText(result);
  if (!text) {
    fail(`${section}：产出文件没有可读文本（${file.name}，${file.bytes?.length ?? file.size ?? '?'} B）`);
  }
  for (const needle of expects) {
    if (!text.includes(needle)) {
      fail(`${section}：输出未包含期望内容「${needle}」；实际前 200 字：${head(text)}`);
    }
  }
  return { name: file.name, text, bytes: file.bytes };
}

function requirePng(bytes, width, height, section) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const actual = Array.from(bytes.slice(0, 8));
  if (actual.join(',') !== signature.join(',')) {
    fail(`${section}：PNG 签名不正确（期望 137,80,78,71,13,10,26,10，实际 ${actual.join(',')}）`);
  }
  if (String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') fail(`${section}：PNG 缺少 IHDR 块`);
  const gotWidth = be32(bytes, 16);
  const gotHeight = be32(bytes, 20);
  if (gotWidth !== width || gotHeight !== height) {
    fail(`${section}：PNG 尺寸应为 ${width}×${height}，实际 ${gotWidth}×${gotHeight}`);
  }
}

function isModuleMissingError(err) {
  // 只有「模块文件真的不存在」才算未就绪；模块存在但内部报错属于真实缺陷
  for (let current = err; current; current = current.cause) {
    if (current.code !== 'ERR_MODULE_NOT_FOUND') continue;
    if (/core[\\/](chat-export|document|table|data|image|pdf|archive|subtitle|media)\.js/.test(`${current.message ?? ''} ${current.url ?? ''}`)) {
      return true;
    }
  }
  return false;
}

/** 浏览器专属实现（canvas / ffmpeg）在 Node 里没有对应内核，不是缺陷，但要说明原因 */
function isEnvUnsupportedError(err) {
  if (env !== 'node') return false;
  const code = err?.code ?? '';
  if (['UNSUPPORTED_FORMAT', 'NOT_APPLICABLE', 'ENV_NOT_SUPPORTED', 'BROWSER_ONLY', 'IMAGE_ENCODER_CANVAS_REQUIRED'].includes(code)) return true;
  return /浏览器|Canvas|canvas|OffscreenCanvas|ffmpeg/i.test(err?.message ?? '');
}

/** 模块文件是否存在：只用于决定 skip 还是 fail，真正的转换仍然走引擎 */
async function moduleReady(id) {
  const path = MODULE_FILES[id];
  if (!path) return { ok: true };
  try {
    await import(/* @vite-ignore */ new URL(path, import.meta.url).href);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `${err?.code ?? err?.name ?? 'Error'}：${head(err?.message ?? err, 160)}` };
  }
}

function withTimeout(promise, ms, id) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CaseFailure(`用例超时（${ms}ms）：${id}`)), ms);
  });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), guard]);
}

/* ------------------------------------------------------------------ *
 * 用例定义
 * ------------------------------------------------------------------ */

/** @returns {Array<{id:string,name:string,converter:string,needs?:string,browserOnly?:boolean,run:Function}>} */
function buildCases() {
  return [
    {
      id: 'encoding-gbk',
      name: '编码识别：GBK 中文 TXT',
      converter: 'data',
      async run() {
        const bytes = encodeText(SAMPLES.simplified, 'gbk');
        const analysis = await analyzeFile({ name: '简体中文.txt', bytes });
        const detected = analysis.encoding?.encoding;
        if (!['gbk', 'gb18030'].includes(detected)) {
          fail(`期望识别为 gbk/gb18030，实际「${detected}」（置信度 ${analysis.encoding?.confidence}）`);
        }
        if (!String(analysis.preview).includes(SAMPLES.simplified)) {
          fail(`预览乱码：期望包含「${SAMPLES.simplified}」，实际前 200 字：${head(analysis.preview)}`);
        }
        if (analysis.garbled) fail('识别正确却被标记为乱码（looksGarbled 误报）');
        return { detail: `识别为 ${detected}（置信度 ${analysis.encoding.confidence.toFixed(2)}），预览中文正确`, sample: head(analysis.preview) };
      },
    },
    {
      id: 'encoding-big5',
      name: '编码识别：Big5 繁体中文 TXT',
      converter: 'data',
      async run() {
        const bytes = encodeText(SAMPLES.traditional, 'big5');
        const analysis = await analyzeFile({ name: '繁體中文.txt', bytes });
        const detected = analysis.encoding?.encoding;
        if (detected !== 'big5') {
          const candidates = (analysis.encoding?.candidates ?? [])
            .map((c) => `${c.encoding}=${c.score.toFixed(3)}`)
            .join('、');
          fail(
            `期望识别为 big5，实际「${detected}」（置信度 ${analysis.encoding?.confidence}）` +
              `；候选：${candidates}；预览：${head(analysis.preview)}`,
          );
        }
        if (!String(analysis.preview).includes(SAMPLES.traditional)) {
          fail(`预览乱码：期望包含「${SAMPLES.traditional}」，实际前 200 字：${head(analysis.preview)}`);
        }
        return { detail: `识别为 ${detected}`, sample: head(analysis.preview) };
      },
    },
    {
      id: 'encoding-utf16le',
      name: '编码识别：UTF-16LE（含 BOM 与无 BOM）',
      converter: 'data',
      async run() {
        const withBom = encodeText(SAMPLES.utf16, 'utf-16le');
        const first = await analyzeFile({ name: 'utf16.txt', bytes: withBom });
        if (first.encoding?.encoding !== 'utf-16le') {
          fail(`带 BOM 期望识别为 utf-16le，实际「${first.encoding?.encoding}」`);
        }
        if (!String(first.preview).includes(SAMPLES.utf16)) {
          fail(`带 BOM 预览乱码：实际前 200 字 ${head(first.preview)}`);
        }
        const noBom = withBom[0] === 0xff && withBom[1] === 0xfe ? withBom.subarray(2) : withBom;
        const second = await analyzeFile({ name: 'utf16-nobom.txt', bytes: noBom });
        if (second.encoding?.encoding !== 'utf-16le') {
          fail(`无 BOM 期望识别为 utf-16le（ASCII 与中文混排），实际「${second.encoding?.encoding}」`);
        }
        return { detail: '带 BOM 与无 BOM 均识别为 utf-16le', sample: head(first.preview, 80) };
      },
    },
    {
      id: 'detect-docx',
      name: '类型识别：DOCX 应识别为 docx（不是 zip）',
      converter: 'document',
      async run() {
        const { Document, Packer, Paragraph, TextRun } = await loadLib('docx');
        const doc = new Document({
          sections: [{ children: [new Paragraph({ children: [new TextRun(SAMPLES.docxBody)] })] }],
        });
        const bytes = await packDocx(Packer, doc);
        const analysis = await analyzeFile({ name: '报告.docx', bytes });
        if (analysis.ext !== 'docx') {
          fail(
            `期望识别为 docx，实际「${analysis.ext}」（${analysis.label}）；` +
              `可转目标：${analysis.targets.map((t) => t.ext).join('、')}`,
          );
        }
        if (!analysis.targets.some((t) => t.ext === 'md')) fail('docx 的可转目标里缺少 md');
        return { detail: `识别为 ${analysis.ext}，可转 ${analysis.targets.map((t) => t.ext).join('/')}`, sample: analysis.label };
      },
    },
    {
      id: 'detect-xlsx',
      name: '类型识别：XLSX 应识别为 xlsx（不是 zip）',
      converter: 'table',
      async run() {
        const XLSX = await loadLib('xlsx');
        const sheet = XLSX.utils.aoa_to_sheet([['姓名', '城市'], [SAMPLES.csvCell, SAMPLES.csvCity]]);
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, '人员表');
        const bytes = new Uint8Array(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
        const analysis = await analyzeFile({ name: '人员表.xlsx', bytes });
        if (analysis.ext !== 'xlsx') {
          fail(
            `期望识别为 xlsx，实际「${analysis.ext}」（${analysis.label}）；` +
              `可转目标：${analysis.targets.map((t) => t.ext).join('、')}`,
          );
        }
        if (!analysis.targets.some((t) => t.ext === 'csv')) fail('xlsx 的可转目标里缺少 csv');
        return { detail: `识别为 ${analysis.ext}，可转 ${analysis.targets.map((t) => t.ext).join('/')}`, sample: analysis.label };
      },
    },
    {
      id: 'json-to-yaml',
      name: '目标格式契约：JSON → YAML 必须真的产出 .yaml',
      converter: 'data',
      needs: 'data',
      async run() {
        const file = { name: 'config.json', bytes: encodeText('{"名称":"棱镜","版本":"1.0"}', 'utf-8') };
        const result = await convertFile(file, { target: 'yaml' });
        const out = result.files?.[0];
        if (!out) fail('JSON → YAML：没有产出任何文件');
        const { text } = requireText(result, ['名称', '棱镜'], 'JSON → YAML');
        // 目标格式没下发到模块时，这里会产出 .txt；文件名会多出 -1（引擎重复登记）
        if (out.name !== 'config.yaml') {
          fail(`请求输出 config.yaml，实际产出「${out.name}」——目标格式或文件名没按契约传递`);
        }
        return { detail: `${result.converterId} → ${out.name}`, sample: head(text, 120) };
      },
    },
    {
      id: 'csv-to-json',
      name: '目标格式契约：CSV → JSON 必须真的产出 .json',
      converter: 'table',
      needs: 'table',
      async run() {
        const file = { name: '人员.csv', bytes: encodeText('姓名,城市\n张三,北京\n', 'utf-8') };
        const result = await convertFile(file, { target: 'json' });
        const out = result.files?.[0];
        if (!out) fail('CSV → JSON：没有产出任何文件');
        const { text } = requireText(result, [SAMPLES.csvCell], 'CSV → JSON');
        if (out.name !== '人员.json') {
          fail(`请求输出 人员.json，实际产出「${out.name}」——目标格式或文件名没按契约传递`);
        }
        return { detail: `${result.converterId} → ${out.name}`, sample: head(text, 120) };
      },
    },
    {
      id: 'chat-json-to-txt',
      name: 'AI 聊天记录 JSON → TXT（中文与角色标记）',
      converter: 'chat-export',
      needs: 'chat-export',
      async run() {
        const file = { name: 'conversations.json', bytes: encodeText(JSON.stringify(makeChatExport()), 'utf-8') };
        const result = await convertFile(file, { target: 'txt' });
        const { name, text } = requireText(result, [SAMPLES.chatUser, SAMPLES.chatAssistant], '聊天记录 → TXT');
        if (!/(我|用户|user)/i.test(text)) fail(`输出缺少用户角色标记；实际前 200 字：${head(text)}`);
        if (!/(AI|助手|assistant)/i.test(text)) fail(`输出缺少助手角色标记；实际前 200 字：${head(text)}`);
        return { detail: `${result.converterId} → ${name}`, sample: head(text) };
      },
    },
    {
      id: 'csv-to-xlsx',
      name: 'CSV → XLSX（中文单元格可回读）',
      converter: 'table',
      needs: 'table',
      async run() {
        const file = { name: '人员表.csv', bytes: encodeText(CSV_FIXTURE, 'utf-8') };
        const result = await convertFile(file, { target: 'xlsx' });
        const out = result.files?.[0];
        if (!out) fail('CSV → XLSX：没有产出任何文件');
        if (!out.name.endsWith('.xlsx')) fail(`产出文件名应为 .xlsx，实际「${out.name}」`);
        if (!(out.bytes[0] === 0x50 && out.bytes[1] === 0x4b)) {
          fail(`产出不是 ZIP 容器（xlsx 应为 PK 开头），前 4 字节：${Array.from(out.bytes.slice(0, 4)).join(',')}`);
        }
        const XLSX = await loadLib('xlsx');
        const reopened = XLSX.read(out.bytes, { type: 'array' });
        const sheet = reopened.Sheets[reopened.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        const flat = rows.flat().map((cell) => String(cell ?? '')).join('|');
        if (!flat.includes(SAMPLES.csvCell) || !flat.includes(SAMPLES.csvCity)) {
          fail(`回读 xlsx 未找到中文单元格；实际内容：${head(flat)}`);
        }
        return { detail: `${result.converterId} → ${out.name}，回读含「${SAMPLES.csvCell}」`, sample: head(flat) };
      },
    },
    {
      id: 'xlsx-to-csv',
      name: 'XLSX → CSV（中文正确 + BOM 选项生效）',
      converter: 'table',
      needs: 'table',
      async run() {
        const XLSX = await loadLib('xlsx');
        const sheet = XLSX.utils.aoa_to_sheet([['姓名', '城市'], [SAMPLES.csvCell, SAMPLES.csvCity]]);
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, '人员表');
        const file = { name: '人员表.xlsx', bytes: new Uint8Array(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })) };

        const analysis = await analyzeFile(file);
        if (analysis.ext !== 'xlsx') {
          fail(`类型识别错误：期望 xlsx，实际「${analysis.ext}」（${analysis.label}）`);
        }

        const withBom = await convertFile(file, { target: 'csv', options: { bom: true } });
        const bomBytes = withBom.files?.[0]?.bytes ?? new Uint8Array(0);
        if (!(bomBytes[0] === 0xef && bomBytes[1] === 0xbb && bomBytes[2] === 0xbf)) {
          fail(`bom:true 时 CSV 应带 UTF-8 BOM，实际前 3 字节：${Array.from(bomBytes.slice(0, 3)).join(',')}`);
        }
        const text = decodeBytes(bomBytes, 'utf-8');
        for (const needle of [SAMPLES.csvCell, SAMPLES.csvCity, '姓名']) {
          if (!text.includes(needle)) fail(`CSV 未包含「${needle}」；实际前 200 字：${head(text)}`);
        }

        const plain = await convertFile(file, { target: 'csv', options: { bom: false } });
        const plainBytes = plain.files?.[0]?.bytes ?? new Uint8Array(0);
        if (plainBytes[0] === 0xef && plainBytes[1] === 0xbb && plainBytes[2] === 0xbf) {
          fail('bom:false 时 CSV 不应带 BOM');
        }
        return { detail: `${withBom.converterId} → ${withBom.files[0].name}，BOM 开关生效`, sample: head(text) };
      },
    },
    {
      id: 'bmp-to-png',
      name: 'BMP → PNG（签名与 IHDR 尺寸）',
      converter: 'image',
      needs: 'image',
      async run() {
        const width = 7;
        const height = 5;
        const file = { name: '色块.bmp', bytes: makeBmp(width, height, (x, y) => [(x * 36) % 256, (y * 51) % 256, 128]) };
        const result = await convertFile(file, { target: 'png' });
        const out = result.files?.[0];
        if (!out) fail('BMP → PNG：没有产出任何文件');
        if (!out.name.endsWith('.png')) fail(`产出文件名应为 .png，实际「${out.name}」`);
        requirePng(out.bytes, width, height, 'BMP → PNG');
        return { detail: `${result.converterId} → ${out.name}（${width}×${height}）`, sample: head(Array.from(out.bytes.slice(0, 16)).join(','), 80) };
      },
    },
    {
      id: 'docx-to-md',
      name: 'DOCX → Markdown（中文标题保留）',
      converter: 'document',
      needs: 'document',
      async run() {
        const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await loadLib('docx');
        const doc = new Document({
          sections: [
            {
              children: [
                new Paragraph({ text: SAMPLES.docxTitle, heading: HeadingLevel.HEADING_1 }),
                new Paragraph({ children: [new TextRun(SAMPLES.docxBody)] }),
              ],
            },
          ],
        });
        const file = { name: '季度报告.docx', bytes: await packDocx(Packer, doc) };
        const analysis = await analyzeFile(file);
        if (analysis.ext !== 'docx') {
          fail(`类型识别错误：期望 docx，实际「${analysis.ext}」（${analysis.label}），无法进入文档模块`);
        }
        const result = await convertFile(file, { target: 'md', analysis });
        const { name, text } = requireText(result, [SAMPLES.docxTitle, SAMPLES.docxBody], 'DOCX → Markdown');
        if (!/^#{1,3}\s/m.test(text)) fail(`Markdown 输出缺少标题标记 #；实际前 200 字：${head(text)}`);
        return { detail: `${result.converterId} → ${name}`, sample: head(text) };
      },
    },
    {
      id: 'pdf-to-txt',
      name: 'PDF → TXT（文字抽取）',
      converter: 'pdf',
      needs: 'pdf',
      async run() {
        const { PDFDocument, StandardFonts } = await loadLib('pdf-lib');
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const page = doc.addPage([420, 200]);
        page.drawText(`${SAMPLES.pdfWord} Hello World 12345`, { x: 30, y: 140, size: 14, font });
        const file = { name: 'sample.pdf', bytes: new Uint8Array(await doc.save()) };
        const result = await convertFile(file, { target: 'txt' });
        const { name, text } = requireText(result, [SAMPLES.pdfWord], 'PDF → TXT');
        if (!/Hello/.test(text) || !/World/.test(text)) {
          fail(`抽取的文字不完整；实际前 200 字：${head(text)}`);
        }
        return { detail: `${result.converterId} → ${name}`, sample: head(text.replace(/\s+/g, ' '), 120) };
      },
    },
    {
      id: 'srt-to-vtt',
      name: 'SRT → WebVTT（时间轴与中文保留）',
      converter: 'subtitle',
      needs: 'subtitle',
      async run() {
        const file = { name: '字幕.srt', bytes: encodeText(SRT_FIXTURE, 'utf-8') };
        const result = await convertFile(file, { target: 'vtt' });
        const { name, text } = requireText(result, [SAMPLES.srtLine, SAMPLES.srtLine2], 'SRT → WebVTT');
        if (!/^\uFEFF?WEBVTT/.test(text)) fail(`VTT 应以 WEBVTT 开头；实际前 200 字：${head(text)}`);
        if (!text.includes('00:00:01.000 --> 00:00:03.500')) {
          fail(`时间轴未按 WebVTT 格式输出（毫秒分隔符应为点）；实际前 200 字：${head(text)}`);
        }
        return { detail: `${result.converterId} → ${name}`, sample: head(text) };
      },
    },
    {
      id: 'zip-list',
      name: 'ZIP 清单（中文文件名）',
      converter: 'archive',
      needs: 'archive',
      async run() {
        const bytes = await zipBytes([
          { name: SAMPLES.zipEntry, bytes: encodeText(SAMPLES.zipContent, 'utf-8') },
          { name: '目录/说明.md', bytes: encodeText('# 说明\n中文内容', 'utf-8') },
        ]);
        const result = await convertFile({ name: '素材包.zip', bytes }, { target: 'txt', options: { action: 'list' } });
        const { name, text } = requireText(result, [SAMPLES.zipEntry], 'ZIP 清单');
        return { detail: `${result.converterId} → ${name}`, sample: head(text.replace(/\s+/g, ' '), 160) };
      },
    },
    {
      id: 'zip-extract',
      name: 'ZIP 解压（中文文件名与内容）',
      converter: 'archive',
      needs: 'archive',
      async run() {
        const bytes = await zipBytes([{ name: SAMPLES.zipEntry, bytes: encodeText(SAMPLES.zipContent, 'utf-8') }]);
        const result = await convertFile({ name: '素材包.zip', bytes }, { target: 'zip', options: { action: 'extract' } });
        const files = result.files ?? [];
        if (files.length === 0) fail('ZIP 解压：没有产出任何文件');
        // 解压结果可能是「一个 zip」或「多个散文件」，两种都要能验证到内容
        const entries = files.length === 1 && files[0].name.endsWith('.zip')
          ? await unzipBytes(files[0].bytes)
          : files.map((file) => ({ name: file.name, bytes: file.bytes, text: file.text }));
        // 名字被追加 -1 是引擎的登记缺陷（另有专门用例），这里先按原名校验内容，再单独报文件名问题
        const stripSuffix = (name) => String(name).replace(/-\d+(?=\.[a-z0-9]+$)/i, '');
        const hit = entries.find((entry) => String(entry.name) === SAMPLES.zipEntry)
          ?? entries.find((entry) => stripSuffix(String(entry.name)) === SAMPLES.zipEntry);
        if (!hit) fail(`解压结果里找不到「${SAMPLES.zipEntry}」；实际条目：${entries.map((e) => e.name).join('、')}`);
        const content = hit.bytes ? decodeBytes(hit.bytes, 'utf-8') : String(hit.text ?? '');
        if (!content.includes(SAMPLES.zipContent)) {
          fail(`解压出的内容不对：期望包含「${SAMPLES.zipContent}」，实际「${head(content, 80)}」`);
        }
        if (String(hit.name) !== SAMPLES.zipEntry) {
          fail(`解压出的文件名不对：期望「${SAMPLES.zipEntry}」，实际「${hit.name}」（引擎把已登记的文件名又消毒了一次，追加了多余的 -1）`);
        }
        return { detail: `${result.converterId} → ${entries.map((e) => e.name).join('、')}`, sample: head(content, 80) };
      },
    },
    {
      id: 'txt-to-utf8',
      name: 'GBK 文本 → UTF-8 文本（中文不乱码）',
      converter: 'document',
      needs: 'document',
      async run() {
        const file = { name: '简体中文.txt', bytes: encodeText(SAMPLES.simplified, 'gbk') };
        const result = await convertFile(file, { target: 'txt', options: { encoding: 'utf-8' } });
        const out = result.files?.[0];
        if (!out) fail('GBK → UTF-8：没有产出任何文件');
        if (result.converterId !== 'document') {
          fail(
            `txt→txt 被「${result.converterId}」模块接走了（应为 document）：registry.findCandidates 把 from/to 独立求交，` +
              '导致 from/to 都含 txt 的模块抢先命中',
          );
        }
        const decoded = strictUtf8(out.bytes);
        if (decoded === null) fail('产出不是合法 UTF-8 字节流');
        if (!decoded.includes(SAMPLES.simplified)) {
          fail(`按 UTF-8 解回的内容与原文不一致：期望包含「${SAMPLES.simplified}」，实际前 200 字：${head(decoded)}`);
        }
        return { detail: `${result.converterId} → ${out.name}`, sample: head(decoded) };
      },
    },
    {
      id: 'bad-data-error',
      name: '错误路径：随机二进制必须给出有意义的 ConversionError',
      converter: 'document',
      async run() {
        const bytes = Uint8Array.from({ length: 512 }, (_, i) => (i * 97 + 13) % 256);
        try {
          const result = await convertFile({ name: 'blob.bin', bytes }, { target: 'txt' });
          fail(`随机二进制本应报错，却产出了 ${result.files?.length ?? 0} 个文件`);
        } catch (err) {
          if (!(err instanceof ConversionError)) {
            fail(`期望 ConversionError，实际 ${err?.name ?? '未知异常'}：${head(err?.message, 120)}`);
          }
          if (!/^[A-Z][A-Z0-9_]{3,}$/.test(String(err.code))) fail(`错误码不可读：${err.code}`);
          if (err.code === 'CONVERT_FAILED') fail(`落到了「未预期异常」兜底分支（说明模块内部崩了）：${err.message}`);
          if (!/[\u4e00-\u9fff]/.test(err.message)) fail(`错误消息应为中文：${err.message}`);
          return { detail: `${err.code}：${err.message}`, sample: head(err.message, 120) };
        }
      },
    },
    {
      id: 'empty-file-error',
      name: '错误路径：空文件必须给出明确错误而不是崩溃',
      converter: 'document',
      async run() {
        try {
          const result = await convertFile({ name: 'empty.txt', bytes: new Uint8Array(0) }, { target: 'txt' });
          fail(`空文件本应报错，却产出了 ${result.files?.length ?? 0} 个文件`);
        } catch (err) {
          if (!(err instanceof ConversionError)) {
            fail(`期望 ConversionError，实际 ${err?.name ?? '未知异常'}：${head(err?.message, 120)}`);
          }
          if (!/[\u4e00-\u9fff]/.test(err.message)) fail(`错误消息应为中文：${err.message}`);
          if (!/空|不支持|无法识别|没有/.test(err.message)) {
            fail(`错误消息没说明「文件为空」这件事：${err.message}`);
          }
          return { detail: `${err.code}：${err.message}`, sample: head(err.message, 120) };
        }
      },
    },
    {
      id: 'browser-canvas-image',
      name: '浏览器专属：BMP → JPEG（需 Canvas 编码内核）',
      converter: 'image',
      needs: 'image',
      browserOnly: true,
      async run() {
        const file = { name: '色块.bmp', bytes: makeBmp(9, 6, (x, y) => [(x * 28) % 256, (y * 42) % 256, 200]) };
        const result = await convertFile(file, { target: 'jpg' });
        const out = result.files?.[0];
        if (!out) fail('BMP → JPEG：没有产出任何文件');
        if (!(out.bytes[0] === 0xff && out.bytes[1] === 0xd8 && out.bytes[2] === 0xff)) {
          fail(`JPEG 头不正确（应为 FF D8 FF），实际 ${Array.from(out.bytes.slice(0, 3)).join(',')}`);
        }
        if (!out.name.endsWith('.jpg') && !out.name.endsWith('.jpeg')) fail(`产出文件名应为 .jpg，实际「${out.name}」`);
        return { detail: `${result.converterId} → ${out.name}（canvas 编码）`, sample: head(Array.from(out.bytes.slice(0, 12)).join(','), 60) };
      },
    },
    {
      id: 'browser-ffmpeg-available',
      name: '浏览器专属：音视频 ffmpeg 是否可用',
      converter: 'media',
      browserOnly: true,
      async run() {
        // 只探测 JS 入口能否加载，不拉 wasm 主程序（那有几十 MB，自检不该下载它）
        const mod = await loadLib('@ffmpeg/ffmpeg');
        const FFmpegClass = mod?.FFmpeg ?? mod?.default?.FFmpeg;
        if (typeof FFmpegClass !== 'function') {
          fail(`@ffmpeg/ffmpeg 已加载但找不到 FFmpeg 类，导出键：${Object.keys(mod ?? {}).join('、')}`);
        }
        return {
          detail: 'ffmpeg 模块可加载（仅探测入口，未做真实转码）',
          sample: `FFmpeg: ${typeof FFmpegClass}, 导出键: ${Object.keys(mod).slice(0, 6).join('、')}`,
        };
      },
    },
  ];
}

/* ------------------------------------------------------------------ *
 * 驱动
 * ------------------------------------------------------------------ */

function normalizeOnly(only) {
  if (!only) return null;
  const list = Array.isArray(only) ? only : String(only).split(/[\s,]+/);
  const set = new Set(list.map((item) => String(item).trim()).filter(Boolean));
  return set.size ? set : null;
}

/**
 * 跑一遍自检。
 * @param {{onProgress?: Function, only?: string|string[], timeoutMs?: number}} [options]
 *   onProgress 同时兼容两种形状：{case} 表示某用例已完成，{message} 表示当前阶段（传字符串也接受）
 * @returns {Promise<{passed:number, failed:number, skipped:number, total:number, env:string, durationMs:number, cases:Array}>}
 */
export async function runSelfTest({ onProgress, only, timeoutMs = 45000 } = {}) {
  const startedAt = Date.now();
  const selected = normalizeOnly(only);
  const specs = buildCases();
  const cases = [];

  const emit = (payload) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress(payload);
    } catch {
      // 进度回调是界面的责任，它出错不能拖垮自检
    }
  };

  const finish = (spec, status, detail, durationMs, sample) => {
    const entry = {
      id: spec.id,
      name: spec.name,
      converter: spec.converter,
      status,
      detail,
      durationMs: Math.max(0, Math.round(durationMs)),
      ...(sample ? { sample: head(sample, 200) } : {}),
    };
    cases.push(entry);
    emit({ case: entry });
    return entry;
  };

  for (const spec of specs) {
    const caseStartedAt = Date.now();
    emit({ message: `自检进行中：${spec.name}` });

    if (spec.browserOnly && env === 'node') {
      finish(spec, 'skip', '浏览器专属路径：Node 环境没有 Canvas / WebCodecs 内核，无法验证', Date.now() - caseStartedAt);
      continue;
    }
    if (selected && !selected.has(spec.id)) {
      finish(spec, 'skip', '未在 only 列表中选中', Date.now() - caseStartedAt);
      continue;
    }
    if (spec.needs) {
      const ready = await moduleReady(spec.needs);
      if (!ready.ok) {
        finish(spec, 'skip', `转换模块 ${spec.needs}.js 未就绪：${ready.reason}`, Date.now() - caseStartedAt);
        continue;
      }
    }

    try {
      const outcome = (await withTimeout(spec.run(), timeoutMs, spec.id)) ?? {};
      finish(spec, 'pass', outcome.detail ?? '通过', Date.now() - caseStartedAt, outcome.sample);
    } catch (err) {
      const durationMs = Date.now() - caseStartedAt;
      if (err instanceof CaseFailure) {
        finish(spec, 'fail', err.message, durationMs);
      } else if (isModuleMissingError(err) || isEnvUnsupportedError(err)) {
        finish(spec, 'skip', `无法在当前环境验证：${err?.code ?? ''} ${head(err?.message ?? err, 160)}`, durationMs);
      } else {
        const code = err?.code ?? err?.name ?? 'UNKNOWN';
        finish(spec, 'fail', `${code}｜${head(err?.message ?? err, 200)}`, durationMs);
      }
    }
  }

  const count = (status) => cases.filter((item) => item.status === status).length;
  const summary = {
    passed: count('pass'),
    failed: count('fail'),
    skipped: count('skip'),
    total: cases.length,
    env,
    durationMs: Date.now() - startedAt,
    cases,
  };
  emit({ message: `自检结束：通过 ${summary.passed} / 失败 ${summary.failed} / 跳过 ${summary.skipped}` });
  return summary;
}

/** 供界面渲染「自检」页时展示用例清单（不执行） */
export function listSelfTestCases() {
  return buildCases().map((spec) => ({
    id: spec.id,
    name: spec.name,
    converter: spec.converter,
    browserOnly: Boolean(spec.browserOnly),
    needs: spec.needs ?? null,
  }));
}
