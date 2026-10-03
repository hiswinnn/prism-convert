/**
 * AI 聊天记录导出（JSON / JSONL）→ 人类可读文本。
 *
 * 为什么一家家写解析器，而不是统一「在对象树里找最大的 messages 数组」：
 * 各家导出的字段名、时间单位、分支结构都不一样（ChatGPT 的 mapping 是棵带分支的树、
 * 豆包是 sections 套 conversations、Gemini Takeout 把整段对话压进 subtasks），
 * 通用发现器认出的角色与顺序经常是错的。所以先按指纹精确识别，认不出才退回发现器兜底。
 *
 * 错误码（引擎只认 ConversionError）：
 *   CHAT_FORMAT_UNKNOWN —— 空输入、不是合法 JSON/JSONL、或结构里找不到任何会话。
 */
/** @typedef {import('./types.js').Api} Api */

import { fail } from './errors.js';
import { lastEncodeWarning } from './encoding.js';
import {
  sanitizeFileName, uniqueFileName, stringifyCsv, htmlEscape, mimeOfExt, formatBytes, textStats,
} from './util.js';

/** 来源指纹。界面要用徽标展示，所以 id 给机器、label 给人 */
const SOURCE_LABELS = {
  chatgpt: 'ChatGPT 导出',
  deepseek: 'DeepSeek 导出',
  claude: 'Claude 导出',
  nested: '豆包/通义类导出',
  gemini: 'Gemini 活动记录（Takeout）',
  generic: '通用 [{role,content}]',
  discovered: '自动发现的会话结构',
  jsonl: 'JSON Lines',
  messenger: 'QQ / 微信 文本记录',
};

export const meta = {
  id: 'chat-export',
  category: 'chat',
  label: 'AI 聊天记录',
  from: ['json', 'jsonl'],
  to: ['txt', 'md', 'html', 'jsonl', 'csv'],
  priority: 95,
  options: [
    { key: 'layout', type: 'select', label: '排版', default: 'chat', choices: [
      { value: 'chat', label: '对话体（分角色）' },
      { value: 'transcript', label: '带标题的誊录稿' },
      { value: 'plain', label: '纯正文（去掉角色标记）' },
      { value: 'timeline', label: '时间线扁平' },
    ] },
    { key: 'timestamps', type: 'boolean', label: '保留时间', default: true },
    { key: 'roleNames', type: 'boolean', label: '用「我 / AI」代替 user / assistant', default: true },
    { key: 'includeThinking', type: 'boolean', label: '保留思考过程/工具调用', default: true },
    { key: 'includeTitles', type: 'boolean', label: '会话标题作为分隔', default: true },
    { key: 'roleFilter', type: 'select', label: '导出哪些角色', default: 'all', choices: [
      { value: 'all', label: '全部' },
      { value: 'user', label: '只要我的提问' },
      { value: 'assistant', label: '只要 AI 回答' },
    ] },
    { key: 'conversationIds', type: 'text', label: '只导出指定会话（序号，逗号分隔，如 1,3；留空=全部）', default: '' },
    { key: 'includeSystem', type: 'boolean', label: '保留系统提示词', default: false },
    { key: 'oneFilePerConversation', type: 'boolean', label: '每个会话单独一个文件', default: false },
    { key: 'encoding', type: 'encoding', label: '输出编码', default: 'utf-8' },
  ],
};

const UNKNOWN_FORMAT_MESSAGE =
  '没认出这是哪家的聊天记录导出格式。可以试试：ChatGPT 的 conversations.json、Claude 导出、DeepSeek/豆包导出，或 [{role,content}] 这样的数组。';

/** 标题分隔线。宽度固定，避免长短标题把版式拉花 */
const RULE = '─'.repeat(32);
const TARGETS = new Set(['txt', 'md', 'html', 'jsonl', 'csv']);
const LAYOUTS = new Set(['chat', 'transcript', 'plain', 'timeline']);

// 大文件兜底阈值：JSON 必须整体 parse，没法真流式；超过就限制会话数并如实报告
const HUGE_FILE_BYTES = 30 * 1024 * 1024;
const HUGE_FILE_LIMIT = 200;
const LARGE_FILE_BYTES = 8 * 1024 * 1024;
const LARGE_FILE_LIMIT = 2000;
const DISCOVERY_MAX_DEPTH = 6;
const DISCOVERY_MAX_NODES = 20000;

/** includeThinking=false 时要剔掉的内容：思考过程与工具调用不属于「对话正文」 */
const THINKING_KINDS = new Set(['thinking', 'tool_use', 'tool_result']);

const ROLE_ALIASES = new Map(Object.entries({
  user: 'user', human: 'user', prompt: 'user', '我': 'user', '你': 'user', '用户': 'user', 提问: 'user',
  assistant: 'assistant', ai: 'assistant', bot: 'assistant', model: 'assistant', gpt: 'assistant',
  '机器人': 'assistant', '助手': 'assistant', '模型': 'assistant', 回答: 'assistant',
  system: 'system', developer: 'system', '系统': 'system', 指令: 'system',
  tool: 'tool', function: 'tool', observation: 'tool', '工具': 'tool',
}));

