/**
 * 转换器注册表：只放「元数据 + 懒加载器」，不放实现。
 * 界面用它渲染能力矩阵与目标格式下拉，引擎用它挑转换器。
 */
import { ConversionError } from './errors.js';

/** 扩展名归一：同一格式的不同写法必须落到同一个 key，否则匹配会漏 */
const EXT_ALIAS = {
  jpeg: 'jpg', jpe: 'jpg', jfif: 'jpg', htm: 'html', xhtml: 'html', yml: 'yaml', markdown: 'md',
  mdx: 'md', ndjson: 'jsonl', text: 'txt', tif: 'tiff', heif: 'heic', mpga: 'mp3', tgz: 'tar',
  // SSA 是 ASS 的前身（V4 vs V4+），统一按 ass 处理，免得 .ssa 文件被判成不支持
  ssa: 'ass',
  wavpack: 'wav', log: 'txt', ssml: 'txt',
};

export function canonicalExt(ext) {
  const key = String(ext ?? '').toLowerCase().replace(/^\./, '');
  return EXT_ALIAS[key] ?? key;
}

/** 格式信息：界面下拉、能力矩阵、结果卡片都用它 */
export const FORMATS = {
  txt: { label: 'TXT 纯文本', group: '文本' }, md: { label: 'Markdown', group: '文本' },
  html: { label: 'HTML 网页', group: '文本' }, json: { label: 'JSON', group: '数据' },
  jsonl: { label: 'JSON Lines', group: '数据' }, yaml: { label: 'YAML', group: '数据' },
  xml: { label: 'XML', group: '数据' }, ini: { label: 'INI 配置', group: '数据' },
  csv: { label: 'CSV 表格', group: '表格' }, tsv: { label: 'TSV 表格', group: '表格' },
  xlsx: { label: 'Excel 工作簿', group: '表格' }, xls: { label: 'Excel 97-2003', group: '表格' },
  ods: { label: 'ODS 表格', group: '表格' }, docx: { label: 'Word 文档', group: '文档' },
  rtf: { label: 'RTF 富文本', group: '文档' }, epub: { label: 'EPUB 电子书', group: '文档' },
  odt: { label: 'ODT 文档', group: '文档' }, pdf: { label: 'PDF', group: '文档' },
  png: { label: 'PNG 图片', group: '图片' }, jpg: { label: 'JPEG 图片', group: '图片' },
  webp: { label: 'WebP 图片', group: '图片' }, avif: { label: 'AVIF 图片', group: '图片' },
  bmp: { label: 'BMP 位图', group: '图片' }, ico: { label: 'ICO 图标', group: '图片' },
  gif: { label: 'GIF 动图', group: '图片' }, heic: { label: 'HEIC (iPhone)', group: '图片' },
  svg: { label: 'SVG 矢量图', group: '图片' }, tiff: { label: 'TIFF 图片', group: '图片' },
  zip: { label: 'ZIP 压缩包', group: '压缩包' }, gz: { label: 'GZIP', group: '压缩包' },
  tar: { label: 'TAR 归档', group: '压缩包' }, mp3: { label: 'MP3 音频', group: '音视频' },
  // mp3cut 是「裁一段存成 MP3」的预设目标，对用户比对开发者友好
  mp3cut: { label: 'MP3（裁剪片段）', group: '音视频' },
  wav: { label: 'WAV 音频', group: '音视频' }, ogg: { label: 'OGG 音频', group: '音视频' },
  flac: { label: 'FLAC 无损', group: '音视频' }, m4a: { label: 'M4A 音频', group: '音视频' },
  aac: { label: 'AAC 音频', group: '音视频' }, opus: { label: 'Opus 音频', group: '音视频' },
  mp4: { label: 'MP4 视频', group: '音视频' }, webm: { label: 'WebM 视频', group: '音视频' },
  mkv: { label: 'MKV 视频', group: '音视频' }, mov: { label: 'MOV 视频', group: '音视频' },
  avi: { label: 'AVI 视频', group: '音视频' }, srt: { label: 'SRT 字幕', group: '字幕' },
  vtt: { label: 'WebVTT 字幕', group: '字幕' }, ass: { label: 'ASS 字幕', group: '字幕' },
};

