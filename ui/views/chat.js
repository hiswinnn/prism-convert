/**
 * 对话工坊：AI 聊天记录 JSON → 可读 TXT 的专用工作台。
 *
 * 为什么单独做一页：
 * 1) 聊天记录是「数据」也是「内容」，用户要的是能读、能改、能接着写的东西，
 *    实时预览比一个「转换」按钮有用得多；
 * 2) 不同来源（ChatGPT / Claude / 豆包 / 通用）结构差异大，把识别结果与讯息量摆出来，
 *    用户一眼就知道有没有认对。
 */
import { convertFile } from '../../core/engine.js';
import { h, icon, downloadBlob, debounce, isMobile, shareFile } from '../dom.js';
import { haptic } from '../glass.js';
import { set, setOption, state } from '../store.js';
import { toast } from '../toast.js';

const OUTPUT_FORMATS = [
  { ext: 'txt', label: 'TXT 纯文本', hint: '拿去阅读或继续写作' },
  { ext: 'md', label: 'Markdown', hint: '带标题层级，适合归档' },
  { ext: 'html', label: 'HTML 网页', hint: '带样式，可打印成 PDF' },
  { ext: 'jsonl', label: 'JSON Lines', hint: '每行一条消息，便于数据分析' },
  { ext: 'csv', label: 'CSV 表格', hint: 'Excel 里按行列看' },
];

const studio = {
  target: 'txt',
  preview: '',
  stats: null,
  busy: false,
  error: null,
  selectedConversation: null,
  cacheKey: '',
};

export function openChatStudio(fileId) {
  set({ view: 'chat', chatFileId: fileId });
  studio.selectedConversation = null;
  studio.cacheKey = '';
}

export function renderChat(root) {
  const entry = state.files.find((f) => f.id === state.chatFileId) ?? state.files.find((f) => f.chat);
  if (!entry || !entry.chat) {
    root.append(h('section', { class: 'glass panel rise' },
      h('span', { class: 'panel__title' }, icon('chat'), '对话工坊'),
      h('p', { class: 'panel__hint' }, '先加入一份 AI 聊天记录导出的 JSON（例如 ChatGPT 的 conversations.json），这一页才会亮起来。'),
      h('button', { class: 'btn btn--primary', onclick: () => set({ view: 'work' }) }, icon('arrow'), '回到转换台'),
    ));
    return;
  }

  if (entry.options.roleFilter === undefined) entry.options.roleFilter = 'all';
  if (entry.options.layout === undefined) entry.options.layout = 'chat';

  root.append(headerPanel(entry));
  root.append(h('div', { class: 'workbench workbench--chat' }, conversationPanel(entry), studioPanel(entry)));
  schedulePreview(entry);
}

/* ------------------------------- 顶部总览 ------------------------------- */

function headerPanel(entry) {
  const conversations = entry.chat.conversations ?? [];
  const messages = conversations.reduce((sum, c) => sum + (c.messageCount ?? 0), 0);
  const models = [...new Set(conversations.flatMap((c) => c.modelNames ?? []))].slice(0, 4);
  const first = conversations[0]?.createdAt;
  const last = conversations.at(-1)?.createdAt;

  return h('section', { class: 'glass glass--liquid halo panel rise rise-1' },
    h('div', { class: 'panel__head' },
      h('span', { class: 'panel__title' }, icon('chat'), '对话工坊'),
      h('span', { class: 'badge badge--ok' }, icon('check'), entry.chat.providerLabel),
      h('span', { class: 'badge badge--mute' }, entry.name),
      h('span', { style: { flex: '1' } }),
      h('button', { class: 'btn btn--sm btn--ghost', onclick: () => set({ view: 'work' }) }, icon('arrow'), '回到转换台'),
    ),
    h('div', { class: 'statgrid' },
      statCard('会话数', conversations.length, '识别到的独立对话'),
      statCard('消息条数', messages, '含 user / assistant'),
      statCard('时间跨度', formatRange(first, last), '最早 → 最晚'),
      statCard('模型', models.length ? models.join(' / ') : '未标注', '来自导出的元数据'),
    ),
  );
}

function statCard(label, value, sub) {
  return h('div', { class: 'glass glass--soft statcard' },
    h('span', { class: 'statcard__label' }, label),
    h('span', { class: 'statcard__value' }, String(value)),
    h('span', { class: 'statcard__sub' }, sub),
  );
}

function formatRange(a, b) {
  if (!a && !b) return '未知';
  const fmt = (t) => (t ? new Date(t).toLocaleDateString('zh-CN') : '?');
  return `${fmt(a)} → ${fmt(b)}`;
}

/* ------------------------------- 会话列表 ------------------------------- */