const MESSAGE_ROLE_KEYS = ['role', 'from', 'sender', 'speaker', 'author'];
const MESSAGE_CONTAINER_KEYS = [
  'messages', 'message_list', 'msgs', 'conversation', 'chat', 'history', 'chat_messages',
  'turns', 'dialogue', 'items', 'list', 'records',
];

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/** @param {import('./types.js').Input} input @param {Api} api */
export async function convert(input, api) {
  const notes = [];
  const note = (level, message) => {
    notes.push({ level, message });
    if (typeof api.note === 'function') api.note(level, message);
  };

  const bytes = typeof api.bytes === 'function' ? api.bytes() : null;
  if (!bytes || bytes.length === 0) {
    fail('CHAT_FORMAT_UNKNOWN', '文件是空的，没有可以转换的聊天内容。');
  }
  const declaredSize = Number(api.input?.size) > 0 ? Number(api.input.size) : bytes.length;

  api.progress(0.05, '读取文本');
  const text = api.text();
  if (!text.trim()) {
    fail('CHAT_FORMAT_UNKNOWN', '文件里只有空白字符，没有可以转换的聊天内容。');
  }

  api.progress(0.15, '识别导出格式');
  const parsed = parseChatExport(text);
  const opts = prepareOptions(api);
  let conversations = parsed.conversations;

  if (parsed.skipped > 0) {
    note('warn', `跳过了 ${parsed.skipped} 个无法解析的会话。`);
  }

  // 序号对应 inspect() 的数组顺序，所以先在完整列表上挑选，再做超大文件截断
  if (opts.conversationIds.length) {
    const total = conversations.length;
    const missing = opts.conversationIds.filter((id) => id > total);
    const wanted = new Set(opts.conversationIds);
    conversations = conversations.filter((_conv, index) => wanted.has(index + 1));
    if (missing.length) note('warn', `忽略了不存在的会话序号 ${missing.join('、')}。`);
  }

  const limit = declaredSize > HUGE_FILE_BYTES ? HUGE_FILE_LIMIT
    : (declaredSize > LARGE_FILE_BYTES ? LARGE_FILE_LIMIT : Infinity);
  if (conversations.length > limit) {
    note('warn', `文件较大（${formatBytes(declaredSize)}），为避免浏览器卡死只解析了前 ${limit} 个会话，其余已忽略。`);
    conversations = conversations.slice(0, limit);
  }

  api.progress(0.6, '整理会话');
  // 只要提问 / 只要回答：整条不剩的会话直接丢掉，免得输出里留下只有标题的空壳
  if (opts.roleFilter !== 'all') {
    const kept = [];
    let emptied = 0;
    for (const conv of conversations) {
      const messages = conv.messages.filter((message) => message.role === opts.roleFilter);
      if (!messages.length) {
        emptied += 1;
        continue;
      }
      kept.push({ ...conv, messages });
    }
    conversations = kept;
    if (emptied > 0) note('warn', `按角色筛选后跳过了 ${emptied} 个没有内容的会话。`);
  }

  const filtered = dropThinking(conversations, opts.includeThinking);
  if (filtered.dropped > 0) {
    note('warn', `按设置过滤了 ${filtered.dropped} 条思考过程/工具调用。`);
  }
  conversations = filtered.conversations;

  // 系统提示词（"You are a helpful assistant."）对读的人是噪音，默认不导出。
  // 但它往往是理解模型行为的线索，所以给一个开关，而不是硬编码丢掉。
  if (!opts.includeSystem) {
    let systemDropped = 0;
    conversations = conversations.map((conv) => {
      const messages = conv.messages.filter((message) => message.role !== 'system');
      systemDropped += conv.messages.length - messages.length;
      return { ...conv, messages };
    });
    if (systemDropped > 0) note('info', `已略过 ${systemDropped} 条系统提示（可在导出设置里选择保留）。`);
  }

  if (!conversations.length) {
    note('warn', '筛选后没有剩下任何会话，输出文件为空。');
  } else if (conversations.every((conv) => conv.messages.length === 0)) {
    note('warn', '这些会话里没有可显示的正文内容，输出文件只包含标题。');
  }
  note('info', `识别为「${sourceLabel(parsed.provider)}」，共 ${conversations.length} 个会话、${countMessages(conversations)} 条消息。`);

  api.progress(0.8, '生成文本');
  // encoding.js 的降级告警是模块级共享状态，先清掉避免把上一次转换的告警算到这次头上
  lastEncodeWarning.value = null;
  const built = buildFiles(conversations, opts, api);
  if (lastEncodeWarning.value && lastEncodeWarning.value.dropped > 0) {
    note('warn', `${opts.encoding} 编码无法表示 ${lastEncodeWarning.value.dropped} 个字符，已替换为 ?。`);
  }

  const stats = textStats(built.previewText);
  note('info', `输出 ${stats.lines} 行，约 ${stats.cjk} 个汉字 / ${stats.chars} 个字符。`);

  api.progress(1, '完成');
  return { files: built.files, preview: built.previewText.slice(0, 2000), notes };
}

/**
 * 只做识别与结构统计，不生成文件：界面用它渲染会话列表、来源徽标与预览。
 * 与 convert 共用 parseChatExport，避免两套解析逻辑走偏。
 * @param {import('./types.js').Input} input @param {Api} api
 */
export function inspect(input, api) {
  const bytes = typeof api.bytes === 'function' ? api.bytes() : null;
  if (!bytes || bytes.length === 0) {
    fail('CHAT_FORMAT_UNKNOWN', '文件是空的，没有可以识别的聊天内容。');
  }
  const text = api.text();
  if (!text.trim()) {
    fail('CHAT_FORMAT_UNKNOWN', '文件里只有空白字符，没有可以识别的聊天内容。');
  }
  const parsed = parseChatExport(text);
  return {
    provider: parsed.provider,
    providerLabel: sourceLabel(parsed.provider),
    conversations: parsed.conversations.map(summarizeConversation),
  };
}

function summarizeConversation(conv) {
  const roleCounts = { user: 0, assistant: 0, system: 0, other: 0 };
  const modelNames = [];
  for (const message of conv.messages) {
    const bucket = message.role === 'user' || message.role === 'assistant' || message.role === 'system'
      ? message.role
      : 'other';
    roleCounts[bucket] += 1;
    if (message.name && (message.role === 'assistant' || message.role === 'tool') && !modelNames.includes(message.name)) {
      modelNames.push(message.name);
    }
  }
  const first = conv.messages.find((message) => message.text.trim());
  return {
    title: conv.title,
    createdAt: conv.createdAt ? conv.createdAt.getTime() : null,
    updatedAt: conv.updatedAt ? conv.updatedAt.getTime() : null,
    messageCount: conv.messages.length,
    roleCounts,
    preview: first ? first.text.trim().slice(0, 120) : '',
    modelNames,
  };
}

function sourceLabel(provider) {
  return SOURCE_LABELS[provider] ?? '未知来源';
}

function prepareOptions(api) {
  const layout = String(api.opt('layout', 'chat') ?? 'chat').toLowerCase();
  const encoding = String(api.opt('encoding', 'utf-8') ?? 'utf-8').toLowerCase();
  const roleFilter = String(api.opt('roleFilter', 'all') ?? 'all').toLowerCase();
  return {
    target: resolveTarget(api),
    layout: LAYOUTS.has(layout) ? layout : 'chat',
    timestamps: api.opt('timestamps', true) !== false,
    roleNames: api.opt('roleNames', true) !== false,
    includeThinking: api.opt('includeThinking', true) !== false,
    includeTitles: api.opt('includeTitles', true) !== false,
    includeSystem: api.opt('includeSystem', false) === true,
    roleFilter: roleFilter === 'user' || roleFilter === 'assistant' ? roleFilter : 'all',
    conversationIds: parseConversationIds(api.opt('conversationIds', '')),
    oneFilePerConversation: api.opt('oneFilePerConversation', false) === true,
    // 'auto' 是解码侧的概念，编码侧传进去会让 encodeText 抛「不支持输出编码」
    encoding: encoding === 'auto' || !encoding ? 'utf-8' : encoding,
  };
}

/** 「1,3；2」这类输入容错：中文逗号、空格、分号都当分隔符，序号去重后升序 */
function parseConversationIds(raw) {
  if (raw === null || raw === undefined) return [];
  const tokens = String(raw).split(/[,，;；\s]+/).filter(Boolean);
  const ids = new Set();
  for (const token of tokens) {
    const value = Number(token);
    if (Number.isInteger(value) && value > 0) ids.add(value);
  }
  return [...ids].sort((a, b) => a - b);
}

const TARGET_ALIASES = new Map(Object.entries({
  txt: 'txt', text: 'txt', plain: 'txt', md: 'md', markdown: 'md', html: 'html', htm: 'html',
  jsonl: 'jsonl', ndjson: 'jsonl', jsonlines: 'jsonl', csv: 'csv',
}));

/**
 * 契约没有规定「目标格式」从哪个入口取（api 表里没有 to/target），
 * 所以这里多路探测；全都取不到时按人类的默认期待落到 txt。
 */
