/**
 * 端到端转换验证（Node 端真实转换，不使用任何外部素材，fixture 全部现场生成）。
 *
 * 断言原则：中文场景一律断言「期望出现的中文子串」与编码正确性，不允许只断言「没报错」。
 * 若某个转换模块文件缺失导致失败，失败信息里会带 [模块未就绪] 前缀，便于与真实缺陷区分。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFile, bundleResults, convertFile } from '../src/core/engine.js';
import { ConversionError } from '../src/core/errors.js';
import { decodeBytes, encodeText } from '../src/core/encoding.js';
import { loadLib } from '../src/core/lib-loader.js';
import { defaultTargetFor, formatLabel, targetsFor } from '../src/core/registry.js';
import { extOf } from '../src/core/util.js';
import { unzipBytes, zipBytes } from '../src/core/zip.js';

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

const head = (value, length = 200) => String(value ?? '').slice(0, length);
const be32 = (bytes, offset) =>
  ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;

/** 转换模块文件缺失时，引擎会包装成 CONVERT_FAILED，真实原因藏在 cause 链里 */
const PENDING_MODULE = /core[\\/](chat-export|document|table|data|image|pdf|archive|subtitle|media)\.js/;

function modulePending(err) {
  for (let current = err; current; current = current.cause) {
    // 必须真的是「模块文件找不到」；模块存在但内部报错属于真实缺陷，不能算未就绪
    if (current.code !== 'ERR_MODULE_NOT_FOUND') continue;
    const text = `${current.message ?? ''} ${current.url ?? ''}`;
    if (PENDING_MODULE.test(text)) return true;
  }
  return false;
}

/** 浏览器专属实现（canvas / ffmpeg）在 Node 里跑不了：这不是缺陷，跳过但要让原因可见 */
function envUnsupported(err) {
  const code = err?.code ?? '';
  if (['UNSUPPORTED_FORMAT', 'NOT_APPLICABLE', 'ENV_NOT_SUPPORTED', 'BROWSER_ONLY'].includes(code)) return true;
  return /浏览器|canvas|Canvas|OffscreenCanvas|document is not defined/.test(err?.message ?? '');
}

