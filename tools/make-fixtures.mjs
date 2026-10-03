/**
 * 生成端到端验收用的真实文件夹具（不下载任何素材，全部现场构造）。
 * 覆盖：中文聊天记录 JSON、GBK 小说文本、xlsx、docx、SRT、BMP 像素、WAV 音频。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodeText } from '../src/core/encoding.js';

const DIR = new URL('../tests/fixtures/e2e/', import.meta.url);
mkdirSync(DIR, { recursive: true });
const put = (name, bytes) => {
  writeFileSync(new URL(name, DIR), bytes);
  console.log(`  ${name.padEnd(24)} ${(bytes.length / 1024).toFixed(1)} KB`);
};

/* 1. AI 聊天记录（ChatGPT conversations.json 形态，含中文与时间） */
const now = 1767225600; // 2026-01-01 00:00:00 UTC
const node = (id, parent, role, text, time) => ({
  id,
  parent,
  children: [],
  message: {
    id,
    author: { role, name: role === 'assistant' ? null : undefined },
    create_time: time,
    content: { content_type: 'text', parts: [text] },
    metadata: { model_slug: 'gpt-4o' },
  },
});

const chat = [
  {
    title: '写小说的开头怎么写',
    create_time: now,
    update_time: now + 600,
    current_node: 'n5',
    mapping: {},
  },
];
{
  const mapping = chat[0].mapping;
  const chain = [
    ['n1', null, 'system', 'You are a helpful assistant.', now],
    ['n2', 'n1', 'user', '我想写一个关于玻璃之城的小说开头，有什么建议？', now + 10],
    ['n3', 'n2', 'assistant', '可以从一个具体的感官细节切入：比如清晨第一缕光穿过玻璃穹顶，落在主角的指尖上。', now + 30],
    ['n4', 'n3', 'user', '那第一句具体怎么写比较好？', now + 60],
    ['n5', 'n4', 'assistant', '试试这句：「他第一次听见城市呼吸，是在玻璃穹顶裂开一道缝的那个早晨。」', now + 90],
  ];
  for (const [id, parent, role, text, time] of chain) {
    mapping[id] = node(id, parent, role, text, time);
  }
  for (const [id, parent] of chain) {
    if (parent && mapping[parent]) mapping[parent].children.push(id);
  }
  // 被放弃的重新生成分支：不应出现在输出里
  mapping.n3b = node('n3b', 'n2', 'assistant', '这是被用户放弃的另一个回答，不应该出现在导出结果里。', now + 40);
  mapping.n2.children.push('n3b');
}

const chat2 = {
  title: '读书笔记整理',
  create_time: now + 7200,
  current_node: 'm2',
  mapping: {
    m1: node('m1', null, 'user', '帮我把《雪国》的读书笔记整理成三条要点。', now + 7200),
    m2: node('m2', 'm1', 'assistant', '一、开篇的「穿过县界长长的隧道」定下了全书的冷与远。\n二、驹子的洁净与岛村的虚无互为镜像。\n三、结尾的银河是情绪的最高点。', now + 7240),
  },
};
chat2.mapping.m1.children.push('m2');

put('chatgpt-导出.json', encodeText(JSON.stringify([...chat, chat2], null, 1), 'utf-8'));

/* 2. GBK 编码的中文小说片段（老阅读器/老软件场景） */
put('小说片段-gbk.txt', encodeText(
  '第一章 起风了\n\n'
  + '他推开窗，风从玻璃穹顶的缝隙里灌进来，带着雨后铁锈的味道。\n'
  + '城市在脚下亮起来，像一块被光慢慢浸透的琥珀。\n\n'
  + '第二章 玻璃之城\n\n'
  + '没有人记得这座城是什么时候开始透明的。人们只是习惯了在别人的目光里生活。\n',
  'gbk',
));

/* 3. Big5 繁体文本 */
put('繁體段落-big5.txt', encodeText(
  '第三章 遠行\n\n他背起行囊，沿著鐵道往南走。天色將暗，遠方的燈火像散落的星子。\n',
  'big5',
));