function resolveTarget(api) {
  const raw = api.opt?.('to') ?? api.opt?.('target') ?? api.target ?? api.outputFormat
    ?? api.input?.target ?? api.input?.to ?? '';
  const target = TARGET_ALIASES.get(String(raw).trim().toLowerCase());
  return target && TARGETS.has(target) ? target : 'txt';
}

/* ------------------------------------------------------------------ *
 * 输入解析：按来源指纹依次尝试
 * ------------------------------------------------------------------ */

function parseChatExport(text) {
  const trimmed = text.trim();
  const ctx = { skipped: 0 };
  let jsonError = null;
  let root;
  try {
    root = JSON.parse(trimmed);
  } catch (err) {
    jsonError = err;
  }
  if (jsonError === null) {
    const found = parseConversations(root, ctx);
    if (found) return withCanonicalOrder({ ...found, skipped: ctx.skipped });
  }
  const jsonl = parseJsonlConversations(trimmed, ctx);
  if (jsonl) return withCanonicalOrder({ ...jsonl, skipped: ctx.skipped });
  const messenger = parseMessengerText(trimmed);
  if (messenger) return withCanonicalOrder({ ...messenger, skipped: ctx.skipped });
  fail('CHAT_FORMAT_UNKNOWN', UNKNOWN_FORMAT_MESSAGE, {
    detail: jsonError ? `JSON 解析失败：${jsonError.message}` : '结构里没有找到会话',
  });
}

/**
 * 会话统一按起始时间升序、没有时间的排最后（原地顺序稳定）。
 * convert 的 conversationIds 序号与 inspect() 返回的数组顺序都基于这里，
 * 两边一旦不一致，界面点「第 3 个会话」就会导错文件。
 */
function withCanonicalOrder(result) {
  const ordered = result.conversations
    .map((conv, index) => ({ conv, index }))
    .sort((a, b) => {
      const left = a.conv.createdAt ? a.conv.createdAt.getTime() : null;
      const right = b.conv.createdAt ? b.conv.createdAt.getTime() : null;
      if (left === null && right === null) return a.index - b.index;
      if (left === null) return 1;
      if (right === null) return -1;
      return left === right ? a.index - b.index : left - right;
    })
    .map((entry) => entry.conv);
  return { ...result, conversations: ordered };
}

function parseConversations(root, ctx) {
  const candidates = expandCandidates(root);
  const parsers = [
    parseMappingExport,      // 1 ChatGPT / 3 DeepSeek（mapping 树）
    parseClaudeExport,       // 2 Claude
    parseNestedSections,     // 4 豆包 / 通义 / 文心 / Kimi（sections 套 conversations）
    parseGeminiActivity,     // 5 Gemini Takeout
    parseGenericMessages,    // 6 通用 messages 数组
    discoverMessagesByTree,  // 兜底：在对象树里找 message-like 数组
  ];
  for (const parser of parsers) {
    for (const candidate of candidates) {
      const found = parser(candidate, ctx);
      if (found && found.conversations.length) return found;
    }
  }
  return null;
}