export function formatLabel(ext) {
  const key = canonicalExt(ext);
  if (!key || key === 'bin') return '未识别的文件';
  return FORMATS[key]?.label ?? `${String(ext).toUpperCase()} 文件`;
}

export const CONVERTERS = [
  {
    id: 'chat-export', category: 'chat', label: 'AI 聊天记录', priority: 95,
    from: ['json', 'jsonl'], to: ['txt', 'md', 'html', 'jsonl', 'csv'],
    loader: () => import('./chat-export.js'),
    options: [
      { key: 'layout', type: 'select', label: '排版方式', default: 'chat', choices: [
        { value: 'chat', label: '对话体（分角色）' }, { value: 'transcript', label: '带标题的誊录稿' },
        { value: 'plain', label: '纯正文（去角色标记）' }, { value: 'timeline', label: '时间线扁平' }] },
      { key: 'timestamps', type: 'boolean', label: '保留时间', default: true },
      { key: 'roleNames', type: 'boolean', label: '用「我 / AI」代替 user / assistant', default: true },
      { key: 'includeThinking', type: 'boolean', label: '保留思考过程 / 工具调用', default: true },
      { key: 'includeTitles', type: 'boolean', label: '用会话标题分隔', default: true },
      { key: 'oneFilePerConversation', type: 'boolean', label: '每个会话单独一个文件', default: false },
      { key: 'roleFilter', type: 'select', label: '导出哪些角色', default: 'all', choices: [
        { value: 'all', label: '全部（我 + AI）' }, { value: 'user', label: '只要我的提问' },
        { value: 'assistant', label: '只要 AI 的回答' }] },
      { key: 'conversationIds', type: 'text', label: '只导出指定会话（序号，如 1,3）', default: '' },
      { key: 'includeSystem', type: 'boolean', label: '保留系统提示词', default: false },
      { key: 'encoding', type: 'encoding', label: '输出编码', default: 'utf-8' },
    ],
  },
  {
    id: 'document', category: 'document', label: '文档', priority: 70,
    from: ['docx', 'txt', 'md', 'html', 'rtf', 'epub', 'odt'], to: ['txt', 'md', 'html', 'docx', 'epub'],
    loader: () => import('./document.js'),
    options: [
      { key: 'headingStyle', type: 'select', label: '标题样式', default: 'hash', choices: [
        { value: 'hash', label: '# 号（Markdown）' }, { value: 'number', label: '一、二、三' }, { value: 'plain', label: '不加标记' }] },
      { key: 'keepImages', type: 'boolean', label: 'docx 转出时内嵌图片', default: true },
      { key: 'title', type: 'text', label: '导出文档标题', default: '' },
      { key: 'encoding', type: 'encoding', label: '输出编码', default: 'utf-8' },
    ],
  },
  {
    id: 'table', category: 'table', label: '表格', priority: 80,
    // json 也在输入里：结构化数组（对象数组）转表格是很常见的需求。
    // json→csv/xlsx 时 chat-export（优先级 95）会先试，若不是聊天记录它会软失败，引擎再落到这里。
    from: ['xlsx', 'xls', 'csv', 'tsv', 'ods', 'json'], to: ['csv', 'tsv', 'xlsx', 'json', 'md', 'html', 'ods'],
    loader: () => import('./table.js'),
    options: [
      { key: 'sheet', type: 'select', label: '工作表', default: 'all', choices: [
        { value: 'all', label: '全部工作表' }, { value: 'first', label: '仅第一个' }] },
      { key: 'header', type: 'boolean', label: '首行作为表头', default: true },
      { key: 'delimiter', type: 'select', label: 'CSV 分隔符', default: ',', choices: [
        { value: ',', label: '逗号 ,' }, { value: ';', label: '分号 ;' }, { value: 'tab', label: '制表符 Tab' }] },
      { key: 'bom', type: 'boolean', label: 'CSV 加 BOM（Excel 打开不乱码）', default: true },
      { key: 'jsonShape', type: 'select', label: 'JSON 结构', default: 'array', choices: [
        { value: 'array', label: '对象数组' }, { value: 'columns', label: '{columns, rows}' }] },
      { key: 'encoding', type: 'encoding', label: '输出编码', default: 'utf-8' },
    ],
  },
  {
    id: 'data', category: 'text', label: '结构化数据', priority: 40,
    from: ['json', 'jsonl', 'yaml', 'xml', 'ini', 'csv'], to: ['json', 'jsonl', 'yaml', 'txt', 'xml', 'ini'],
    loader: () => import('./data.js'),
    options: [
      { key: 'txtStyle', type: 'select', label: '转 TXT 的样式', default: 'tree', choices: [
        { value: 'tree', label: '缩进树形' }, { value: 'kv', label: '键 = 值 扁平' }, { value: 'table', label: '等宽表格' }] },
      { key: 'indent', type: 'select', label: '缩进', default: '2', choices: [
        { value: '2', label: '2 空格' }, { value: '4', label: '4 空格' }, { value: 'tab', label: 'Tab' }, { value: '0', label: '压成一行' }] },
      { key: 'sortKeys', type: 'boolean', label: '键名排序', default: false },
      { key: 'rootTag', type: 'text', label: 'XML 根标签', default: 'root' },
      { key: 'encoding', type: 'encoding', label: '输出编码', default: 'utf-8' },
    ],
  },
  {
    id: 'image', category: 'image', label: '图片', priority: 90,
    from: ['png', 'jpg', 'webp', 'gif', 'bmp', 'ico', 'avif', 'heic', 'svg', 'tiff', 'pnm'],
    to: ['png', 'jpg', 'webp', 'bmp', 'ico', 'avif'],
    loader: () => import('./image.js'),
    options: [
      { key: 'quality', type: 'range', label: '画质', default: 0.9, min: 0.3, max: 1, step: 0.05 },
      { key: 'maxEdge', type: 'select', label: '最长边限制', default: '0', choices: [
        { value: '0', label: '不缩放' }, { value: '4096', label: '4096 px' }, { value: '1920', label: '1920 px' },
        { value: '1080', label: '1080 px' }, { value: '800', label: '800 px' }] },
      { key: 'keepTransparency', type: 'boolean', label: '保留透明通道', default: true },
      { key: 'background', type: 'select', label: '透明填充色（转 JPEG）', default: '#ffffff', choices: [
        { value: '#ffffff', label: '白色' }, { value: '#000000', label: '黑色' }, { value: '#f5f5f7', label: '浅灰' }] },
      { key: 'pageMode', type: 'select', label: '多帧图片', default: 'first', choices: [
        { value: 'first', label: '只取第一帧' }, { value: 'all', label: '全部导出为 ZIP' }] },
    ],
  },
  {
    id: 'pdf', category: 'pdf', label: 'PDF', priority: 85,
    from: ['pdf', 'png', 'jpg', 'webp', 'bmp', 'txt', 'md', 'html', 'svg'],
    to: ['pdf', 'png', 'jpg', 'txt', 'md', 'html'],
    loader: () => import('./pdf.js'),
    options: [
      { key: 'pdfMode', type: 'select', label: 'PDF 处理方式', default: 'auto', choices: [
        { value: 'auto', label: '自动判断' }, { value: 'extractText', label: '提取文字' },
        { value: 'render', label: '渲染成图片' }, { value: 'merge', label: '合并成 PDF' },
        { value: 'split', label: '抽取页面' }, { value: 'rotate', label: '旋转页面' }] },
      { key: 'renderScale', type: 'range', label: '渲染倍率', default: 2, min: 1, max: 3, step: 0.5 },
      { key: 'pages', type: 'text', label: '页码范围（如 1-3,7）', default: '' },
      { key: 'rotate', type: 'select', label: '旋转角度', default: '0', choices: [
        { value: '0', label: '不旋转' }, { value: '90', label: '顺时针 90°' },
        { value: '180', label: '180°' }, { value: '270', label: '270°' }] },
      { key: 'pageSize', type: 'select', label: '图片转 PDF 页面', default: 'fit', choices: [
        { value: 'fit', label: '按图片比例' }, { value: 'a4', label: 'A4 居中' }] },
    ],
  },
  {
    id: 'archive', category: 'archive', label: '压缩包', priority: 60,
    // tgz 也算进来：按魔数识别内容，扩展名只是线索
    from: ['zip', 'gz', 'tar', 'tgz'], to: ['zip', 'gz', 'tar', 'txt', 'json'],
    loader: () => import('./archive.js'),
    options: [
      { key: 'action', type: 'select', label: '操作', default: 'extract', choices: [
        { value: 'extract', label: '解压' }, { value: 'list', label: '只看清单' }, { value: 'repackage', label: '重新打包为 ZIP' }] },
      { key: 'flatten', type: 'boolean', label: '拉平目录', default: false },
      { key: 'includeHidden', type: 'boolean', label: '包含隐藏文件', default: false },
      { key: 'encoding', type: 'encoding', label: '清单文本编码', default: 'utf-8' },
    ],
  },
  {
    id: 'subtitle', category: 'subtitle', label: '字幕', priority: 75,
    // ssa 是 ass 的前身（V4 vs V4+），不列进来 .ssa 文件会被判定为不支持
    from: ['srt', 'vtt', 'ass', 'ssa'], to: ['srt', 'vtt', 'ass', 'txt', 'csv'],
    loader: () => import('./subtitle.js'),
    options: [
      { key: 'shift', type: 'text', label: '整体平移（秒，可负）', default: '0' },
      { key: 'stripTags', type: 'boolean', label: '去掉样式标签', default: false },
      { key: 'merge', type: 'boolean', label: '合并同时间轴重复行', default: false },
      { key: 'encoding', type: 'encoding', label: '输出编码', default: 'utf-8' },
    ],
  },
  {
    id: 'media', category: 'media', label: '音视频', priority: 85,
    from: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'mp4', 'webm', 'mkv', 'mov', 'avi', 'gif'],
    to: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'mp4', 'webm', 'gif', 'png', 'jpg', 'mp3cut'],
    loader: () => import('./media.js'),
    options: [
      { key: 'mediaAction', type: 'select', label: '操作', default: 'convert', choices: [
        { value: 'convert', label: '转换格式' }, { value: 'extractAudio', label: '提取音频' },
        { value: 'extractFrame', label: '截取一帧' }, { value: 'trim', label: '裁剪片段' },
        { value: 'compress', label: '压缩体积' }] },
      { key: 'audioBitrate', type: 'select', label: '音频码率', default: '192k', choices: [
        { value: '320k', label: '320k' }, { value: '192k', label: '192k' },
        { value: '128k', label: '128k' }, { value: '64k', label: '64k' }] },
      { key: 'videoCrf', type: 'range', label: '视频质量 CRF', default: 28, min: 18, max: 40, step: 1 },
      { key: 'trimStart', type: 'text', label: '裁剪起点（秒 / 00:01:23）', default: '' },
      { key: 'trimEnd', type: 'text', label: '裁剪终点', default: '' },
      { key: 'frameAt', type: 'text', label: '截帧时间点（秒）', default: '1' },
      { key: 'scale', type: 'select', label: '分辨率', default: 'source', choices: [
        { value: 'source', label: '保持原样' }, { value: '1080', label: '最长边 1080' },
        { value: '720', label: '最长边 720' }, { value: '480', label: '最长边 480' }] },
      { key: 'gifFps', type: 'range', label: 'GIF 帧率', default: 12, min: 5, max: 30, step: 1 },
    ],
  },
];

