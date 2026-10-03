/**
 * chat-export 模块测试：node --test tests/chat-export.test.mjs
 * fixture 全部内联构造，不依赖任何外部文件或网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { convert, inspect, meta } from '../src/core/chat-export.js';
import { ConversionError } from '../src/core/errors.js';
import { decodeBytes, encodeText } from '../src/core/encoding.js';
import { sanitizeFileName } from '../src/core/util.js';

/* ---------------- 测试用 api 桩 ---------------- */

function createApi(source, options = {}) {
  const bytes = typeof source === 'string' ? encodeText(source, 'utf-8') : source;
  const notes = [];
  const progressLog = [];
  return {
    input: {
      name: options.name ?? 'conversations.json',
      ext: options.ext ?? 'json',
      mime: 'application/json',
      size: options.declaredSize ?? bytes.length,
      bytes,
    },
    bytes: () => bytes,
    text: (encoding) => decodeBytes(bytes, encoding ?? 'utf-8'),
    opt: (key, fallback) => (key in options ? options[key] : fallback),
    encode: (text, encoding = 'utf-8') => encodeText(text, encoding),
    decode: (data, encoding) => decodeBytes(data, encoding),
    progress: (ratio, label) => progressLog.push({ ratio, label }),
    note: (level, message) => notes.push({ level, message }),
    fileName: (name) => sanitizeFileName(name),
    zip: () => { throw new Error('chat-export 不应调用 zip'); },
    unzip: () => { throw new Error('chat-export 不应调用 unzip'); },
    lib: () => { throw new Error('chat-export 不应加载第三方库'); },
    env: 'node',
    notes,
    progressLog,
  };
}

async function run(source, options = {}) {
  const api = createApi(source, options);
  const result = await convert(api.input, api);
  return { api, result, notes: result.notes, text: decodeBytes(result.files[0].bytes, 'utf-8') };
}

const json = (value) => JSON.stringify(value);
/** 本地时区的秒级时间戳：断言格式化结果时不会被机器时区带偏 */
const at = (month, day, hour, minute, second = 0) =>
  Math.floor(new Date(2026, month - 1, day, hour, minute, second).getTime() / 1000);

/* ---------------- fixtures ---------------- */

function chatGptExport() {
  return [{
    title: '如何写小说开头',
    create_time: at(3, 1, 20, 11),
    update_time: at(3, 1, 20, 31),
    current_node: 'n4',
    // 故意打乱 key 顺序，并在 n3 下挂一条被放弃的重新生成分支
    mapping: {
      n4: {
        id: 'n4', parent: 'n3', children: [],
        message: {
          author: { role: 'assistant' }, create_time: at(3, 1, 20, 13) * 1000,
          content: { content_type: 'text', parts: ['开头最重要的是把读者按进场景里。'] },
          metadata: { model_slug: 'deepseek-chat' },
        },
      },
      n2: {
        id: 'n2', parent: 'n1', children: ['n3'],
        message: {
          author: { role: 'user' }, create_time: at(3, 1, 20, 11),
          content: { content_type: 'text', parts: ['最近想写个小说开头，有什么建议？'] },
          metadata: {},
        },
      },
      n1: {
        id: 'n1', parent: null, children: ['n2'],
        message: {
          author: { role: 'system' }, create_time: at(3, 1, 20, 10),
          content: { content_type: 'text', parts: ['你是一个写作助手'] },
          metadata: {},
        },
      },
      x1: {
        id: 'x1', parent: 'n3', children: [],
        message: {
          author: { role: 'assistant' }, create_time: at(3, 1, 20, 25),
          content: { content_type: 'text', parts: ['这条是被放弃的重新生成结果'] },
          metadata: {},
        },
      },
      n3: {
        id: 'n3', parent: 'n2', children: ['n4', 'x1'],
        message: {
          author: { role: 'assistant' }, create_time: at(3, 1, 20, 12),
          content: { content_type: 'text', parts: ['可以从一个动作开始。'] },
          metadata: { model_slug: 'gpt-4o' },
        },
      },
    },
  }];
}