/** 常见的包装层：{data:{...}} / {conversations:[...]} / {result:{...}} */
function expandCandidates(root) {
  const out = [];
  const seen = new Set();
  const visit = (value, depth) => {
    if (value === null || typeof value !== 'object' || seen.has(value) || depth > 3) return;
    seen.add(value);
    out.push(value);
    if (Array.isArray(value)) return;
    for (const key of ['data', 'result', 'payload', 'export', 'exportData', 'response', 'conversations', 'sessions', 'records', 'list', 'items']) {
      if (key in value) visit(value[key], depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

function safeBuild(build, ctx) {
  try {
    const conv = build();
    if (!conv) return null;
    return conv;
  } catch {
    // 单个会话脏数据不该毁掉整次转换：记数跳过，最后统一报告
    ctx.skipped += 1;
    return null;
  }
}

/* ---------------- 1 / 3. ChatGPT & DeepSeek：mapping 树 ---------------- */

function looksLikeMappingConversation(item) {
  if (!isObject(item) || !isObject(item.mapping) || Object.keys(item.mapping).length === 0) return false;
  return typeof item.title === 'string' || item.create_time !== undefined || item.update_time !== undefined
    || item.inserted_at !== undefined || item.created_at !== undefined || item.current_node !== undefined;
}

function parseMappingExport(value, ctx) {
  const items = (Array.isArray(value) ? value : [value]).filter(looksLikeMappingConversation);
  if (!items.length) return null;
  const conversations = [];
  for (const item of items) {
    const conv = safeBuild(() => conversationFromMapping(item), ctx);
    if (conv) conversations.push(conv);
  }
  if (!conversations.length) return null;
  // DeepSeek 用 inserted_at，ChatGPT 用 create_time/current_node
  const provider = items.some((i) => i.inserted_at !== undefined && i.create_time === undefined) ? 'deepseek' : 'chatgpt';
  return { provider, conversations };
}

function conversationFromMapping(item) {
  const nodes = orderMappingNodes(item.mapping, item.current_node);
  const messages = [];
  for (const node of nodes) {
    const built = messagesFromMappingNode(node);
    if (built) messages.push(...built);
  }
  return {
    title: cleanTitle(item.title ?? item.name ?? '未命名会话'),
    createdAt: parseTimestamp(item.create_time ?? item.inserted_at ?? item.created_at),
    updatedAt: parseTimestamp(item.update_time ?? item.updated_at),
    messages,
  };
}

/**
 * 还原真实顺序。mapping 是一棵有分支的树（编辑/重新生成会产生兄弟节点），
 * 直接 Object.keys 的顺序或全树 DFS 都会把被放弃的分支一起输出。
 */
function orderMappingNodes(mapping, currentNodeId) {
  const nodes = new Map();
  for (const [key, node] of Object.entries(mapping)) {
    if (!isObject(node)) continue;
    nodes.set(String(node.id ?? key), node);
  }
  if (!nodes.size) return [];

  // current_node 是用户在界面上停留的那条线，沿 parent 回溯才等于「他看到的对话」
  if (currentNodeId !== undefined && nodes.has(String(currentNodeId))) {
    const path = [];
    const seen = new Set();
    let cursor = String(currentNodeId);
    while (cursor && nodes.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const node = nodes.get(cursor);
      path.push(node);
      cursor = node.parent === null || node.parent === undefined ? '' : String(node.parent);
    }
    if (path.length) return path.reverse();
  }

  // 没有 current_node（DeepSeek 等）：从根沿「最深子树」下行，被放弃的短分支就不会混进来
  const roots = [...nodes.values()].filter((node) => node.parent === null || node.parent === undefined || !nodes.has(String(node.parent)));
  if (!roots.length) {
    return [...nodes.values()].sort((a, b) => (parseTimestamp(a.message?.create_time)?.getTime() ?? 0) - (parseTimestamp(b.message?.create_time)?.getTime() ?? 0));
  }
  const depthMemo = new Map();
  const order = [];
  const seen = new Set();
  let cursor = roots[0];
  while (cursor && !seen.has(String(cursor.id))) {
    seen.add(String(cursor.id));
    order.push(cursor);
    const children = (Array.isArray(cursor.children) ? cursor.children : [])
      .map((id) => nodes.get(String(id)))
      .filter((child) => child && !seen.has(String(child.id)));
    if (!children.length) break;
    children.sort((a, b) => nodeDepth(a, nodes, depthMemo) - nodeDepth(b, nodes, depthMemo));
    cursor = children[children.length - 1];
  }
  return order;
}

function nodeDepth(node, nodes, memo) {
  const key = String(node.id);
  if (memo.has(key)) return memo.get(key);
  memo.set(key, 0); // 脏数据可能有环，先占位避免无限递归
  const children = (Array.isArray(node.children) ? node.children : [])
    .map((id) => nodes.get(String(id)))
    .filter(Boolean);
  const depth = children.length ? 1 + Math.max(...children.map((child) => nodeDepth(child, nodes, memo))) : 0;
  memo.set(key, depth);
  return depth;
}

function messagesFromMappingNode(node) {
  const message = node.message;
  if (!isObject(message)) return null;
  const metadata = isObject(message.metadata) ? message.metadata : {};
  // 自定义指令/隐藏节点不是对话内容，各版本字段名不同
  if (metadata.is_visually_hidden_from_conversation === true) return null;
  const contentType = String(message.content?.content_type ?? '');
  if (contentType === 'user_editable_context') return null;

  const role = normalizeRole(message.author?.role ?? message.author?.name);
  const name = typeof metadata.model_slug === 'string' && metadata.model_slug
    ? metadata.model_slug
    : (role === 'assistant' && typeof message.author?.name === 'string' ? message.author.name : undefined);
  const time = parseTimestamp(message.create_time ?? node.create_time ?? metadata.timestamp_);
  const kind = mappingKind(role, contentType);
  // 工具类节点（author.role=tool / execution_output）整条都算工具结果，正文片段也要跟着改 kind
  const segments = mappingContentSegments(message.content, contentType, metadata)
    .map((segment) => ({ ...segment, kind: segment.kind === 'text' ? kind : segment.kind }));
  return composeMessages(role, name, time, segments);
}

function mappingKind(role, contentType) {
  if (role === 'tool') return 'tool_result';
  if (contentType === 'execution_output') return 'tool_result';
  if (contentType === 'tether_browsing_display' || contentType === 'tether_search_query' || contentType === 'tether_browsing_code') return 'tool_result';
  return 'text';
}

function mappingContentSegments(content, contentType, metadata) {
  const segments = [];
  if (!isObject(content)) return segments;

  if (contentType === 'code') {
    const code = typeof content.text === 'string' ? content.text : extractText(content.parts);
    if (code) segments.push({ kind: mappingKind('assistant', 'code'), text: fencedCode(code, content.language ?? metadata.lang ?? '') });
    return segments;
  }
  if (contentType === 'tether_quote') {
    const heading = ['【引用】', content.title ?? '', content.url ? `\n${content.url}` : ''].join('');
    const body = typeof content.text === 'string' ? `\n${content.text}` : '';
    segments.push({ kind: 'text', text: `${heading}${body}`.trim() });
    return segments;
  }
  if (contentType === 'tether_browsing_display' || contentType === 'tether_search_query') {
    const body = typeof content.text === 'string' && content.text
      ? content.text
      : extractText(content.result ?? content.summary ?? '');
    if (body) segments.push({ kind: 'text', text: body });
    return segments;
  }
  if (contentType === 'execution_output') {
    const body = typeof content.text === 'string' ? content.text : extractText(content.parts);
    if (body) segments.push({ kind: 'text', text: body });
    return segments;
  }

  for (const part of Array.isArray(content.parts) ? content.parts : []) {
    if (typeof part === 'string') {
      if (part) segments.push({ kind: 'text', text: part });
      continue;
    }
    if (!isObject(part)) continue;
    const partType = String(part.content_type ?? '');
    if (partType === 'image_asset_pointer' || partType === 'audio_asset_pointer' || part.asset_pointer) {
      segments.push({ kind: 'text', text: partType === 'audio_asset_pointer' ? '[语音]' : '[图片]' });
      continue;
    }
    if (typeof part.text === 'string' && part.text) segments.push({ kind: 'text', text: part.text });
  }
  if (!segments.length && typeof content.text === 'string' && content.text) {
    segments.push({ kind: 'text', text: content.text });
  }
  return segments;
}

/* ---------------- 2. Claude 导出 ---------------- */

function parseClaudeExport(value, ctx) {
  const items = (Array.isArray(value) ? value : [value])
    .filter((item) => isObject(item) && Array.isArray(item.chat_messages));
  if (!items.length) return null;
  const conversations = [];
  for (const item of items) {
    const conv = safeBuild(() => {
      const messages = [];
      for (const raw of item.chat_messages) {
        const built = messagesFromClaudeMessage(raw);
        if (built) messages.push(...built);
      }
      return {
        title: cleanTitle(item.name ?? item.title ?? '未命名会话'),
        createdAt: parseTimestamp(item.created_at),
        updatedAt: parseTimestamp(item.updated_at),
        messages,
      };
    }, ctx);
    if (conv) conversations.push(conv);
  }
  return conversations.length ? { provider: 'claude', conversations } : null;
}

function messagesFromClaudeMessage(raw) {
  if (!isObject(raw)) return null;
  const role = normalizeRole(raw.sender ?? raw.role ?? 'unknown');
  const name = typeof raw.model === 'string' && raw.model ? raw.model : undefined;
  const time = parseTimestamp(raw.created_at ?? raw.updated_at);
  const segments = [];
  for (const part of Array.isArray(raw.content) ? raw.content : []) {
    if (typeof part === 'string') {
      if (part) segments.push({ kind: 'text', text: part });
      continue;
    }
    if (!isObject(part)) continue;
    const type = String(part.type ?? '');
    if (type === 'thinking' || type === 'redacted_thinking') {
      segments.push({ kind: 'thinking', text: part.thinking ?? part.text ?? '' });
    } else if (type === 'tool_use') {
      segments.push({ kind: 'tool_use', text: [`调用工具 ${part.name ?? ''}`.trim(), stringifyToolInput(part.input)].filter(Boolean).join('\n') });
    } else if (type === 'tool_result') {
      segments.push({ kind: 'tool_result', text: extractText(part.content ?? part.text) });
    } else if (typeof part.text === 'string') {
      segments.push({ kind: 'text', text: part.text });
    }
  }
  // Claude 导出里 text 是展示用正文，content 可能只留了 thinking/tool_use，此时仍需保底
  if (typeof raw.text === 'string' && raw.text.trim() && !segments.some((s) => s.kind === 'text')) {
    segments.push({ kind: 'text', text: raw.text });
  }
  const attachments = attachmentLine(raw);
  if (attachments) segments.push({ kind: 'text', text: attachments });
  return composeMessages(role, name, time, segments);
}

function attachmentLine(raw) {
  const files = [...(Array.isArray(raw.attachments) ? raw.attachments : []), ...(Array.isArray(raw.files) ? raw.files : [])];
  const names = files
    .map((file) => (isObject(file) ? file.file_name ?? file.name ?? file.file_type : file))
    .filter((name) => typeof name === 'string' && name.trim());
  return names.length ? `[附件：${names.join('、')}]` : '';
}

/* ---------------- 4. 豆包 / 通义 / 文心 / Kimi：sections 嵌套 ---------------- */

function parseNestedSections(value, ctx) {
  const sections = findSectionsArray(value);
  if (!sections) return null;
  const conversations = [];
  for (const section of sections) {
    if (!isObject(section)) continue;
    const heading = cleanTitle(section.title ?? section.name ?? section.subject ?? '');
    const groups = [section.conversations, section.chats, section.chat_list, section.items, section.sessions].find(Array.isArray);
    if (groups) {
      for (const group of groups) {
        if (!isObject(group)) continue;
        const messages = pickMessagesArray(group);
        if (!messages) continue;
        const conv = safeBuild(() => conversationFromMessages(cleanTitle(group.title ?? group.name ?? heading ?? '对话'), messages, group), ctx);
        if (conv) conversations.push(conv);
      }
      continue;
    }
    const messages = pickMessagesArray(section);
    if (!messages) continue;
    const conv = safeBuild(() => conversationFromMessages(heading || '对话', messages, section), ctx);
    if (conv) conversations.push(conv);
  }
  return conversations.length ? { provider: 'nested', conversations } : null;
}

function findSectionsArray(value) {
  const queue = [[value, 0]];
  const seen = new Set();
  while (queue.length) {
    const [node, depth] = queue.shift();
    if (!isObject(node) || seen.has(node) || depth > 3) continue;
    seen.add(node);
    if (Array.isArray(node.sections)) return node.sections;
    if (Array.isArray(node.section)) return node.section;
    for (const key of ['data', 'result', 'payload', 'content', 'response']) {
      if (key in node) queue.push([node[key], depth + 1]);
    }
  }
  return null;
}

function pickMessagesArray(container) {
  if (!isObject(container)) return null;
  for (const key of MESSAGE_CONTAINER_KEYS) {
    const candidate = container[key];
    if (Array.isArray(candidate) && isMessageArray(candidate)) return candidate;
  }
  return null;
}

/* ---------------- 5. Gemini Takeout（MyActivity.json） ---------------- */

function looksLikeGeminiActivity(item) {
  if (!isObject(item) || !Array.isArray(item.subtasks)) return false;
  return item.time !== undefined || typeof item.title === 'string' || Array.isArray(item.products);
}

function parseGeminiActivity(value, ctx) {
  const items = (Array.isArray(value) ? value : [value]).filter(looksLikeGeminiActivity);
  if (!items.length) return null;
  const conversations = [];
  items.forEach((activity, index) => {
    const messages = [];
    for (const subtask of activity.subtasks) {
      if (!isObject(subtask)) continue;
      const snippets = Array.isArray(subtask.snippets) ? subtask.snippets : [];
      const text = snippets
        .map((snippet) => (isObject(snippet) ? snippet.name ?? snippet.text ?? '' : String(snippet ?? '')))
        .filter((line) => line && line.trim())
        .join('\n');
      if (!text) continue;
      const speaker = String(subtask.title ?? '').trim();
      const role = /^(你|您|我|you)$/i.test(speaker) ? 'user' : 'assistant';
      messages.push({ role, name: role === 'assistant' && speaker ? speaker : undefined, time: parseTimestamp(subtask.time), text, kind: 'text' });
    }
    if (!messages.length) return;
    const conv = safeBuild(() => ({
      title: cleanTitle(activity.title ?? `Gemini 对话 ${index + 1}`),
      createdAt: parseTimestamp(activity.time),
      updatedAt: null,
      messages,
    }), ctx);
    if (conv) conversations.push(conv);
  });
  return conversations.length ? { provider: 'gemini', conversations } : null;
}

/* ---------------- 6. 通用 messages 数组 ---------------- */

function parseGenericMessages(value, ctx) {
  const groups = [];
  if (Array.isArray(value)) {
    if (isMessageArray(value)) groups.push({ title: '', messages: value });
  } else if (isObject(value)) {
    const title = cleanTitle(value.title ?? value.name ?? value.subject ?? value.topic ?? '');
    for (const key of MESSAGE_CONTAINER_KEYS) {
      const candidate = value[key];
      if (Array.isArray(candidate) && isMessageArray(candidate)) groups.push({ title, messages: candidate });
      // {conversation:{messages:[…]}} 这类再套一层的形态
      else if (isObject(candidate)) {
        const nested = pickMessagesArray(candidate);
        if (nested) groups.push({ title: cleanTitle(candidate.title ?? candidate.name ?? title), messages: nested });
      }
    }
  }
  const conversations = [];
  for (const group of groups) {
    const conv = safeBuild(() => conversationFromMessages(group.title || '聊天记录', group.messages, null), ctx);
    if (conv) conversations.push(conv);
  }
  return conversations.length ? { provider: 'generic', conversations } : null;
}

function conversationFromMessages(title, rawMessages, container) {
  const messages = [];
  for (const raw of rawMessages) {
    const built = messageFromGeneric(raw);
    if (built) messages.push(...built);
  }
  return {
    title: cleanTitle(title || '聊天记录'),
    createdAt: parseTimestamp(container?.created_at ?? container?.create_time ?? container?.createdAt),
    updatedAt: parseTimestamp(container?.updated_at ?? container?.update_time),
    messages,
  };
}

function messageFromGeneric(raw) {
  if (!isObject(raw)) return null;
  const role = normalizeRole(raw.role ?? raw.from ?? raw.sender ?? raw.speaker ?? raw.author?.role ?? raw.type);
  const name = firstName(raw.model, raw.model_slug, raw.author?.name, raw.name);
  const time = parseTimestamp(raw.created_at ?? raw.create_time ?? raw.createdAt ?? raw.time
    ?? raw.timestamp ?? raw.inserted_at ?? raw.date ?? raw.ts);
  const segments = [];

  const thinking = raw.reasoning_content ?? raw.reasoning ?? raw.thinking ?? raw.reasoningContent;
  if (typeof thinking === 'string' && thinking.trim()) segments.push({ kind: 'thinking', text: thinking });

  const content = raw.content ?? raw.text ?? raw.message ?? raw.value ?? raw.parts ?? raw.delta;
  const contentSegments = genericContentSegments(content);
  segments.push(...contentSegments);

  for (const call of Array.isArray(raw.tool_calls) ? raw.tool_calls : []) {
    const fn = isObject(call) ? call.function ?? call : null;
    const label = fn ? fn.name ?? '' : call?.name ?? '';
    segments.push({ kind: 'tool_use', text: [`调用工具 ${label}`.trim(), stringifyToolInput(fn?.arguments ?? fn?.input ?? call?.input)].filter(Boolean).join('\n') });
  }
  if (isObject(raw.function_call)) {
    segments.push({ kind: 'tool_use', text: [`调用工具 ${raw.function_call.name ?? ''}`.trim(), stringifyToolInput(raw.function_call.arguments)].filter(Boolean).join('\n') });
  }

  const attachments = attachmentLine(raw);
  if (attachments) segments.push({ kind: 'text', text: attachments });

  return composeMessages(role, name, time, segments);
}

function genericContentSegments(content) {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content.trim() ? [{ kind: 'text', text: content }] : [];
  if (Array.isArray(content)) {
    const segments = [];
    for (const part of content) {
      if (typeof part === 'string') {
        if (part.trim()) segments.push({ kind: 'text', text: part });
        continue;
      }
      if (!isObject(part)) continue;
      if (typeof part.text === 'string' && part.text.trim()) segments.push({ kind: 'text', text: part.text });
      else if (typeof part.content === 'string' && part.content.trim()) segments.push({ kind: 'text', text: part.content });
    }
    return segments;
  }
  if (isObject(content)) {
    if (typeof content.text === 'string' && content.text.trim()) return [{ kind: 'text', text: content.text }];
    if (typeof content.content === 'string' && content.content.trim()) return [{ kind: 'text', text: content.content }];
    if (Array.isArray(content.parts)) return genericContentSegments(content.parts);
    const text = extractText(content);
    return text.trim() ? [{ kind: 'text', text }] : [];
  }
  return [];
}

function isMessageLike(record) {
  if (!isObject(record)) return false;
  const hasRole = MESSAGE_ROLE_KEYS.some((key) => typeof record[key] === 'string' || isObject(record[key]) && typeof record[key].role === 'string');
  if (!hasRole) return false;
  const content = record.content ?? record.text ?? record.message ?? record.value ?? record.parts ?? record.delta;
  return content !== undefined || typeof record.reasoning_content === 'string' || typeof record.thinking === 'string';
}

function isMessageArray(array) {
  if (!Array.isArray(array) || !array.length) return false;
  const like = array.filter(isMessageLike).length;
  return like >= Math.max(1, Math.ceil(array.length * 0.6));
}

/* ---------------- 兜底：在对象树里找 message-like 数组 ---------------- */

function discoverMessagesByTree(root, ctx) {
  const found = [];
  const queue = [{ node: root, depth: 0, title: '' }];
  const seen = new Set();
  let visited = 0;
  while (queue.length) {
    const { node, depth, title } = queue.shift();
    if (node === null || typeof node !== 'object' || seen.has(node) || depth > DISCOVERY_MAX_DEPTH) continue;
    seen.add(node);
    visited += 1;
    if (visited > DISCOVERY_MAX_NODES) break;
    if (Array.isArray(node)) {
      // 一条消息的会话也是合法会话，所以只要整条数组都像消息就认
      if (isMessageArray(node)) {
        found.push({ title, messages: node });
        continue; // 命中后不再下钻，避免把同一段对话拆成许多碎片
      }
      for (const item of node) {
        if (item && typeof item === 'object') queue.push({ node: item, depth: depth + 1, title });
      }
      continue;
    }
    const localTitle = firstName(node.title, node.name, node.subject, node.topic);
    const nextTitle = localTitle ? cleanTitle(localTitle) : title;
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (child && typeof child === 'object') queue.push({ node: child, depth: depth + 1, title: nextTitle });
    }
  }
  if (!found.length) return null;
  const conversations = [];
  found.forEach((entry, index) => {
    const conv = safeBuild(() => conversationFromMessages(entry.title || `会话 ${index + 1}`, entry.messages, null), ctx);
    if (conv && conv.messages.length) conversations.push(conv);
  });
  return conversations.length ? { provider: 'discovered', conversations } : null;
}

/* ---------------- 7. JSONL ---------------- */

function parseJsonlConversations(text, ctx) {
  const lines = text.split(/\r?\n/);
  if (lines.filter((line) => line.trim()).length < 2) return null;
  const records = [];
  let badLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      badLines += 1;
    }
  }
  if (badLines > 0 || records.length < 2) return null;

  // 每行一条消息（OpenAI 风格 log）→ 整体算一个会话
  if (isMessageArray(records)) {
    const conv = safeBuild(() => conversationFromMessages('JSONL 会话', records, null), ctx);
    return conv ? { provider: 'jsonl', conversations: [conv] } : null;
  }
  // 每行一个会话的 jsonl
  const conversations = [];
  for (const record of records) {
    const found = parseConversations(record, ctx);
    if (found) conversations.push(...found.conversations);
  }
  return conversations.length ? { provider: 'jsonl', conversations } : null;
}

/* ---------------- 8. QQ / TIM / 微信 导出的纯文本记录 ---------------- */

const MESSENGER_DATETIME = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s+(\d{1,2}:\d{2}(?::\d{2})?)$/;
const MESSENGER_TIME = /^(\d{1,2}:\d{2}(?::\d{2})?)$/;

/** 返回 {time, speaker} 或 null；只认严格形态，避免把普通文档当成聊天记录 */
function parseMessengerHeader(line) {
  const text = line.trim();
  if (!text || text.length > 120) return null;
  let match = text.match(MESSENGER_DATETIME);
  if (match) return { time: `${match[1]} ${match[2]}`, speaker: '' };
  if (MESSENGER_TIME.test(text)) return { time: text, speaker: '' };
  match = text.match(/^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+(\S.{0,39})$/) // 2026-03-01 20:11:33 昵称(123)
    ?? text.match(/^(\S.{0,39}?)\s+(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)$/); // 昵称 2026-03-01 20:11:33
  if (match) {
    const timeFirst = /^\d{4}/.test(match[1]);
    const speaker = (timeFirst ? match[2] : match[1]).replace(/[（(][^）)]*[）)]\s*$/, '').trim();
    return { time: timeFirst ? match[1] : match[2], speaker };
  }
  match = text.match(/^(.{1,40}?)(?:[（(][^）)]{1,40}[）)])?\s+(\d{1,2}:\d{2}(?::\d{2})?)$/);
  if (match && !/[。！？，,.!?]/.test(match[1]) && !/^\d/.test(match[1])) {
    return { time: match[2], speaker: match[1].trim() };
  }
  return null;
}