function failWith(section, err, extra = {}) {
  const lines = [`【${section}】`];
  if (modulePending(err)) {
    lines.push(`[模块未就绪] 转换模块文件缺失：${err?.code ?? ''} ${err?.message ?? err}`);
  } else if (err instanceof ConversionError) {
    lines.push(`[转换失败] code=${err.code} 消息=${err.message}`);
  } else {
    lines.push(`[未预期异常] ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
  }
  if (extra.output) lines.push(`输出前 200 字：${head(extra.output)}`);
  if (extra.hint) lines.push(extra.hint);
  return lines.join('\n');
}

/**
 * 统一的转换入口：环境限制 → 跳过；其它失败 → 断言失败并打印可定位信息。
 * @returns {Promise<object|null>} null 表示用例已标记跳过，调用方应立即 return
 */
async function runConvert(t, section, file, config = {}, hint) {
  try {
    return await convertFile(file, config);
  } catch (err) {
    if (envUnsupported(err)) {
      t.skip(`${section}：当前环境不支持该路径（${err?.code ?? ''} ${err?.message ?? err}）`);
      return null;
    }
    assert.fail(failWith(section, err, { hint }));
  }
}

const textOfResult = (result) =>
  String(result?.files?.[0]?.text ?? result?.preview ?? '');

function expectContains(text, needles, section) {
  for (const needle of needles) {
    assert.ok(
      text.includes(needle),
      `${section}：输出未包含期望内容「${needle}」\n输出前 200 字：${head(text)}`,
    );
  }
}

function strictUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * fixture 生成
 * ------------------------------------------------------------------ */

/**
 * 手工构造一份「正确」的识别结果，绕过 detect.js 把 docx/xlsx 认成 zip 的缺陷，
 * 用来单独判断下游模块（document / table）本体是否可用。
 */
async function forceAnalysis(file, ext) {
  const analysis = await analyzeFile(file);
  return {
    ...analysis,
    ext,
    family: ext === 'docx' ? 'document' : 'table',
    label: formatLabel(ext),
    targets: targetsFor(ext).map((target) => ({ ext: target, label: formatLabel(target) })),
    defaultTarget: defaultTargetFor(ext),
    candidates: [],
  };
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
      title: '中文会话',
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
            content: { content_type: 'text', parts: ['你好，请帮我写一段中文测试。'] },
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
            content: { content_type: 'text', parts: ['当然可以，这是一段中文回答。'] },
          },
        },
      },
    },
  ];
}

const SRT_FIXTURE = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  '你好，世界',
  '',
  '2',
  '00:00:04,000 --> 00:00:06,000',
  '这是第二行字幕',
  '',
].join('\n');

const SAMPLES = {
  simplified: '你好，世界。这是一段中文测试，用于验证GBK编码识别与转换。',
  traditional: '繁體中文測試：這是一段用來驗證編碼識別的句子。',
  chatUser: '你好，请帮我写一段中文测试。',
  chatAssistant: '当然可以，这是一段中文回答。',
  docxTitle: '季度报告标题',
  docxBody: '这是第一段中文正文，用来验证docx转Markdown。',
  csvCell: '张三',
  zipEntry: '中文文件名.txt',
  zipContent: '压缩包内的中文内容。',
};

const CONVERTER_MODULES = {
  'chat-export': '../src/core/chat-export.js',
  document: '../src/core/document.js',
  table: '../src/core/table.js',
  data: '../src/core/data.js',
  image: '../src/core/image.js',
  pdf: '../src/core/pdf.js',
  archive: '../src/core/archive.js',
  subtitle: '../src/core/subtitle.js',
  media: '../src/core/media.js',
};

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

test('1. JSON 聊天记录 → TXT：识别为 json，输出含中文与角色标记', async (t) => {
  const bytes = encodeText(JSON.stringify(makeChatExport()), 'utf-8');
  const file = { name: 'conversations.json', bytes };

  const analysis = await analyzeFile(file);
  assert.equal(analysis.ext, 'json', `类型识别错误：期望 json，实际 ${analysis.ext}（${analysis.label}）`);
  assert.ok(analysis.typeConfidence >= 0.9, `json 置信度偏低：${analysis.typeConfidence}`);
  const targetExts = analysis.targets.map((item) => item.ext);
  assert.ok(targetExts.includes('txt'), `可转目标缺少 txt，实际：${targetExts.join('、')}`);
  assert.ok(analysis.preview.includes('中文会话'), `预览未出现中文会话标题\n预览前 200 字：${head(analysis.preview)}`);

  const result = await runConvert(t, 'JSON 聊天记录 → TXT', file, { target: 'txt' });
  if (!result) return;
  const text = textOfResult(result);
  expectContains(text, [SAMPLES.chatUser, SAMPLES.chatAssistant], 'JSON 聊天记录 → TXT');
  assert.match(text, /(我|用户|user)/i, `输出缺少用户角色标记\n输出前 200 字：${head(text)}`);
  assert.match(text, /(AI|助手|assistant)/i, `输出缺少助手角色标记\n输出前 200 字：${head(text)}`);
  assert.ok(
    result.files[0].name.endsWith('.txt') && result.files[0].name.length > 4,
    `文件名不合理：${result.files[0].name}`,
  );
  t.diagnostic(`${result.converterId} → ${result.files[0].name}（${result.files[0].size} B）`);
});

test('2. GBK 中文 TXT → UTF-8 TXT：识别为 gbk/gb18030，预览与输出均不乱码', async (t) => {
  const bytes = encodeText(SAMPLES.simplified, 'gbk');
  const file = { name: '简体中文.txt', bytes };

  const analysis = await analyzeFile(file);
  assert.ok(
    ['gbk', 'gb18030'].includes(analysis.encoding?.encoding),
    `编码识别错误：期望 gbk/gb18030，实际 ${analysis.encoding?.encoding}（置信度 ${analysis.encoding?.confidence}）`,
  );
  assert.ok(
    analysis.preview?.includes(SAMPLES.simplified),
    `预览出现乱码：未包含「${SAMPLES.simplified}」\n预览前 200 字：${head(analysis.preview)}`,
  );
  assert.equal(analysis.garbled, false, '正确解码的 GBK 文本不该被标记为乱码');
  assert.ok(analysis.stats.cjk > 10, `中文统计异常：cjk=${analysis.stats?.cjk}`);

  // 第一步：强制 document 模块，先确认「编码转换本身」是否正确（converterId 是引擎支持的入参）
  const forced = await runConvert(
    t,
    'GBK → UTF-8 TXT（强制 converterId=document）',
    file,
    { target: 'txt', options: { encoding: 'utf-8' }, converterId: 'document' },
  );
  if (forced) {
    const forcedText = strictUtf8(forced.files[0].bytes);
    assert.ok(forcedText !== null, '输出不是合法 UTF-8 字节流');
    assert.ok(
      forcedText.includes(SAMPLES.simplified),
      `UTF-8 解出的内容与原文不一致\n实际前 200 字：${head(forcedText)}`,
    );
    t.diagnostic(`强制 document 通过：${forced.files[0].name}（${forced.files[0].bytes.length} B）`);
  }

  // 第二步：默认路径必须落在 document —— 不能被优先级更高的模块抢走
  const result = await runConvert(t, 'GBK → UTF-8 TXT（默认路径）', file, {
    target: 'txt',
    options: { encoding: 'utf-8' },
  });
  if (!result) return;
  assert.equal(
    result.converterId,
    'document',
    `txt→txt 应由 document 完成，实际用了「${result.converterId}」。` +
      '根因在 src/core/registry.js 的 findCandidates：它把 from/to 独立求交，' +
      'PDF 模块 from/to 都含 txt，于是 txt→txt 命中了 PDF，且它抛的是硬错误，级联不会退到 document',
  );
  const outBytes = result.files[0].bytes;
  const decoded = strictUtf8(outBytes);
  assert.ok(decoded !== null, '输出不是合法 UTF-8 字节流');
  assert.ok(
    decoded.includes(SAMPLES.simplified),
    `UTF-8 解出的内容与原文不一致\n实际前 200 字：${head(decoded)}`,
  );

  // 把编码当格式传（常见误用）必须给出中文可读错误，而不是崩溃
  let misuse = null;
  try {
    await convertFile(file, { target: 'utf-8' });
  } catch (err) {
    misuse = err;
  }
  assert.ok(misuse instanceof ConversionError, 'target 传编码名时应抛 ConversionError');
  assert.match(misuse.message, /[\u4e00-\u9fff]/, `错误消息应为中文：${misuse.message}`);
  t.diagnostic(`${result.converterId} → ${result.files[0].name}；误传 target='utf-8' 得到 ${misuse.code}`);
});

test('3. Big5 中文 TXT：必须识别为 big5 且预览不乱码', async (t) => {
  const bytes = encodeText(SAMPLES.traditional, 'big5');
  const file = { name: '繁體中文.txt', bytes };

  const analysis = await analyzeFile(file);
  assert.equal(
    analysis.encoding?.encoding,
    'big5',
    `编码识别错误：期望 big5，实际 ${analysis.encoding?.encoding}（置信度 ${analysis.encoding?.confidence}）` +
      `\n候选：${(analysis.encoding?.candidates ?? []).map((c) => `${c.encoding}=${c.score.toFixed(3)}`).join('、')}` +
      `\n预览前 200 字：${head(analysis.preview)}`,
  );
  assert.ok(
    analysis.preview?.includes(SAMPLES.traditional),
    `Big5 预览乱码：未包含「${SAMPLES.traditional}」\n预览前 200 字：${head(analysis.preview)}`,
  );
  assert.equal(analysis.garbled, false, '正确解码的 Big5 文本不该被标记为乱码');
  t.diagnostic(`识别为 ${analysis.encoding.encoding}`);
});

test('4. DOCX（中文标题）→ MD：识别为 docx，输出含中文标题', async (t) => {
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
  const file = { name: '季度报告.docx', bytes: new Uint8Array(await Packer.toBuffer(doc)) };

  const analysis = await analyzeFile(file);
  assert.equal(
    analysis.ext,
    'docx',
    `类型识别错误：期望 docx，实际 ${analysis.ext}（${analysis.label}）。` +
      '根因在 src/core/detect.js：MAGIC 表里的 zip 魔数先于 inspectZip() 命中，docx/xlsx/epub 分支永远走不到',
  );

  const result = await runConvert(t, 'DOCX → MD', file, { target: 'md' });
  if (!result) return;
  const text = textOfResult(result);
  expectContains(text, [SAMPLES.docxTitle, SAMPLES.docxBody], 'DOCX → MD');
  assert.match(text, /^#{1,3}\s/m, `Markdown 输出缺少标题标记 #\n输出前 200 字：${head(text)}`);
  assert.ok(result.files[0].name.endsWith('.md'), `文件名不合理：${result.files[0].name}`);
  t.diagnostic(`${result.converterId} → ${result.files[0].name}`);
});

test('5. XLSX（中文单元格）→ CSV：识别为 xlsx，中文正确且 BOM 选项生效', async (t) => {
  const XLSX = await loadLib('xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([
    ['姓名', '城市', '备注'],
    ['张三', '北京', '中文测试'],
    ['李四', '上海', '数据'],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '人员表');
  const file = { name: '人员表.xlsx', bytes: new Uint8Array(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })) };

  const analysis = await analyzeFile(file);
  assert.equal(
    analysis.ext,
    'xlsx',
    `类型识别错误：期望 xlsx，实际 ${analysis.ext}（${analysis.label}）。` +
      '根因在 src/core/detect.js：MAGIC 表里的 zip 魔数先于 inspectZip() 命中，docx/xlsx/epub 分支永远走不到',
  );

  const withBom = await runConvert(t, 'XLSX → CSV（bom）', file, { target: 'csv', options: { bom: true } });
  if (!withBom) return;
  const bomBytes = withBom.files[0].bytes;
  assert.ok(
    bomBytes[0] === 0xef && bomBytes[1] === 0xbb && bomBytes[2] === 0xbf,
    `bom:true 时 CSV 应带 UTF-8 BOM，实际前 3 字节：${Array.from(bomBytes.slice(0, 3))}`,
  );
  const csvText = decodeBytes(bomBytes, 'utf-8');
  expectContains(csvText, [SAMPLES.csvCell, '姓名', '北京', '上海'], 'XLSX → CSV');

  const plain = await runConvert(t, 'XLSX → CSV（无 bom）', file, { target: 'csv', options: { bom: false } });
  if (!plain) return;
  const plainBytes = plain.files[0].bytes;
  assert.ok(
    !(plainBytes[0] === 0xef && plainBytes[1] === 0xbb && plainBytes[2] === 0xbf),
    'bom:false 时 CSV 不应带 BOM',
  );
  expectContains(decodeBytes(plainBytes, 'utf-8'), [SAMPLES.csvCell], 'XLSX → CSV（无 bom）');
  t.diagnostic(`${withBom.converterId} → ${withBom.files[0].name}；BOM 开关生效`);
});