/* 4. xlsx（中文单元格 + 日期 + 数字） */
const XLSX = await import('xlsx');
{
  const rows = [
    ['姓名', '部门', '入职日期', '绩效分'],
    ['张三', '研发部', new Date('2024-03-01'), 92.5],
    ['李四', '设计部', new Date('2024-07-15'), 88],
    ['王五', '市场部', new Date('2025-01-06'), 95.25],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '员工表');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['月份', '销量'], ['一月', 120], ['二月', 98]]), '季度销量');
  put('员工表.xlsx', new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' })));
}

/* 5. docx（中文标题、段落、列表、表格） */
{
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun } = await import('docx');
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: '第一章 起风了', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun('他推开窗，风从玻璃穹顶的缝隙里灌进来，带着雨后铁锈的味道。')] }),
        new Paragraph({ text: '本章要点', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: '玻璃之城的设定', bullet: { level: 0 } }),
        new Paragraph({ text: '主角的感官细节', bullet: { level: 0 } }),
        new Table({
          rows: [
            new TableRow({ children: [new TableCell({ children: [new Paragraph('角色')] }), new TableCell({ children: [new Paragraph('身份')] })] }),
            new TableRow({ children: [new TableCell({ children: [new Paragraph('林澈')] }), new TableCell({ children: [new Paragraph('玻璃匠人')] })] }),
          ],
        }),
      ],
    }],
  });
  put('季度报告.docx', new Uint8Array(await Packer.toBuffer(doc)));
}

/* 6. SRT 字幕（中文） */
put('字幕.srt', encodeText(
  '1\n00:00:01,000 --> 00:00:03,500\n你好，世界\n\n'
  + '2\n00:00:04,000 --> 00:00:06,000\n这是第二行字幕\n\n'
  + '3\n00:00:07,250 --> 00:00:09,000\n玻璃之城在光里闪烁\n',
  'utf-8',
));

/* 7. BMP 像素（24 位，手工构造，避免任何图像库依赖） */
{
  const width = 16;
  const height = 8;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowSize + x * 3;
      pixels[offset] = Math.round((x / (width - 1)) * 255);          // B
      pixels[offset + 1] = Math.round((y / (height - 1)) * 255);     // G
      pixels[offset + 2] = 200;                                      // R
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  put('色块.bmp', new Uint8Array(Buffer.concat([header, pixels])));
}

/* 8. WAV 音频（1 秒 440Hz，用于验证浏览器里的 ffmpeg 转码链路） */
{
  const sampleRate = 16000;
  const seconds = 1;
  const samples = sampleRate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
    data.writeInt16LE(value, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  put('音调.wav', new Uint8Array(Buffer.concat([header, data])));
}

/* 9. PDF（两页英文文字，用于浏览器端「渲染成图片 / 提取文字」验证） */
{
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const text of ['PRISM PAGE ONE', 'PRISM PAGE TWO']) {
    const page = doc.addPage([420, 300]);
    page.drawText(text, { x: 40, y: 180, size: 30, font, color: rgb(0.1, 0.2, 0.6) });
    page.drawText('Hello World 12345', { x: 40, y: 120, size: 16, font });
    page.drawRectangle({ x: 40, y: 60, width: 200, height: 30, color: rgb(0.6, 0.8, 1) });
  }
  put('样张.pdf', new Uint8Array(await doc.save()));
}

/* 10. Markdown 笔记 */put('写作笔记.md', encodeText(
  '# 写作笔记\n\n## 玻璃之城\n\n- 设定：城市由玻璃构成，光是唯一的建筑材料\n- 主角：林澈，玻璃匠人\n\n> 引用：他第一次听见城市呼吸。\n\n| 角色 | 身份 |\n| --- | --- |\n| 林澈 | 玻璃匠人 |\n| 阿禾 | 守灯人 |\n',
  'utf-8',
));

console.log('夹具已生成到 tests/fixtures/e2e/');