function parseMessengerText(text) {
  const lines = text.split(/\r?\n/);
  const headers = [];
  lines.forEach((line, index) => {
    const header = parseMessengerHeader(line);
    if (header) headers.push({ index, ...header });
  });
  if (headers.length < 3) return null;

  const messages = [];
  let currentDate = '';
  headers.forEach((header, i) => {
    const bodyEnd = i + 1 < headers.length ? headers[i + 1].index : lines.length;
    const body = lines.slice(header.index + 1, bodyEnd).join('\n').trim();
    if (!body) return;
    if (/^\d{4}/.test(header.time)) currentDate = header.time.slice(0, 10);
    const time = header.time.length <= 8 && currentDate ? `${currentDate} ${header.time}` : header.time;
    messages.push({
      role: header.speaker ? 'user' : 'assistant',
      name: header.speaker || undefined,
      time: parseTimestamp(time),
      text: body,
      kind: 'text',
    });
  });
  if (!messages.length) return null;
  return {
    provider: 'messenger',
    conversations: [{ title: '聊天记录', createdAt: null, updatedAt: null, messages }],
  };
}

/* ------------------------------------------------------------------ *
 * 消息组装
 * ------------------------------------------------------------------ */

/** 把同一节点里的片段合成消息；同 kind 的相邻片段合并，避免一条消息被拆成好几段 */
function composeMessages(role, name, time, segments) {
  const usable = segments.filter((segment) => segment.text && String(segment.text).trim());
  if (!usable.length) return null;
  const merged = [];
  for (const segment of usable) {
    const kind = segment.kind ?? 'text';
    const last = merged[merged.length - 1];
    if (last && last.kind === kind) last.text += `\n\n${segment.text}`;
    else merged.push({ kind, text: String(segment.text) });
  }
  return merged.map((segment) => ({
    role: role ?? 'unknown',
    name: name || undefined,
    time: time ?? null,
    kind: segment.kind,
    text: segment.text.trim(),
  }));
}