function claudeExport() {
  return [{
    uuid: 'conv-1',
    name: '周报怎么写',
    created_at: '2026-03-02T09:30:00',
    updated_at: '2026-03-02T09:40:00',
    chat_messages: [
      {
        uuid: 'm1', sender: 'human', created_at: '2026-03-02T09:30:00',
        text: '周报总写成流水账，怎么办？',
        content: [{ type: 'text', text: '周报总写成流水账，怎么办？' }],
      },
      {
        uuid: 'm2', sender: 'assistant', created_at: '2026-03-02T09:31:00',
        text: '按「结论先行」写：先说结果，再说过程。',
        content: [
          { type: 'thinking', thinking: '先判断他想要的是模板还是原则' },
          { type: 'text', text: '按「结论先行」写：先说结果，再说过程。' },
          { type: 'tool_use', name: 'search', input: { query: '周报模板' } },
        ],
      },
    ],
  }];
}

function doubaoExport() {
  return {
    data: {
      sections: [{
        title: '写作',
        conversations: [{
          title: '小说开头',
          created_at: at(3, 3, 10, 0),
          messages: [
            { role: 'user', content: '开头怎么写才不无聊？', created_at: at(3, 3, 10, 0) },
            { role: 'assistant', content: '先给一个反常的细节。', created_at: at(3, 3, 10, 1) },
          ],
        }],
      }],
    },
  };
}

function genericMessages() {
  return [
    { role: 'user', content: '帮我起个标题' },
    { role: 'assistant', content: '《把读者按进场景里》' },
  ];
}

function geminiTakeout() {
  return [{
    header: 'Gemini',
    title: '与 Gemini 的对话',
    time: '2026-03-04T08:00:00.000Z',
    products: ['Gemini'],
    subtasks: [
      { title: '你', time: '2026-03-04T08:00:00.000Z', snippets: [{ name: '帮我把这段话缩短' }] },
      { title: 'Gemini', time: '2026-03-04T08:00:05.000Z', snippets: [{ name: '删掉重复的形容词即可。' }] },
    ],
  }];
}

/** 三个会话，数组顺序与时间顺序相反，用来验证「按时间升序、无时间排最后」 */
function shuffledConversations() {
  return [
    {
      title: '第三个会话',
      create_time: at(3, 5, 12, 0),
      mapping: { a: { id: 'a', parent: null, children: [], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['第三会话的内容'] }, create_time: at(3, 5, 12, 0) } } },
    },
    { title: '没有时间的会话', create_time: null, current_node: 'b',
      mapping: { b: { id: 'b', parent: null, children: [], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['没有时间的内容'] }, create_time: null } } } },
    {
      title: '第一个会话',
      create_time: at(3, 1, 9, 0),
      mapping: { a: { id: 'a', parent: null, children: [], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['第一会话的内容'] }, create_time: at(3, 1, 9, 0) } } },
    },
    {
      title: '第二个会话',
      create_time: at(3, 3, 15, 0),
      mapping: { a: { id: 'a', parent: null, children: [], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['第二会话的内容'] }, create_time: at(3, 3, 15, 0) } } },
    },
  ];
}

function manyConversations(count) {
  return Array.from({ length: count }, (_value, index) => ({
    title: `会话 ${index + 1}`,
    create_time: at(3, 1, 0, 0) + index * 60,
    mapping: {
      a: {
        id: 'a', parent: null, children: [],
        message: { author: { role: 'user' }, content: { content_type: 'text', parts: [`第 ${index + 1} 个会话的正文`] }, create_time: at(3, 1, 0, 0) + index * 60 },
      },
    },
  }));
}

/* ---------------- 元信息 ---------------- */

test('meta 声明了 5 种输出格式与全部选项', () => {
  assert.equal(meta.id, 'chat-export');
  assert.deepEqual(meta.to, ['txt', 'md', 'html', 'jsonl', 'csv']);
  const keys = meta.options.map((option) => option.key);
  for (const key of ['layout', 'timestamps', 'roleNames', 'includeThinking', 'includeTitles', 'roleFilter', 'conversationIds', 'oneFilePerConversation', 'encoding']) {
    assert.ok(keys.includes(key), `缺少选项 ${key}`);
  }
  const layout = meta.options.find((option) => option.key === 'layout');
  assert.deepEqual(layout.choices.map((choice) => choice.value), ['chat', 'transcript', 'plain', 'timeline']);
});

/* ---------------- 各来源识别 ---------------- */