test('6. BMP 像素 → PNG：PNG 签名与 IHDR 宽高正确', async (t) => {
  const width = 7;
  const height = 5;
  const file = {
    name: '色块.bmp',
    bytes: makeBmp(width, height, (x, y) => [(x * 36) % 256, (y * 51) % 256, 128]),
  };

  const analysis = await analyzeFile(file);
  assert.equal(analysis.ext, 'bmp', `类型识别错误：期望 bmp，实际 ${analysis.ext}`);
  assert.ok(analysis.targets.some((item) => item.ext === 'png'), 'BMP 的可转目标里没有 png');

  const result = await runConvert(t, 'BMP → PNG', file, { target: 'png' });
  if (!result) return;
  const bytes = result.files[0].bytes;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assert.deepEqual(
    Array.from(bytes.slice(0, 8)),
    signature,
    `PNG 签名不正确：${Array.from(bytes.slice(0, 8))}`,
  );
  assert.equal(String.fromCharCode(...bytes.slice(12, 16)), 'IHDR', 'PNG 缺少 IHDR 块');
  assert.equal(be32(bytes, 16), width, `PNG 宽度应为 ${width}，实际 ${be32(bytes, 16)}`);
  assert.equal(be32(bytes, 20), height, `PNG 高度应为 ${height}，实际 ${be32(bytes, 20)}`);
  assert.ok(result.files[0].name.endsWith('.png'), `文件名不合理：${result.files[0].name}`);
  t.diagnostic(`${result.converterId} → ${result.files[0].name}（${width}×${height}）`);
});