function dropThinking(conversations, includeThinking) {
  if (includeThinking) return { conversations, dropped: 0 };
  let dropped = 0;
  const kept = conversations.map((conv) => ({
    ...conv,
    messages: conv.messages.filter((message) => {
      if (THINKING_KINDS.has(message.kind)) {
        dropped += 1;
        return false;
      }
      return true;
    }),
  }));
  return { conversations: kept, dropped };
}

function countMessages(conversations) {
  return conversations.reduce((sum, conv) => sum + conv.messages.length, 0);
}

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */

function buildFiles(conversations, opts, api) {
  const files = [];
  const taken = new Set();
  let previewText = '';
  const encode = (text, name) => ({
    name: api.fileName(name),
    bytes: api.encode(text, opts.encoding),
    mime: mimeOfExt(opts.target),
  });

  const renderOne = (list) => renderDocument(list, opts);

  if (opts.oneFilePerConversation && conversations.length > 1) {
    conversations.forEach((conv, index) => {
      const body = renderOne([conv]);
      if (index === 0) previewText = body;
      const name = uniqueFileName(`${sanitizeFileName(conv.title || '会话')}-${index + 1}.${opts.target}`, taken);
      files.push(encode(body, name));
    });
  } else {
    const body = renderOne(conversations);
    previewText = body;
    const stem = conversations.length === 1
      ? sanitizeFileName(conversations[0].title || '会话记录')
      : sanitizeFileName(conversations.length ? `会话记录-${conversations.length}个会话` : '会话记录');
    files.push(encode(body, uniqueFileName(`${stem}.${opts.target}`, taken)));
  }
  return { files, previewText };
}