test('ChatGPT 导出：按 mapping 父子链还原顺序，丢弃被放弃的分支', async () => {
  const { text, notes, result } = await run(json(chatGptExport()));
  assert.equal(result.files.length, 1);
  assert.match(result.files[0].name, /\.txt$/);

  assert.ok(text.includes('会话标题：如何写小说开头'), '缺少会话标题');
  assert.ok(text.includes('最近想写个小说开头，有什么建议？'), '缺少用户中文正文');
  assert.ok(text.includes('开头最重要的是把读者按进场景里。'), '缺少 AI 中文正文');

  const userIndex = text.indexOf('最近想写个小说开头');
  const firstReply = text.indexOf('可以从一个动作开始。');
  const secondReply = text.indexOf('开头最重要的是把读者按进场景里。');
  assert.ok(userIndex < firstReply && firstReply < secondReply, `顺序错误：${text.slice(0, 200)}`);
  assert.ok(!text.includes('这条是被放弃的重新生成结果'), '被放弃的分支不应出现');
  assert.ok(text.includes('AI（deepseek-chat）'), '缺少模型名');
  assert.ok(text.includes('[2026-03-01 20:11] 我：'), `时间格式或角色标记不对：${text.slice(0, 160)}`);
  assert.ok(text.includes('[2026-03-01 20:13] AI（deepseek-chat）：'), '毫秒时间戳未正确格式化');
  assert.ok(notes.some((note) => note.message.includes('ChatGPT 导出')), '缺少来源提示');
});

test('没有 current_node 时按父子链（根 → 叶子）还原顺序', async () => {
  const fixture = chatGptExport();
  delete fixture[0].current_node;
  // 去掉被放弃分支，只留一条线性链
  delete fixture[0].mapping.x1;
  fixture[0].mapping.n3.children = ['n4'];
  const { text } = await run(json(fixture), { includeSystem: true });
  const order = ['你是一个写作助手', '最近想写个小说开头', '可以从一个动作开始。', '开头最重要的是把读者按进场景里。']
    .map((needle) => text.indexOf(needle));
  assert.ok(order.every((index) => index >= 0), '有片段没输出');
  assert.deepEqual([...order].sort((a, b) => a - b), order, '顺序不是根到叶子');
});

test('系统提示词默认不导出，打开 includeSystem 才保留', async () => {
  const fixture = chatGptExport();
  const byDefault = await run(json(fixture));
  assert.ok(!byDefault.text.includes('你是一个写作助手'), '默认导出不该出现系统提示词');
  assert.ok(byDefault.notes.some((n) => String(n.message).includes('系统提示')), '略过系统提示要如实告知');

  const withSystem = await run(json(fixture), { includeSystem: true });
  assert.ok(withSystem.text.includes('你是一个写作助手'), '打开开关后必须保留');
});

test('Claude 导出：human/assistant 与思考、工具内容', async () => {
  const source = json(claudeExport());
  const api = createApi(source);
  const info = inspect(api.input, api);
  assert.equal(info.provider, 'claude');
  assert.equal(info.providerLabel, 'Claude 导出');
  assert.equal(info.conversations.length, 1);
  assert.equal(info.conversations[0].messageCount, 4);
  assert.equal(info.conversations[0].roleCounts.user, 1);
  assert.ok(info.conversations[0].preview.includes('周报总写成流水账'));

  const { text } = await run(source);
  assert.ok(text.includes('会话标题：周报怎么写'));
  assert.ok(text.includes('周报总写成流水账，怎么办？'));
  assert.ok(text.includes('按「结论先行」写：先说结果，再说过程。'));
  assert.ok(text.includes('AI：'), 'Claude 没有 model 字段时应显示为 AI');
  assert.ok(text.includes('（思考）'), '默认应保留思考过程');

  const filtered = await run(source, { includeThinking: false, to: 'txt' });
  assert.ok(!filtered.text.includes('先判断他想要的是模板还是原则'));
  assert.ok(!filtered.text.includes('调用工具 search'));
  assert.ok(filtered.notes.some((note) => /过滤了 2 条/.test(note.message)), `note 未报告过滤条数：${JSON.stringify(filtered.notes)}`);
});

test('豆包类嵌套结构：sections → conversations → messages', async () => {
  const { text, notes } = await run(json(doubaoExport()));
  assert.ok(text.includes('会话标题：小说开头'));
  assert.ok(text.includes('开头怎么写才不无聊？'));
  assert.ok(text.includes('先给一个反常的细节。'));
  assert.ok(notes.some((note) => note.message.includes('豆包/通义类导出')));
});