const byId = new Map(CONVERTERS.map((c) => [c.id, c]));

export function getConverter(id) {
  return byId.get(id) ?? null;
}

/** 某个输入扩展能转出哪些目标格式（按优先级去重） */
export function targetsFor(sourceExt) {
  const src = canonicalExt(sourceExt);
  const targets = [];
  for (const converter of [...CONVERTERS].sort((a, b) => b.priority - a.priority)) {
    if (!converter.from.map(canonicalExt).includes(src)) continue;
    for (const t of converter.to) if (!targets.includes(t)) targets.push(t);
  }
  return targets;
}

/** 能处理这个输入的所有转换器，按优先级从高到低 */
export function convertersFor(sourceExt) {
  const src = canonicalExt(sourceExt);
  return [...CONVERTERS].filter((c) => c.from.map(canonicalExt).includes(src)).sort((a, b) => b.priority - a.priority);
}

/**
 * 「原地转」（源码格式 == 目标格式）时，只允许同类模块接活。
 * 这是实际踩到的坑：把 PDF 模块的 from 里列了 txt（为了 txt→PDF），
 * 结果 txt→txt（改编码）被优先级更高的 PDF 模块抢走，报「无法把 .txt 转成 .txt」。
 */
const IDENTITY_CATEGORY = {
  txt: ['document', 'text'], md: ['document', 'text'], html: ['document'], rtf: ['document'],
  docx: ['document'], odt: ['document'], epub: ['document'],
  json: ['text'], jsonl: ['text'], yaml: ['text'], xml: ['text'], ini: ['text'],
  csv: ['table', 'text'], tsv: ['table'], xlsx: ['table'], xls: ['table'], ods: ['table'],
  png: ['image'], jpg: ['image'], webp: ['image'], avif: ['image'], bmp: ['image'],
  ico: ['image'], heic: ['image'], tiff: ['image'], svg: ['image'],
  pdf: ['pdf'], mp3: ['media'], wav: ['media'], ogg: ['media'], flac: ['media'], m4a: ['media'],
  aac: ['media'], opus: ['media'], mp4: ['media'], webm: ['media'], mkv: ['media'],
  mov: ['media'], avi: ['media'], gif: ['media', 'image'],
  srt: ['subtitle'], vtt: ['subtitle'], ass: ['subtitle'],
  zip: ['archive'], gz: ['archive'], tar: ['archive'],
};