test('7. PDF（英文文字）→ TXT：抽取的文字包含预期单词', async (t) => {
  const { PDFDocument, StandardFonts } = await loadLib('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([420, 200]);
  page.drawText('PrismConvert Hello World 12345', { x: 30, y: 140, size: 14, font });
  const file = { name: 'sample.pdf', bytes: new Uint8Array(await doc.save()) };

  const analysis = await analyzeFile(file);
  assert.equal(analysis.ext, 'pdf', `类型识别错误：期望 pdf，实际 ${analysis.ext}`);
  assert.ok(analysis.targets.some((item) => item.ext === 'txt'), 'PDF 的可转目标里没有 txt');

  const result = await runConvert(t, 'PDF → TXT', file, { target: 'txt' });
  if (!result) return;
  const text = textOfResult(result);
  expectContains(text, ['PrismConvert', 'Hello', 'World', '12345'], 'PDF → TXT');
  t.diagnostic(`${result.converterId} → ${result.files[0].name}：${head(text.replace(/\s+/g, ' '), 80)}`);
});

test('8. ZIP（中文文件名）→ archive list：清单含中文文件名', async (t) => {
  const zipBytesValue = await zipBytes([
    { name: SAMPLES.zipEntry, bytes: encodeText(SAMPLES.zipContent, 'utf-8') },
    { name: '目录/说明.md', bytes: encodeText('# 说明\n中文内容', 'utf-8') },
  ]);
  const file = { name: '素材包.zip', bytes: zipBytesValue };

  const analysis = await analyzeFile(file);
  assert.equal(analysis.ext, 'zip', `类型识别错误：期望 zip，实际 ${analysis.ext}`);

  const result = await runConvert(t, 'ZIP 清单', file, { target: 'txt', options: { action: 'list' } });
  if (!result) return;
  const text = textOfResult(result);
  expectContains(text, [SAMPLES.zipEntry], 'ZIP 清单');
  t.diagnostic(`${result.converterId} → ${result.files[0].name}：${head(text.replace(/\s+/g, ' '), 120)}`);
});

test('9. SRT（中文）→ VTT：时间轴与中文均保留', async (t) => {
  const file = { name: '字幕.srt', bytes: encodeText(SRT_FIXTURE, 'utf-8') };

  const analysis = await analyzeFile(file);
  assert.equal(analysis.ext, 'srt', `类型识别错误：期望 srt，实际 ${analysis.ext}（${analysis.label}）`);

  const result = await runConvert(t, 'SRT → VTT', file, { target: 'vtt' });
  if (!result) return;
  const text = textOfResult(result);
  assert.match(text, /^WEBVTT/, `VTT 应以 WEBVTT 开头\n输出前 200 字：${head(text)}`);
  assert.ok(
    text.includes('00:00:01.000 --> 00:00:03.500'),
    `时间轴未按 VTT 格式输出（逗号应改为点）\n输出前 200 字：${head(text)}`,
  );
  expectContains(text, ['你好，世界', '这是第二行字幕'], 'SRT → VTT');
  assert.ok(result.files[0].name.endsWith('.vtt'), `文件名不合理：${result.files[0].name}`);
  t.diagnostic(`${result.converterId} → ${result.files[0].name}`);
});

test('10. 错误路径：随机二进制与空文件必须抛有意义的 ConversionError', async (t) => {
  const cases = [
    { label: '随机二进制', name: 'blob.bin', bytes: Uint8Array.from({ length: 512 }, (_, i) => (i * 97 + 13) % 256) },
    { label: '空文件', name: 'empty.txt', bytes: new Uint8Array(0) },
  ];

  for (const item of cases) {
    const file = { name: item.name, bytes: item.bytes };
    await analyzeFile(file).catch((err) => {
      assert.fail(`【${item.label}】analyzeFile 不该抛异常：${err?.message ?? err}`);
    });

    let thrown = null;
    try {
      await convertFile(file, { target: 'txt' });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ConversionError, `【${item.label}】应抛 ConversionError，实际：${thrown?.name ?? '没有抛错'}`);
    assert.match(
      String(thrown.code),
      /^[A-Z][A-Z0-9_]{3,}$/,
      `【${item.label}】错误码不可读：${thrown.code}`,
    );
    assert.notEqual(
      thrown.code,
      'CONVERT_FAILED',
      `【${item.label}】落到了「未预期异常」兜底分支，说明模块内部抛的是程序缺陷：${thrown.message}`,
    );
    assert.match(thrown.message, /[\u4e00-\u9fff]/, `【${item.label}】错误消息应为中文：${thrown.message}`);
    t.diagnostic(`${item.label} → ${thrown.code}：${head(thrown.message, 80)}`);
  }
});

test('11. 中文 TXT → GBK 输出：字节非 UTF-8，按 GBK 解回一致', async (t) => {
  const file = { name: '中文源码.txt', bytes: encodeText(SAMPLES.simplified, 'utf-8') };

  // 先强制 document，单独确认 GBK 编码输出是否正确
  const forced = await runConvert(
    t,
    '中文 TXT → GBK（强制 converterId=document）',
    file,
    { target: 'txt', options: { encoding: 'gbk' }, converterId: 'document' },
  );
  if (forced) {
    const bytes = forced.files[0].bytes;
    assert.ok(
      decodeBytes(bytes, 'gbk').includes(SAMPLES.simplified),
      `按 GBK 解回的内容与原文不一致\n实际前 200 字：${head(decodeBytes(bytes, 'gbk'))}`,
    );
    assert.equal(
      strictUtf8(bytes),
      null,
      'GBK 输出不应是合法 UTF-8 字节流（若能按 UTF-8 解出，说明模块没按 GBK 编码）',
    );
    t.diagnostic(`强制 document 通过：${forced.files[0].name}（${bytes.length} B，非 UTF-8）`);
  }

  const result = await runConvert(t, '中文 TXT → GBK（默认路径）', file, { target: 'txt', options: { encoding: 'gbk' } });
  if (!result) return;
  assert.equal(
    result.converterId,
    'document',
    `txt→txt 应由 document 完成，实际用了「${result.converterId}」（registry.findCandidates 的 from/to 独立求交导致 PDF 模块抢单）`,
  );
  const bytes = result.files[0].bytes;
  assert.ok(
    decodeBytes(bytes, 'gbk').includes(SAMPLES.simplified),
    `按 GBK 解回的内容与原文不一致\n实际前 200 字：${head(decodeBytes(bytes, 'gbk'))}`,
  );
  assert.equal(
    strictUtf8(bytes),
    null,
    'GBK 输出不应是合法 UTF-8 字节流（若能按 UTF-8 解出，说明模块没按 GBK 编码）',
  );
  t.diagnostic(`${result.converterId} → ${result.files[0].name}（${bytes.length} B，非 UTF-8）`);
});

test('12. bundleResults：多文件打包成 zip 后可原样取回（含中文文件名）', async () => {
  const files = [
    { name: '结果一.txt', bytes: encodeText('第一份中文结果。', 'utf-8') },
    { name: '结果二.md', bytes: encodeText('# 第二份中文结果', 'utf-8') },
  ];
  const bundle = await bundleResults(files, '棱镜结果.zip');
  assert.equal(bundle.ext, 'zip');
  assert.ok(bundle.bytes.length > 0, '打包结果为空');
  const entries = await unzipBytes(bundle.bytes);
  assert.deepEqual(
    entries.map((entry) => entry.name).sort(),
    ['结果一.txt', '结果二.md'],
    '打包后的条目名与输入不一致',
  );
  const first = entries.find((entry) => entry.name === '结果一.txt');
  assert.equal(decodeBytes(first.bytes, 'utf-8'), '第一份中文结果。');
});

/**
 * 一批「文本 → 文本」的最小作业，用来验证引擎的跨模块行为（目标格式下发、文件名消毒）。
 * 这些输入都能被内容识别命中，不依赖 detect.js 的 ZIP 分支。
 */
const ENGINE_JOBS = [
  {
    label: 'JSON → YAML', converter: 'data', name: 'config.json',
    text: '{"名称":"棱镜","版本":"1.0"}', target: 'yaml', expect: ['名称', '棱镜'],
  },
  {
    label: 'JSON → XML', converter: 'data', name: 'config.json',
    text: '{"名称":"棱镜"}', target: 'xml', expect: ['名称'],
  },
  {
    label: 'CSV → JSON', converter: 'table', name: '人员.csv',
    text: '姓名,城市\n张三,北京\n', target: 'json', expect: ['张三'],
  },
  {
    label: 'CSV → XLSX', converter: 'table', name: '人员.csv',
    text: '姓名,城市\n张三,北京\n', target: 'xlsx', expect: [],
  },
  {
    label: 'SRT → VTT', converter: 'subtitle', name: '字幕.srt',
    text: SRT_FIXTURE, target: 'vtt', expect: ['你好，世界'],
  },
  {
    label: 'SRT → TXT', converter: 'subtitle', name: '字幕.srt',
    text: SRT_FIXTURE, target: 'txt', expect: ['你好，世界'],
  },
];

test('14. 请求的目标格式必须体现在产出扩展名上（引擎是否把 target 下发给模块）', async (t) => {
  for (const job of ENGINE_JOBS) {
    const file = { name: job.name, bytes: encodeText(job.text, 'utf-8') };
    const result = await runConvert(t, job.label, file, { target: job.target });
    if (!result) continue;
    const out = result.files[0];
    const actualExt = extOf(out.name);
    assert.equal(
      actualExt,
      job.target,
      `${job.label}：请求输出 .${job.target}，实际产出「${out.name}」（扩展名 .${actualExt}）。` +
        '根因在 src/core/engine.js：buildApi 没有把 wanted 作为 api.target / input.target 下发给模块，' +
        '各模块只能退回自己的默认目标，于是静默产出错误格式',
    );
    if (job.expect.length) expectContains(String(out.text ?? ''), job.expect, job.label);
    t.diagnostic(`${job.label} → ${out.name}`);
  }
});

test('15. 单文件产出的文件名不应带多余的 -1 后缀（引擎重复登记文件名）', async (t) => {
  const offending = [];
  const checked = [];
  for (const job of ENGINE_JOBS) {
    const file = { name: job.name, bytes: encodeText(job.text, 'utf-8') };
    const result = await runConvert(t, job.label, file, { target: job.target });
    if (!result || result.files.length !== 1) continue;
    const name = result.files[0].name;
    checked.push(name);
    if (/-\d+\.[a-z0-9]+$/i.test(name)) offending.push(`${job.label} → ${name}`);
  }
  assert.deepEqual(
    offending,
    [],
    '产出文件名被追加了无意义的 -1 后缀。' +
      '根因在 src/core/engine.js：api.fileName() 已经把名字写进 takenNames，convertFile 又用同一个集合做一次 uniqueFileName，' +
      `必然撞名。实际产出：${checked.join('、')}`,
  );
  t.diagnostic(`检查了 ${checked.length} 个单文件产出：${checked.join('、')}`);
});

test('16. 诊断：把目标格式注入 options 后，模块本体的产出是否正确（定位缺陷归属）', async (t) => {
  const report = [];
  const broken = [];
  for (const job of ENGINE_JOBS) {
    const file = { name: job.name, bytes: encodeText(job.text, 'utf-8') };
    // 三种约定都注入：data/table 读 target，subtitle/archive/media 读 to/format
    const options = { target: job.target, to: job.target, format: job.target };
    try {
      const result = await convertFile(file, { target: job.target, options });
      const actualExt = extOf(result.files[0].name);
      if (actualExt !== job.target) {
        broken.push(`${job.label}：注入后仍产出 ${result.files[0].name}`);
        report.push(`✖ ${job.label}（注入 target/to/format）→ ${result.files[0].name}`);
      } else {
        report.push(`✔ ${job.label}（注入 target/to/format）→ ${result.files[0].name}`);
      }
    } catch (err) {
      if (modulePending(err)) {
        report.push(`○ ${job.label}：模块未就绪`);
        continue;
      }
      broken.push(`${job.label}：${err.code} ${err.message}`);
      report.push(`✖ ${job.label}（注入 target/to/format）→ ${err.code} ${head(err.message, 100)}`);
    }
  }
  for (const line of report) t.diagnostic(line);
  assert.deepEqual(
    broken,
    [],
    `注入目标格式后仍有模块产出错误结果（说明模块自身也有问题，不只是引擎没下发 target）：\n${broken.join('\n')}`,
  );
});

test('17. 诊断：绕过 detect.js 的 ZIP 分支，单独验证 document / table 模块本体', async (t) => {
  const sections = [];
  // 注入 target/to/format 三种写法，避免「引擎没下发目标格式」掩盖模块本体的真实状态
  const inject = (ext) => ({ target: ext, to: ext, format: ext });

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
  const docxFile = { name: '季度报告.docx', bytes: new Uint8Array(await Packer.toBuffer(doc)) };
  const docxForced = await forceAnalysis(docxFile, 'docx');

  const enginePath = await runConvert(
    t,
    'DOCX → MD（强制 analysis.ext=docx，不注入 options）',
    docxFile,
    { target: 'md', analysis: docxForced },
    '仅观察产出名，不用来判断模块好坏',
  );
  if (enginePath) sections.push(`引擎路径产出名：${enginePath.files[0].name}`);

  const docxResult = await runConvert(
    t,
    'DOCX → MD（强制 analysis + 注入 target/md）',
    docxFile,
    { target: 'md', options: inject('md'), analysis: docxForced },
    '若这里失败，问题在 document.js 本体（detect 缺陷与 target 下发缺陷都已绕过）',
  );
  if (docxResult) {
    const out = docxResult.files[0];
    assert.equal(out.name.endsWith('.md'), true, `产出文件名应为 .md，实际「${out.name}」`);
    expectContains(textOfResult(docxResult), [SAMPLES.docxTitle, SAMPLES.docxBody], 'DOCX → MD（注入 target）');
    sections.push(`document 模块本体正常：${out.name}`);
  }

  const XLSX = await loadLib('xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([['姓名', '城市'], [SAMPLES.csvCell, '北京']]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '人员表');
  const xlsxFile = { name: '人员表.xlsx', bytes: new Uint8Array(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })) };
  const xlsxForced = await forceAnalysis(xlsxFile, 'xlsx');
  const xlsxResult = await runConvert(
    t,
    'XLSX → CSV（强制 analysis + 注入 target/csv）',
    xlsxFile,
    { target: 'csv', options: { ...inject('csv'), bom: true }, analysis: xlsxForced },
    '若这里失败，问题在 table.js 本体（detect 缺陷与 target 下发缺陷都已绕过）',
  );
  if (xlsxResult) {
    const bytes = xlsxResult.files[0].bytes;
    assert.ok(
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
      `bom:true 时 CSV 应带 UTF-8 BOM，实际前 3 字节：${Array.from(bytes.slice(0, 3))}`,
    );
    expectContains(decodeBytes(bytes, 'utf-8'), [SAMPLES.csvCell], 'XLSX → CSV（注入 target）');
    sections.push(`table 模块本体正常：${xlsxResult.files[0].name}`);
  }
  for (const line of sections) t.diagnostic(line);
});

test('13. 诊断：转换模块就绪清单（不影响成败，只为定位缺文件）', async (t) => {
  for (const [id, path] of Object.entries(CONVERTER_MODULES)) {
    const url = new URL(path, import.meta.url).href;
    try {
      await import(url);
      t.diagnostic(`✓ ${id}.js 就绪`);
    } catch (err) {
      t.diagnostic(`✗ ${id}.js 未就绪：${err?.code ?? ''} ${head(err?.message, 120)}`);
    }
  }
  t.diagnostic(`registry 声明的目标格式：txt=${targetsFor('txt').length} 项，docx 默认目标=${defaultTargetFor('docx')}（${formatLabel(defaultTargetFor('docx'))}）`);
});