test('通用 messages 数组与 {messages:[…]} 包装', async () => {
  const flat = await run(json(genericMessages()));
  assert.ok(flat.text.includes('帮我起个标题'));
  assert.ok(flat.text.includes('《把读者按进场景里》'));

  const wrapped = await run(json({ title: '起标题', messages: genericMessages() }));
  assert.ok(wrapped.text.includes('会话标题：起标题'));
  assert.ok(wrapped.text.includes('《把读者按进场景里》'));

  const chatKey = await run(json({ chat: genericMessages() }));
  assert.ok(chatKey.text.includes('帮我起个标题'));
});

test('JSONL：每行一条消息算一个会话，每行一个会话则拆多个', async () => {
  const lines = [
    json({ role: 'user', content: '第一行提问' }),
    json({ role: 'assistant', content: '第一行回答' }),
  ].join('\n');
  const single = await run(lines, { name: 'log.jsonl', ext: 'jsonl' });
  assert.ok(single.text.includes('第一行提问'));
  assert.ok(single.text.includes('第一行回答'));

  const sessions = [
    json({ title: '会话甲', messages: [{ role: 'user', content: '甲的提问' }, { role: 'assistant', content: '甲的回答' }] }),
    json({ title: '会话乙', messages: [{ role: 'user', content: '乙的提问' }, { role: 'assistant', content: '乙的回答' }] }),
  ].join('\n');
  const multi = await run(sessions, { name: 'sessions.jsonl', ext: 'jsonl' });
  assert.ok(multi.text.includes('会话标题：会话甲'));
  assert.ok(multi.text.includes('会话标题：会话乙'));
  assert.ok(multi.text.includes('甲的提问') && multi.text.includes('乙的回答'));
});

test('Gemini Takeout 活动记录', async () => {
  const { text, notes } = await run(json(geminiTakeout()));
  assert.ok(text.includes('帮我把这段话缩短'));
  assert.ok(text.includes('删掉重复的形容词即可。'));
  assert.ok(text.includes('我：'), '「你」应识别为用户');
  assert.ok(text.includes('AI（Gemini）'), '模型名应来自 subtask 标题');
  assert.ok(notes.some((note) => note.message.includes('Gemini')));
});

test('QQ / 微信 文本聊天记录（兜底）', async () => {
  const source = [
    '2026-03-06 21:00:01 小明(10001)',
    '今天去看电影吗？',
    '2026-03-06 21:01:12 小红(10002)',
    '好啊，几点？',
    '2026-03-06 21:02:30 小明(10001)',
    '七点半，老地方见。',
  ].join('\n');
  const { text, notes } = await run(source, { name: 'qq.txt', ext: 'txt' });
  assert.ok(text.includes('今天去看电影吗？'));
  assert.ok(text.includes('七点半，老地方见。'));
  assert.ok(notes.some((note) => note.message.includes('QQ / 微信')));
});

/* ---------------- 时间 ---------------- */

test('时间戳：秒、毫秒、ISO 字符串都能认', async () => {
  const fixture = [{
    title: '时间测试',
    create_time: at(3, 7, 8, 9),
    mapping: {
      a: { id: 'a', parent: null, children: ['b'], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['秒级时间戳'] }, create_time: at(3, 7, 8, 9) } },
      b: { id: 'b', parent: 'a', children: ['c'], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['毫秒时间戳'] }, create_time: at(3, 7, 8, 10) * 1000, metadata: { model_slug: 'gpt-4o' } } },
      c: { id: 'c', parent: 'b', children: [], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['ISO 字符串'] }, create_time: '2026-03-07T08:11:30' } },
    },
  }];
  const { text } = await run(json(fixture));
  assert.ok(text.includes('[2026-03-07 08:09] 我：'), '秒级时间戳未格式化');
  assert.ok(text.includes('[2026-03-07 08:10] AI（gpt-4o）：'), '毫秒时间戳未格式化');
  assert.ok(text.includes('[2026-03-07 08:11] 我：'), 'ISO 字符串未格式化');

  const noTime = await run(json(fixture), { timestamps: false });
  assert.ok(!noTime.text.includes('[2026-03-07'), 'timestamps=false 时不应出现时间');
});