/**
 * 挑候选转换器：能同时接受源格式与目标格式。返回顺序即引擎的级联尝试顺序。
 */
export function findCandidates(sourceExt, targetExt) {
  const src = canonicalExt(sourceExt);
  const target = canonicalExt(targetExt);
  let list = CONVERTERS.filter(
    (c) => c.from.map(canonicalExt).includes(src) && c.to.map(canonicalExt).includes(target),
  );
  if (src === target) {
    const allowed = IDENTITY_CATEGORY[src];
    if (allowed) list = list.filter((c) => allowed.includes(c.category));
  }
  return list.sort((a, b) => b.priority - a.priority);
}

/** 输入没有明确意图时的默认目标：优先「最可读」的结果 */
const DEFAULT_TARGET = {
  json: 'txt', jsonl: 'txt', docx: 'md', doc: 'txt', rtf: 'txt', epub: 'txt', odt: 'txt',
  html: 'txt', xlsx: 'csv', xls: 'csv', ods: 'csv', tsv: 'csv', yaml: 'json', xml: 'json',
  ini: 'json', txt: 'docx', md: 'html', csv: 'xlsx', pdf: 'txt', heic: 'jpg', avif: 'jpg',
  webp: 'jpg', gif: 'mp4', tiff: 'png', svg: 'png', pnm: 'png', bmp: 'png', ico: 'png',
  m4a: 'mp3', flac: 'mp3', wav: 'mp3', ogg: 'mp3', opus: 'mp3', aac: 'mp3',
  mp4: 'mp3', mkv: 'mp4', mov: 'mp4', avi: 'mp4', webm: 'mp4', zip: 'txt', gz: 'zip', tar: 'zip',
  srt: 'vtt', vtt: 'srt', ass: 'srt',
};

export function defaultTargetFor(sourceExt) {
  const src = canonicalExt(sourceExt);
  const preferred = DEFAULT_TARGET[src];
  const available = targetsFor(src);
  if (preferred && available.includes(canonicalExt(preferred))) return canonicalExt(preferred);
  return available[0] ?? null;
}

if (DEFAULT_TARGET.jsonl && DEFAULT_TARGET.jsonl !== 'txt') {
  throw new ConversionError('REGISTRY_BROKEN', '注册表默认目标配置有误');
}

/** 供「支持矩阵」界面使用 */
export function capabilityMatrix() {
  return CONVERTERS.map((c) => ({
    id: c.id, category: c.category, label: c.label, priority: c.priority,
    from: c.from.slice(), to: c.to.slice(),
  })).sort((a, b) => b.priority - a.priority);
}