function renderDocument(conversations, opts) {
  if (opts.target === 'jsonl') return renderJsonl(conversations, opts);
  if (opts.target === 'csv') return renderCsv(conversations, opts);
  if (opts.target === 'html') return renderHtml(conversations, opts);
  if (opts.target === 'md') return renderMarkdown(conversations, opts);
  return renderPlainText(conversations, opts);
}

function renderPlainText(conversations, opts) {
  if (opts.layout === 'plain') return renderBodiesOnly(conversations);
  if (opts.layout === 'transcript') return renderTranscript(conversations, opts);
  if (opts.layout === 'timeline') return renderTimeline(conversations, opts);
  return renderChat(conversations, opts);
}

function renderMarkdown(conversations, opts) {
  if (opts.layout === 'plain') return renderBodiesOnly(conversations);
  const head = opts.includeTitles && conversations.length > 1 ? `${markdownToc(conversations, opts)}\n\n` : '';
  if (opts.layout === 'transcript') return `${head}${renderTranscript(conversations, opts)}`;
  if (opts.layout === 'timeline') return `${head}${renderTimeline(conversations, opts)}`;
  return `${head}${renderChat(conversations, opts)}`;
}

/** plain：只剩正文，会话之间空行分隔——用户常拿它继续写作或喂给别的模型 */
function renderBodiesOnly(conversations) {
  const blocks = conversations
    .map((conv) => conv.messages.map((message) => message.text.trim()).filter(Boolean).join('\n\n'))
    .filter(Boolean);
  return blocks.length ? `${blocks.join('\n\n\n')}\n` : '';
}

function renderChat(conversations, opts) {
  const markdown = opts.target === 'md';
  const blocks = [];
  if (opts.includeTitles && conversations.length > 1) blocks.push(markdown ? markdownToc(conversations, opts) : textToc(conversations, opts));
  for (const conv of conversations) {
    if (opts.includeTitles) {
      blocks.push(markdown
        ? `## ${conv.title}`
        : `${RULE}\n会话标题：${conv.title}\n${RULE}`);
    }
    const lines = [];
    for (const message of conv.messages) {
      const { label, time } = messageHeading(message, opts);
      const stamp = time ? `[${time}] ` : '';
      lines.push(markdown ? `**${stamp}${label}：**` : `${stamp}${label}：`);
      lines.push(indentPreservingCode(message.text.trim(), markdown ? '' : '  '));
      lines.push('');
    }
    blocks.push(lines.join('\n').trimEnd() || emptyHint(opts));
  }
  return `${blocks.join('\n\n').trimEnd()}\n`;
}

function renderTranscript(conversations, opts) {
  const blocks = [];
  for (const conv of conversations) {
    if (opts.includeTitles) blocks.push(`## ${conv.title}`);
    const lines = [];
    for (const message of conv.messages) {
      const { label, time } = messageHeading(message, opts);
      lines.push(time ? `**${label}** · ${time}` : `**${label}**`);
      lines.push('');
      lines.push(message.text.trim());
      lines.push('');
    }
    blocks.push(lines.join('\n').trimEnd() || emptyHint(opts));
  }
  return `${blocks.join('\n\n').trimEnd()}\n`;
}

/** 时间线：把所有会话的消息按时间排成一条线，适合「按天回顾自己问了什么」 */
function renderTimeline(conversations, opts) {
  const entries = [];
  conversations.forEach((conv, convIndex) => {
    conv.messages.forEach((message, messageIndex) => {
      entries.push({ conv, convIndex, message, messageIndex });
    });
  });
  const withTime = entries.filter((entry) => entry.message.time);
  const withoutTime = entries.filter((entry) => !entry.message.time);
  withTime.sort((a, b) => {
    const diff = a.message.time.getTime() - b.message.time.getTime();
    return diff !== 0 ? diff : (a.convIndex - b.convIndex) || (a.messageIndex - b.messageIndex);
  });
  const ordered = opts.timestamps ? [...withTime, ...withoutTime] : entries;

  const markdown = opts.target === 'md';
  const showTitle = opts.includeTitles && conversations.length > 1;
  const lines = [];
  for (const entry of ordered) {
    const { label, time } = messageHeading(entry.message, opts);
    const scope = showTitle ? `${entry.conv.title} · ` : '';
    const stamp = time ? `[${time}] ` : '';
    lines.push(markdown ? `**${stamp}${scope}${label}：**` : `${stamp}${scope}${label}：`);
    lines.push(indentPreservingCode(entry.message.text.trim(), markdown ? '' : '  '));
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function textToc(conversations, opts) {
  const lines = [`会话目录（共 ${conversations.length} 个）`];
  conversations.forEach((conv, index) => {
    const range = conversationRange(conv, opts);
    lines.push(`  ${index + 1}. ${conv.title} —— ${conv.messages.length} 条${range ? `，${range}` : ''}`);
  });
  return lines.join('\n');
}

function markdownToc(conversations, opts) {
  const lines = [`> 共 ${conversations.length} 个会话`, ''];
  conversations.forEach((conv, index) => {
    const range = conversationRange(conv, opts);
    lines.push(`${index + 1}. ${conv.title} —— ${conv.messages.length} 条${range ? `，${range}` : ''}`);
  });
  return lines.join('\n');
}

function conversationRange(conv, opts) {
  if (!opts.timestamps) return '';
  const times = conv.messages.map((message) => message.time).filter(Boolean).sort((a, b) => a - b);
  if (!times.length) return '';
  const start = formatTime(times[0]);
  const end = formatTime(times[times.length - 1]);
  return start === end ? start : `${start} ~ ${end}`;
}

function messageHeading(message, opts) {
  const label = roleText(message, opts);
  const tags = { thinking: '（思考）', tool_use: '（工具调用）', tool_result: '（工具结果）' };
  const time = opts.timestamps && message.time ? formatTime(message.time) : '';
  return { label: `${label}${tags[message.kind] ?? ''}`, time };
}

const ROLE_NAMES = { user: '我', assistant: 'AI', system: '系统', tool: '工具', unknown: '未知' };

function roleText(message, opts) {
  const role = message.role ?? 'unknown';
  const base = opts.roleNames ? (ROLE_NAMES[role] ?? role) : role;
  if (!message.name) return base;
  // 只有 AI 侧的名字（模型名）值得贴在角色上；用户侧的名字会把「我」弄脏
  return role === 'assistant' || role === 'tool' ? `${base}（${message.name}）` : base;
}

function emptyHint(opts) {
  return opts.target === 'md' ? '_（此会话没有可显示的消息）_' : '（此会话没有可显示的消息）';
}

/**
 * 缩进正文时跳过代码块：Markdown 代码块一旦被缩进 4 格就会被当成代码块，
 * 或被原文保留的代码吞掉换行，用户拿到的内容就废了。
 */
function indentPreservingCode(text, indent) {
  if (!indent) return text;
  const lines = String(text).split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line ? indent + line : line;
    })
    .join('\n');
}