/* ---------------- 排版 ---------------- */

test('三种排版：chat / plain / timeline（外加 transcript）', async () => {
  const fixture = json([
    { title: '会话甲', create_time: at(3, 8, 10, 0), messages: [
      { role: 'user', content: '甲的提问', created_at: at(3, 8, 10, 0) },
      { role: 'assistant', content: '甲的回答', created_at: at(3, 8, 10, 1) },
    ] },
    { title: '会话乙', create_time: at(3, 8, 11, 0), messages: [
      { role: 'user', content: '乙的提问', created_at: at(3, 8, 11, 0) },
      { role: 'assistant', content: '乙的回答', created_at: at(3, 8, 11, 1) },
    ] },
  ]);

  const chat = await run(fixture, { layout: 'chat', to: 'txt' });
  assert.ok(chat.text.includes('会话标题：会话甲'));
  assert.ok(chat.text.includes('会话目录（共 2 个）'), '多会话应生成目录');
  assert.ok(chat.text.includes('  2. 会话乙'), '目录应包含全部会话');

  const plain = await run(fixture, { layout: 'plain', to: 'txt' });
  assert.ok(plain.text.includes('甲的提问'));
  assert.ok(!plain.text.includes('会话标题'), 'plain 不应有角色标记与标题');
  assert.ok(!plain.text.includes('我：') && !plain.text.includes('AI：'));
  assert.ok(!/\[2026-/.test(plain.text), 'plain 不应有时间');

  const timeline = await run(fixture, { layout: 'timeline', to: 'txt' });
  const firstConversationA = timeline.text.indexOf('甲的提问');
  const firstConversationB = timeline.text.indexOf('乙的提问');
  assert.ok(firstConversationA >= 0 && firstConversationB >= 0);
  assert.ok(firstConversationA < firstConversationB, 'timeline 应按时间排成一条线');
  assert.ok(timeline.text.includes('会话甲 · 我：'), 'timeline 应带会话归属');

  const transcript = await run(fixture, { layout: 'transcript', to: 'txt' });
  assert.ok(transcript.text.includes('## 会话甲'));
  assert.ok(transcript.text.includes('**我** · 2026-03-08 10:00'));
});

test('transcript / chat 的 Markdown 代码块保持原样缩进', async () => {
  const code = '```js\nconst a = 1;\n```';
  const fixture = json([{ role: 'user', content: `看这段代码有问题吗？\n\n${code}` }]);
  const { text } = await run(fixture, { layout: 'chat', to: 'txt' });
  assert.ok(text.includes('\nconst a = 1;\n'), `代码块被缩进了：${JSON.stringify(text)}`);
  assert.ok(!text.includes('  const a = 1;'), '代码块内的行不应被缩进');
  assert.ok(text.includes('  看这段代码有问题吗？'), '正文应缩进两格');
});

/* ---------------- 输出格式 ---------------- */

test('md 输出是标准 Markdown', async () => {
  const { result, text } = await run(json(doubaoExport()), { to: 'md', layout: 'transcript' });
  assert.match(result.files[0].name, /\.md$/);
  assert.ok(text.includes('## 小说开头'));
  assert.ok(text.includes('**我** · 2026-03-03 10:00'));
  assert.ok(text.includes('先给一个反常的细节。'));
});

test('html 输出转义正确、带 charset、中文不乱码', async () => {
  const source = json([{ role: 'user', content: '<script>alert("中文")</script> 求解释' }]);
  const { result, text } = await run(source, { to: 'html' });
  assert.match(result.files[0].name, /\.html$/);
  assert.ok(text.includes('<meta charset="utf-8">'));
  assert.ok(text.includes('&lt;script&gt;alert(&quot;中文&quot;)&lt;/script&gt; 求解释'));
  assert.ok(!text.includes('<script>alert'), '未转义的尖括号会破坏页面');
  assert.ok(text.includes('我'), '中文标签应正常输出');
});

test('jsonl 输出每行一条消息且字段齐全', async () => {
  const { text } = await run(json(doubaoExport()), { to: 'jsonl' });
  const lines = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].conversation, 1);
  assert.equal(lines[0].title, '小说开头');
  assert.equal(lines[0].index, 1);
  assert.equal(lines[0].role, 'user');
  assert.equal(lines[0].time, '2026-03-03 10:00');
  assert.equal(lines[1].role, 'assistant');
  assert.ok(lines[0].text.includes('开头怎么写才不无聊？'));
});