function conversationPanel(entry) {
  const conversations = entry.chat.conversations ?? [];
  const body = h('div', { class: 'panel__body' });

  body.append(h('div', { class: 'scroll-x' },
    h('button', {
      class: `chip chip--pick ${studio.selectedConversation === null ? 'chip--active' : ''}`,
      onclick: () => selectConversation(entry, null),
    }, icon('list'), `全部 ${conversations.length} 个会话`),
  ));

  const list = h('div', { class: 'filelist', style: { maxHeight: '58dvh', overflow: 'auto' } });
  conversations.forEach((conversation, index) => {
    const active = studio.selectedConversation === index + 1;
    list.append(h('button', {
      class: `glass glass--soft filecard ${active ? 'chip--active' : ''}`,
      style: { textAlign: 'left', cursor: 'pointer', display: 'grid', gap: '4px' },
      onclick: () => selectConversation(entry, index + 1),
    },
    h('div', { class: 'filecard__top' },
      h('span', { class: 'badge badge--mute num' }, `#${index + 1}`),
      h('span', { class: 'filecard__name' }, conversation.title || '（无标题会话）'),
    ),
    h('div', { class: 'filecard__sub' },
      h('span', null, `${conversation.messageCount ?? 0} 条`),
      conversation.createdAt ? h('span', null, new Date(conversation.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })) : h('span'),
      h('span', null, `我 ${conversation.roleCounts?.user ?? 0} · AI ${conversation.roleCounts?.assistant ?? 0}`),
    ),
    conversation.preview ? h('span', { class: 'filecard__sub', style: { display: 'block', opacity: 0.75 } }, conversation.preview) : h('span'),
    ));
  });

  body.append(list);
  return h('section', { class: 'glass panel workbench__side rise rise-2' },
    h('div', { class: 'panel__head' }, h('span', { class: 'panel__title' }, icon('list'), '会话列表')),
    body,
  );
}

function selectConversation(entry, index) {
  studio.selectedConversation = index;
  setOption(entry.id, 'conversationIds', index === null ? '' : String(index));
  studio.cacheKey = '';
  haptic(8);
  set({});
}

/* ------------------------------- 参数 + 预览 ------------------------------- */

function studioPanel(entry) {
  const body = h('div', { class: 'panel__body' });

  body.append(h('div', { class: 'optgroup' },
    h('span', { class: 'optgroup__title' }, '输出格式'),
    h('div', { class: 'scroll-x' }, ...OUTPUT_FORMATS.map((format) => h('button', {
      class: `chip chip--pick ${studio.target === format.ext ? 'chip--active' : ''}`,
      title: format.hint,
      onclick: () => {
        studio.target = format.ext;
        studio.cacheKey = '';
        haptic(8);
        set({});
      },
    }, icon('arrow'), format.label))),
  ));

  body.append(h('div', { class: 'optgroup' },
    h('span', { class: 'optgroup__title' }, '导出哪些内容'),
    selectRow(entry, 'roleFilter', '角色', [
      { value: 'all', label: '全部（我 + AI）' },
      { value: 'user', label: '只要我的提问' },
      { value: 'assistant', label: '只要 AI 的回答' },
    ]),
    selectRow(entry, 'layout', '排版', [
      { value: 'chat', label: '对话体（分角色）' },
      { value: 'transcript', label: '带标题的誊录稿' },
      { value: 'plain', label: '纯正文（去掉角色标记）' },
      { value: 'timeline', label: '时间线扁平' },
    ]),
    toggleRow(entry, 'timestamps', '保留时间戳'),
    toggleRow(entry, 'roleNames', '用「我 / AI」代替 user / assistant'),
    toggleRow(entry, 'includeThinking', '保留思考过程 / 工具调用'),
    toggleRow(entry, 'includeSystem', '保留系统提示词（通常不需要）'),
    toggleRow(entry, 'includeTitles', '会话标题作为分隔'),
    toggleRow(entry, 'oneFilePerConversation', '每个会话单独一个文件'),
    selectRow(entry, 'encoding', '输出编码', entryEncodingChoices()),
  ));

  const previewBox = h('pre', { class: 'preview', dataset: { chatPreview: '1' } },
    studio.busy ? '正在生成预览…' : (studio.error ? `预览失败：${studio.error}` : (studio.preview || '（没有内容）')));

  const previewWrap = h('section', { class: 'glass glass--soft panel' },
    h('div', { class: 'panel__head' },
      h('span', { class: 'panel__title' }, icon('text'), '实时预览'),
      h('span', { class: 'badge badge--mute', dataset: { chatStats: '1' } }, studio.stats ?? ''),
      h('span', { style: { flex: '1' } }),
      h('button', { class: 'btn btn--sm btn--ghost', onclick: () => runPreview(entry, true) }, icon('refresh'), '重算'),
    ),
    previewBox,
  );

  const exportBar = h('div', { class: 'filecard__actions' },
    h('button', {
      class: 'btn btn--primary',
      onclick: async () => {
        const result = await runPreview(entry, true);
        if (!result) return;
        for (const file of result.files) downloadBlob(file.name, file.bytes, file.mime);
        toast(`已导出 ${result.files.length} 个文件`, 'ok');
      },
    }, icon('download'), '导出文件'),
    h('button', {
      class: 'btn',
      onclick: async () => {
        const result = studio.result ?? (await runPreview(entry, true));
        const file = result?.files?.[0];
        if (!file?.text) return toast('没有可复制的文本内容', 'warn');
        await navigator.clipboard.writeText(file.text);
        toast('全文已复制到剪贴板', 'ok');
      },
    }, icon('text'), '复制全文'),
    isMobile()
      ? h('button', {
        class: 'btn btn--ghost',
        onclick: async () => {
          const result = studio.result ?? (await runPreview(entry, true));
          const file = result?.files?.[0];
          if (!file) return;
          const shared = await shareFile(file.name, file.bytes, file.mime);
          if (!shared) downloadBlob(file.name, file.bytes, file.mime);
        },
      }, icon('upload'), '分享')
      : h('span'),
  );

  body.append(previewWrap, exportBar);
  return h('section', { class: 'glass panel rise rise-3' },
    h('div', { class: 'panel__head' },
      h('span', { class: 'panel__title' }, icon('wand'), '导出设置'),
      h('span', { class: 'panel__hint' }, '改任何一项，预览会立刻跟着变'),
    ),
    body,
  );
}