function renderJsonl(conversations, opts) {
  const lines = [];
  conversations.forEach((conv, convIndex) => {
    conv.messages.forEach((message, messageIndex) => {
      if (!message.text.trim()) return;
      lines.push(JSON.stringify({
        conversation: convIndex + 1,
        title: conv.title,
        index: messageIndex + 1,
        role: message.role,
        time: opts.timestamps && message.time ? formatTime(message.time) : '',
        text: message.text,
      }));
    });
  });
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function renderCsv(conversations, opts) {
  const rows = [['会话', '序号', '角色', '时间', '内容']];
  conversations.forEach((conv) => {
    conv.messages.forEach((message, messageIndex) => {
      if (!message.text.trim()) return;
      rows.push([
        conv.title,
        String(messageIndex + 1),
        roleText(message, opts),
        opts.timestamps && message.time ? formatTime(message.time) : '',
        message.text,
      ]);
    });
  });
  return `${stringifyCsv(rows)}\r\n`;
}

const HTML_STYLE = [
  'body{margin:0;padding:24px;background:#faf9f7;color:#23212b;',
  'font-family:-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;line-height:1.7}',
  'main{max-width:860px;margin:0 auto}',
  'h1{font-size:20px;font-weight:600;margin:0 0 4px}',
  'h2{font-size:17px;font-weight:600;margin:32px 0 12px;padding-bottom:6px;border-bottom:1px solid #e4e0d8}',
  'ul.toc{margin:8px 0 0;padding-left:20px;color:#5c5866;font-size:13px}',
  'div.message{margin:0 0 18px}',
  'div.meta{font-size:13px;color:#6a6572;margin-bottom:4px}',
  'span.role{color:#23212b;font-weight:600}',
  'pre.body{margin:0;padding:10px 12px;background:#fff;border:1px solid #e8e4dc;border-radius:6px;',
  'white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:13px}',
  'hr{border:0;border-top:1px solid #e4e0d8;margin:28px 0}',
].join('');

function renderHtml(conversations, opts) {
  const parts = [];
  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="zh-CN">');
  parts.push('<head>');
  parts.push('<meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  parts.push(`<title>${htmlEscape(documentTitle(conversations))}</title>`);
  parts.push(`<style>${HTML_STYLE}</style>`);
  parts.push('</head>');
  parts.push('<body>');
  parts.push('<main>');
  parts.push(`<h1>${htmlEscape(documentTitle(conversations))}</h1>`);

  if (opts.includeTitles && conversations.length > 1) {
    const items = conversations.map((conv, index) => {
      const range = conversationRange(conv, opts);
      return `<li>${htmlEscape(conv.title)} —— ${conv.messages.length} 条${range ? htmlEscape(`，${range}`) : ''}</li>`;
    });
    parts.push(`<ul class="toc">${items.join('')}</ul>`);
  }

  for (const conv of conversations) {
    parts.push('<hr>');
    if (opts.includeTitles) parts.push(`<h2>${htmlEscape(conv.title)}</h2>`);
    if (opts.layout === 'plain') {
      const body = conv.messages.map((message) => message.text.trim()).filter(Boolean).join('\n\n');
      if (body) parts.push(`<pre class="body">${htmlEscape(body)}</pre>`);
      continue;
    }
    let rendered = 0;
    for (const message of conv.messages) {
      if (!message.text.trim()) continue;
      rendered += 1;
      const { label, time } = messageHeading(message, opts);
      const meta = `${time ? `[${time}] ` : ''}${label}`;
      parts.push('<div class="message">');
      parts.push(`<div class="meta"><span class="role">${htmlEscape(meta)}</span></div>`);
      parts.push(`<pre class="body">${htmlEscape(message.text.trim())}</pre>`);
      parts.push('</div>');
    }
    if (!rendered) parts.push(`<p>${htmlEscape(emptyHint(opts))}</p>`);
  }

  parts.push('</main>');
  parts.push('</body>');
  parts.push('</html>');
  return `${parts.join('\n')}\n`;
}

function documentTitle(conversations) {
  return conversations.length === 1 ? conversations[0].title : `聊天记录（${conversations.length} 个会话）`;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function firstName(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function cleanTitle(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function normalizeRole(raw) {
  const key = String(raw ?? '').trim().toLowerCase();
  return ROLE_ALIASES.get(key) ?? (key || 'unknown');
}

function extractText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (isObject(value)) {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.value === 'string') return value.value;
    if (Array.isArray(value.parts)) return extractText(value.parts);
    if (Array.isArray(value.content)) return extractText(value.content);
  }
  return '';
}

/** 工具入参可能是对象或 JSON 字符串，统一成一段可读文本 */
function stringifyToolInput(input) {
  if (input === null || input === undefined || input === '') return '';
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return '';
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return trimmed;
    }
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function fencedCode(code, language) {
  const body = String(code ?? '').replace(/\s+$/, '');
  const longestRun = (body.match(/`{3,}/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language || ''}\n${body}\n${fence}`;
}

/**
 * 秒 / 毫秒时间戳都可能出现。1e11 的分界：毫秒时间戳到 1973 年才有 1e11，
 * 而秒级时间戳到公元 5138 年才 1e11，所以小于它的一律按秒处理。
 */
function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const date = new Date(value < 1e11 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) return parseTimestamp(Number(trimmed));
    // 各家导出的 ISO 串有的带 Z 有的不带；Date 对不带时区的串按本地时区解释，正好符合要求
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function formatTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