test('csv 输出列为 会话,序号,角色,时间,内容', async () => {
  const { result, text } = await run(json(doubaoExport()), { to: 'csv' });
  assert.match(result.files[0].name, /\.csv$/);
  const rows = text.trim().split('\r\n');
  assert.equal(rows[0], '会话,序号,角色,时间,内容');
  assert.ok(rows[1].startsWith('小说开头,1,我,2026-03-03 10:00,'));
  assert.ok(rows[1].includes('开头怎么写才不无聊？'));
  assert.equal(rows.length, 3);
});

test('oneFilePerConversation：按会话拆成多个文件且文件名不重名', async () => {
  const fixture = json({
    items: [
      { title: '同名会话', created_at: at(3, 9, 10, 0), messages: [{ role: 'user', content: '第一条内容' }] },
      { title: '同名会话', created_at: at(3, 9, 11, 0), messages: [{ role: 'user', content: '第二条内容' }] },
      { title: '第三个/带非法字符', created_at: at(3, 9, 12, 0), messages: [{ role: 'user', content: '第三条内容' }] },
    ],
  });
  const api = createApi(fixture, { oneFilePerConversation: true, to: 'txt' });
  const result = await convert(api.input, api);
  assert.equal(result.files.length, 3);
  const names = result.files.map((file) => file.name);
  assert.equal(new Set(names).size, 3, `文件名重复：${names.join(', ')}`);
  assert.ok(names[0].startsWith('同名会话-1'), names[0]);
  assert.ok(names[1].startsWith('同名会话-2'), names[1]);
  assert.ok(!/[\\/:*?"<>|]/.test(names[2]), `文件名未消毒：${names[2]}`);
  assert.ok(decodeBytes(result.files[0].bytes, 'utf-8').includes('第一条内容'));
  assert.ok(decodeBytes(result.files[2].bytes, 'utf-8').includes('第三条内容'));
});

test('中文输出编码：gbk 仍能还原中文', async () => {
  const api = createApi(json(doubaoExport()), { to: 'txt', encoding: 'gbk' });
  const result = await convert(api.input, api);
  const decoded = decodeBytes(result.files[0].bytes, 'gbk');
  assert.ok(decoded.includes('开头怎么写才不无聊？'));
  assert.ok(decoded.includes('先给一个反常的细节。'));
});

/* ---------------- 选项 ---------------- */

test('roleFilter：只要提问 / 只要回答，空会话整条跳过', async () => {
  const fixture = json({
    items: [
      { title: '有来有回', created_at: at(3, 10, 10, 0), messages: [{ role: 'user', content: '我的中文提问' }, { role: 'assistant', content: 'AI 的中文回答' }] },
      { title: '只有回答', created_at: at(3, 10, 11, 0), messages: [{ role: 'assistant', content: '孤立的回答' }] },
    ],
  });
  const onlyUser = await run(fixture, { roleFilter: 'user', to: 'txt' });
  assert.ok(onlyUser.text.includes('我的中文提问'));
  assert.ok(!onlyUser.text.includes('AI 的中文回答'));
  assert.ok(!onlyUser.text.includes('会话标题：只有回答'), '过滤后为空的会话应整条跳过');
  assert.ok(onlyUser.notes.some((note) => /按角色筛选后跳过了 1 个/.test(note.message)), JSON.stringify(onlyUser.notes));

  const onlyAssistant = await run(fixture, { roleFilter: 'assistant', to: 'txt' });
  assert.ok(onlyAssistant.text.includes('AI 的中文回答'));
  assert.ok(!onlyAssistant.text.includes('我的中文提问'));
  assert.ok(onlyAssistant.text.includes('会话标题：只有回答'));
});

test('conversationIds：只导出指定序号，非法序号在 notes 里说明', async () => {
  const fixture = json(manyConversations(5));
  const picked = await run(fixture, { conversationIds: '1, 3', to: 'txt' });
  assert.ok(picked.text.includes('第 1 个会话的正文'));
  assert.ok(picked.text.includes('第 3 个会话的正文'));
  assert.ok(!picked.text.includes('第 2 个会话的正文'));
  assert.ok(!picked.text.includes('第 5 个会话的正文'));

  const withMissing = await run(fixture, { conversationIds: '2,9', to: 'txt' });
  assert.ok(withMissing.text.includes('第 2 个会话的正文'));
  assert.ok(withMissing.notes.some((note) => note.message.includes('忽略了不存在的会话序号 9')), JSON.stringify(withMissing.notes));

  const all = await run(fixture, { conversationIds: '', to: 'txt' });
  assert.ok(all.text.includes('第 5 个会话的正文'));
});

test('超大文件：限制解析的会话数并报告', async () => {
  const fixture = json(manyConversations(260));
  const { text, notes } = await run(fixture, { declaredSize: 40 * 1024 * 1024, to: 'txt' });
  assert.ok(text.includes('第 200 个会话的正文'));
  assert.ok(!text.includes('第 201 个会话的正文'));
  assert.ok(notes.some((note) => note.level === 'warn' && note.message.includes('200 个会话')), JSON.stringify(notes));
});

/* ---------------- inspect 与 convert 的顺序一致性 ---------------- */

test('inspect：4 种来源都能给出 provider 与 messageCount', async () => {
  const cases = [
    { source: json(chatGptExport()), provider: 'chatgpt', label: 'ChatGPT 导出', count: 4 },
    { source: json(claudeExport()), provider: 'claude', label: 'Claude 导出', count: 4 },
    { source: json(doubaoExport()), provider: 'nested', label: '豆包/通义类导出', count: 2 },
    { source: json(genericMessages()), provider: 'generic', label: '通用 [{role,content}]', count: 2 },
    { source: [json({ title: '甲', messages: [{ role: 'user', content: '甲问题' }] }), json({ title: '乙', messages: [{ role: 'user', content: '乙问题' }] })].join('\n'), provider: 'jsonl', label: 'JSON Lines', count: 1 },
  ];
  for (const item of cases) {
    const api = createApi(item.source, { name: 'x.json' });
    const info = inspect(api.input, api);
    assert.equal(info.provider, item.provider, `${item.provider} 来源识别错误`);
    assert.equal(info.providerLabel, item.label);
    assert.equal(info.conversations[0].messageCount, item.count, `${item.provider} 消息数不对`);
    const { createdAt } = info.conversations[0];
    assert.ok(createdAt === null || typeof createdAt === 'number', 'createdAt 应为 number|null');
    assert.ok(info.conversations[0].preview.length <= 120);
  }
});

test('inspect：结构统计（角色计数、模型名、预览）', async () => {
  const api = createApi(json(chatGptExport()));
  const [conversation] = inspect(api.input, api).conversations;
  assert.equal(conversation.title, '如何写小说开头');
  assert.equal(conversation.roleCounts.user, 1);
  assert.equal(conversation.roleCounts.assistant, 2);
  assert.equal(conversation.roleCounts.system, 1);
  assert.deepEqual(conversation.modelNames, ['gpt-4o', 'deepseek-chat']);
  assert.ok(conversation.preview.includes('你是一个写作助手'));
  assert.equal(typeof conversation.createdAt, 'number');
});

test('inspect 的顺序与 convert 的会话顺序完全一致（序号不能错位）', async () => {
  const source = json(shuffledConversations());
  const api = createApi(source);
  const titles = inspect(api.input, api).conversations.map((conversation) => conversation.title);
  assert.deepEqual(titles, ['第一个会话', '第二个会话', '第三个会话', '没有时间的会话']);

  const split = createApi(source, { oneFilePerConversation: true, to: 'txt' });
  const files = (await convert(split.input, split)).files.map((file) => file.name);
  assert.deepEqual(files, [
    '第一个会话-1.txt', '第二个会话-2.txt', '第三个会话-3.txt', '没有时间的会话-4.txt',
  ]);

  const single = await run(source, { to: 'txt' });
  const tocLines = single.text.split('\n').filter((line) => /^  \d+\. /.test(line));
  assert.deepEqual(tocLines.map((line) => line.replace(/^  \d+\. /, '').split(' —— ')[0]), titles);

  const byId = await run(source, { conversationIds: '3', to: 'txt' });
  assert.ok(byId.text.includes('第三会话的内容'), '序号 3 应指向 inspect 列表里的第 3 个会话');
  assert.ok(!byId.text.includes('第一会话的内容'));
});

/* ---------------- 边界与错误路径 ---------------- */

test('坏 JSON 抛 ConversionError，code 为 CHAT_FORMAT_UNKNOWN', async () => {
  const api = createApi('{ 这不是 JSON，也不是聊天记录 }');
  await assert.rejects(
    () => convert(api.input, api),
    (error) => {
      assert.ok(error instanceof ConversionError, '必须是 ConversionError');
      assert.equal(error.code, 'CHAT_FORMAT_UNKNOWN');
      assert.ok(error.message.includes('没认出这是哪家的聊天记录导出格式'));
      return true;
    },
  );
});

test('合法 JSON 但没有会话结构也抛 CHAT_FORMAT_UNKNOWN', async () => {
  const api = createApi(json({ hello: 'world', nested: { a: [1, 2, 3] } }));
  await assert.rejects(() => convert(api.input, api), (error) => error.code === 'CHAT_FORMAT_UNKNOWN');
  // inspect 是同步接口，同步抛出要用 assert.throws
  assert.throws(() => inspect(api.input, api), (error) => error.code === 'CHAT_FORMAT_UNKNOWN');
});

test('空输入抛 CHAT_FORMAT_UNKNOWN', async () => {
  const empty = createApi(new Uint8Array(0));
  await assert.rejects(() => convert(empty.input, empty), (error) => error.code === 'CHAT_FORMAT_UNKNOWN');
  const blank = createApi('   \n  ');
  await assert.rejects(() => convert(blank.input, blank), (error) => error.code === 'CHAT_FORMAT_UNKNOWN');
});

test('空会话不报错：输出占位提示并给出 warn', async () => {
  const source = json([{
    title: '空会话',
    create_time: at(3, 11, 10, 0),
    mapping: { a: { id: 'a', parent: null, children: [], message: null } },
  }]);
  const { text, notes } = await run(source, { to: 'txt' });
  assert.ok(text.includes('会话标题：空会话'));
  assert.ok(text.includes('（此会话没有可显示的消息）'));
  assert.ok(notes.some((note) => note.level === 'warn' && note.message.includes('没有可显示的正文')), JSON.stringify(notes));
});

test('脏数据会话不崩，其余会话照常输出', async () => {
  const source = json([
    { title: '正常的会话', create_time: at(3, 12, 10, 0), mapping: { a: { id: 'a', parent: null, children: [], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['正常的中文内容'] }, create_time: at(3, 12, 10, 0) } } } },
    // children 不是数组、parent 指向自己（成环）、content 为 null：都是导出文件里真实出现过的脏数据
    { title: '脏数据的会话', create_time: at(3, 12, 11, 0), mapping: { a: { id: 'a', parent: 'a', children: 'oops', message: { author: { role: 'assistant' }, content: null, create_time: at(3, 12, 11, 0) } } } },
  ]);
  const { text, notes } = await run(source, { to: 'txt' });
  assert.ok(text.includes('正常的中文内容'));
  assert.ok(text.includes('会话标题：正常的会话'));
  assert.ok(text.includes('会话标题：脏数据的会话'), '脏会话本身仍应出现');
  assert.ok(text.includes('（此会话没有可显示的消息）'));
  assert.ok(notes.some((note) => note.message.includes('共 2 个会话')), JSON.stringify(notes));
});

test('前端传入的空选项（undefined）不会破坏默认行为', async () => {
  const { text } = await run(json(genericMessages()), {
    layout: undefined, timestamps: undefined, roleNames: undefined, includeThinking: undefined,
    includeTitles: undefined, roleFilter: undefined, conversationIds: undefined, oneFilePerConversation: undefined, encoding: undefined,
  });
  assert.ok(text.includes('会话标题'), 'layout 为 undefined 时应回落到 chat');
  assert.ok(text.includes('我：'));
});

test('选项里带 to: markdown / ndjson 这类别名也能落到正确格式', async () => {
  const md = await run(json(genericMessages()), { to: 'markdown' });
  assert.match(md.result.files[0].name, /\.md$/);
  const ndjson = await run(json(genericMessages()), { to: 'ndjson' });
  assert.match(ndjson.result.files[0].name, /\.jsonl$/);
});

test('未知输出格式回落到 txt，不会崩', async () => {
  const { result } = await run(json(genericMessages()), { to: 'docx' });
  assert.match(result.files[0].name, /\.txt$/);
});