function entryEncodingChoices() {
  return [
    { value: 'utf-8', label: 'UTF-8（通用）' },
    { value: 'utf-8-bom', label: 'UTF-8 带 BOM（Excel 友好）' },
    { value: 'gbk', label: 'GBK（老阅读器 / 老软件）' },
    { value: 'gb18030', label: 'GB18030（国标全集）' },
    { value: 'big5', label: 'Big5（繁体环境）' },
    { value: 'utf-16le', label: 'UTF-16 LE' },
  ];
}

function selectRow(entry, key, label, choices) {
  const select = h('select', {
    class: 'field',
    onchange: (event) => {
      setOption(entry.id, key, event.target.value);
      studio.cacheKey = '';
      runPreview(entry);
    },
  });
  for (const choice of choices) {
    select.append(h('option', { value: choice.value, selected: String(entry.options[key] ?? '') === String(choice.value) }, choice.label));
  }
  return h('div', { class: 'optrow' }, h('label', { class: 'optrow__label' }, label), select);
}

function toggleRow(entry, key, label) {
  const checked = entry.options[key] !== false;
  return h('label', { class: 'optrow optrow--inline' },
    h('span', { class: 'optrow__label' }, label),
    h('span', { class: 'switch' },
      h('input', {
        type: 'checkbox', checked,
        onchange: (event) => {
          setOption(entry.id, key, event.target.checked);
          studio.cacheKey = '';
          runPreview(entry);
        },
      }),
      h('span', { class: 'switch__track' }),
    ),
  );
}

/* ------------------------------- 预览计算 ------------------------------- */

const schedulePreview = debounce((entry) => runPreview(entry), 320);

async function runPreview(entry, force = false) {
  const key = `${entry.id}|${studio.target}|${JSON.stringify(entry.options)}|${studio.selectedConversation}`;
  if (!force && key === studio.cacheKey && studio.result) return studio.result;

  studio.busy = true;
  studio.error = null;
  paintPreview();
  try {
    const result = await convertFile(
      { name: entry.name, bytes: entry.bytes },
      { target: studio.target, options: entry.options, analysis: entry.analysis },
    );
    studio.result = result;
    studio.preview = (result.preview ?? '').slice(0, 4000);
    const first = result.files[0];
    studio.stats = first?.text ? `${first.text.length.toLocaleString('zh-CN')} 字 · ${result.files.length} 个文件` : `${result.files.length} 个文件`;
    studio.cacheKey = key;
    entry.chatError = null;
  } catch (err) {
    studio.error = err?.message ?? String(err);
    studio.preview = '';
    studio.stats = '';
    studio.result = null;
  } finally {
    studio.busy = false;
    paintPreview();
  }
  return studio.result;
}

function paintPreview() {
  const box = document.querySelector('[data-chat-preview]');
  if (box) {
    box.textContent = studio.busy
      ? '正在生成预览…'
      : (studio.error ? `预览失败：${studio.error}` : (studio.preview || '（没有内容）'));
  }
  const stats = document.querySelector('[data-chat-stats]');
  if (stats) stats.textContent = studio.stats ?? '';
}
