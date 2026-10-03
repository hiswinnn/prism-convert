/**
 * 结构化数据互转：json / jsonl / yaml / xml / ini / csv → json / jsonl / yaml / txt / xml / ini
 *
 * 三个设计决定：
 * 1) 中间模型就是普通 JS 值（对象/数组/字符串/数字/布尔/null）。所有输入先解析成它，所有输出从它序列化，
 *    于是「N 种输入 × M 种输出」只有 N+M 段代码，而不是 N×M。
 * 2) XML 用自有约定：#text 表文本、@name 表属性、同层同名标签重复表数组、prism-type 只标记
 *    「本来就会丢类型」的位置（数字/布尔/null/单元素数组/纯空白字符串）。BadgerFish、xml-js 这类
 *    标准映射在「单元素数组」和「数字字符串」上都不可逆，prism-type 把这几个坑补上，
 *    同时保证普通字符串的 XML 依旧是人能读的裸文本。
 * 3) 中文绝不变成 \uXXXX：yaml 用 lineWidth:-1（js-yaml 的换行折行是唯一会引出转义的地方），
 *    txt/xml/ini/csv 全部原样输出。
 *
 * 注意：本文件顶层不 import 任何第三方库——js-yaml 只在 convert() 里 await api.lib('js-yaml') 取。
 */
import { ConversionError } from './errors.js';
import { canonicalExt } from './registry.js';
import { baseNameOf, extOf, mimeOfExt, parseCsv } from './util.js';

/** @typedef {import('./types.js').Api} Api */

export const meta = {
  id: 'data', category: 'text', label: '结构化数据',
  from: ['json', 'jsonl', 'yaml', 'yml', 'xml', 'ini', 'csv'],
  to: ['json', 'jsonl', 'yaml', 'txt', 'xml', 'ini'],
  priority: 40,
  options: [
    { key: 'txtStyle', type: 'select', label: '转 TXT 的样式', default: 'tree', choices: [
      { value: 'tree', label: '缩进树形（键值对齐，数组带序号）' },
      { value: 'kv', label: '键 = 值 扁平列表（a.b[0].c）' },
      { value: 'table', label: '等宽表格（对象数组）' }] },
    { key: 'indent', type: 'select', label: '缩进', default: '2', choices: [
      { value: '2', label: '2 空格' }, { value: '4', label: '4 空格' },
      { value: 'tab', label: 'Tab' }, { value: '0', label: '压缩成一行' }] },
    { key: 'sortKeys', type: 'boolean', label: '键名排序', default: false },
    { key: 'rootTag', type: 'text', label: 'XML 根标签', default: 'root' },
    { key: 'encoding', type: 'encoding', label: '输出编码', default: 'utf-8' },
  ],
};

/** 引擎当前没把目标格式传进模块（见 convert 里的 resolveTarget 注释），这里放各输入的合理默认 */
const DEFAULT_TARGET_BY_EXT = {
  json: 'txt', jsonl: 'txt', yaml: 'json', xml: 'json', ini: 'json', csv: 'json',
};

const XML_MARKER = 'prism-type';
/** 只认这几个值：万一用户的 XML 里本来就有个叫 prism-type 的属性，不会被误当成类型标记 */
const XML_MARKER_TYPES = new Set(['string', 'number', 'boolean', 'null', 'array', 'object']);
const JSON_POSITION = /line (\d+) column (\d+)/i;
const JSON_OFFSET = /position (\d+)/i;

/* ------------------------------------------------------------------ *
 * 共享给 table.js 的四个小工具。
 * 放在这里而不是 util.js：util.js 被所有模块引用，多会话并行开发时改动冲突代价更高；
 * 这几个函数只服务「表格 / 结构化文本」这条线，跟着数据侧走更安全。
 * ------------------------------------------------------------------ */

/** 等宽显示宽度：CJK / 全角 / emoji 按 2 计（Markdown 对齐、表格对齐都要它） */
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0);
    if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) continue; // 零宽连接符与变体选择符不占位
    width += isWideCode(code) ? 2 : 1;
  }
  return width;
}

function isWideCode(code) {
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6b) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1f9ff)
    || (code >= 0x20000 && code <= 0x3fffd);
}

/** 按显示宽度右侧补空格 */
export function padDisplay(text, width) {
  const value = String(text ?? '');
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

/**
 * 嗅探分隔符：默认分隔符切不出多列时，按首行候选得分改判。
 * 用户显式选过分隔符（切得出多列）就尊重用户选择，不被自动判断推翻。
 */
export function sniffDelimiter(text, preferred = ',') {
  const firstLine = String(text ?? '').split(/\r\n|\r|\n/).find((line) => line.trim() !== '') ?? '';
  const score = (delimiter) => parseCsv(firstLine, delimiter)[0]?.length ?? 1;
  if (score(preferred) >= 2) return { delimiter: preferred, sniffed: false };
  for (const candidate of ['\t', ',', ';']) {
    if (candidate !== preferred && score(candidate) >= 2) return { delimiter: candidate, sniffed: true };
  }
  return { delimiter: preferred, sniffed: false };
}

/**
 * 严格 JSON 解析 + 中文行列号报错（JSON5 那种宽容语法故意不做：静默接受非法输入比报错更坑）。
 * @param {string} text
 * @param {{code?:string, format?:string, baseLine?:number}} [options] baseLine 用于 JSON Lines 的绝对行号
 */
export function parseJsonText(text, options = {}) {
  const { code = 'DATA_READ_FAILED', format = 'JSON', baseLine = 1 } = options;
  const src = String(text ?? '');
  if (src.trim() === '') {
    throw new ConversionError(code, `${format} 内容是空的，没有可解析的数据`);
  }
  try {
    return JSON.parse(src);
  } catch (err) {
    const { line, column } = locateJsonError(src, err);
    const absLine = baseLine - 1 + line;
    const reason = String(err?.message ?? '语法有误').replace(/^JSON\.parse:\s*/, '').replace(/\s*\(line \d+ column \d+\)\s*$/, '');
    throw new ConversionError(
      code,
      `${format} 第 ${absLine} 行第 ${column} 列处格式有误：${reason}。请检查是否多了逗号、少了引号或括号没有闭合。`,
      { cause: err, detail: `line=${absLine} column=${column}` },
    );
  }
}

function locateJsonError(src, err) {
  const message = String(err?.message ?? '');
  const byLine = JSON_POSITION.exec(message);
  if (byLine) return { line: Number(byLine[1]), column: Number(byLine[2]) };
  const byOffset = JSON_OFFSET.exec(message);
  const offset = byOffset ? Number(byOffset[1]) : 0;
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < src.length; i += 1) {
    if (src[i] === '\n') { line += 1; column = 1; } else column += 1;
  }
  return { line, column };
}

/**
 * 文本单元格 → 带类型的值。
 * 保留前导零（007、邮编、电话号码不该变成数字），只对「像数字且不会丢信息」的文本做转换。
 */
export function coerceScalarText(raw) {
  const text = String(raw ?? '');
  if (text === '') return '';
  const trimmed = text.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^[+-]?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed) && trimmed.replace(/[^\d]/g, '').length <= 15) {
    const num = Number(trimmed);
    if (Number.isFinite(num) && String(num) === trimmed) return num; // "1.50" 这类写法保留原样，避免看起来像被改过
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/**
 * 输出格式来源（按优先级）：opt('target') / api.target / input.target → 按输入扩展名的默认值。
 * 引擎的 buildApi 三处都会挂上 target，取其一即可；默认值兜底的是「模块被直接调用」的场景
 * （测试、单元复用的调用方），否则 json 这类多目标输入会不知道自己该输出什么。
 */
function resolveTarget(input, api) {
  const explicit = canonicalExt(api.opt('target', '') || api.target || input?.target || input?.outExt || '');
  if (explicit) return explicit;
  const ext = canonicalExt(input?.ext ?? api.input?.ext ?? extOf(input?.name ?? ''));
  return DEFAULT_TARGET_BY_EXT[ext] ?? 'json';
}

function readSource(api, input) {
  const name = input?.name ?? api.input?.name ?? 'input.json';
  const ext = canonicalExt(input?.ext ?? api.input?.ext ?? extOf(name));
  const bytes = api.bytes();
  if (!bytes || bytes.length === 0) {
    throw new ConversionError('DATA_EMPTY', '文件是空的，没有可转换的结构化数据');
  }
  return { name, ext, bytes };
}

async function parseInput(api, source) {
  const { ext } = source;
  const text = api.text();
  // 只有空白字符的文件不算「解析失败」，是「没有数据」——两者给用户的下一步动作完全不同
  if (text.trim() === '') {
    throw new ConversionError('DATA_EMPTY', '文件里只有空白字符，没有可解析的数据');
  }
  switch (ext) {
    case 'json': return parseJsonText(text, { code: 'DATA_READ_FAILED', format: 'JSON' });
    case 'jsonl': return parseJsonl(text);
    case 'yaml': return parseYaml(api, text);
    case 'xml': return parseXml(text);
    case 'ini': return parseIni(text);
    case 'csv': return parseCsvInput(api, text);
    default:
      throw new ConversionError('DATA_UNSUPPORTED', `结构化数据模块不认识 .${ext} 这类输入`);
  }
}

function parseJsonl(text) {
  const lines = String(text ?? '').split(/\r\n|\r|\n/);
  const items = [];
  lines.forEach((line, index) => {
    if (line.trim() === '') return; // 末尾换行、空行都很常见，直接跳过
    items.push(parseJsonText(line, { code: 'DATA_READ_FAILED', format: 'JSON Lines', baseLine: index + 1 }));
  });
  if (items.length === 0) {
    throw new ConversionError('DATA_EMPTY', 'JSON Lines 文件里没有任何内容（每行应该是一个完整的 JSON）');
  }
  return items;
}

async function parseYaml(api, text) {
  const yaml = await api.lib('js-yaml');
  let value;
  try {
    value = yaml.load(String(text ?? ''));
  } catch (err) {
    const mark = err?.mark;
    const line = mark && Number.isFinite(mark.line) ? mark.line + 1 : 1;
    const column = mark && Number.isFinite(mark.column) ? mark.column + 1 : 1;
    const reason = String(err?.reason ?? err?.message ?? 'YAML 语法有误').split('\n')[0];
    throw new ConversionError(
      'DATA_READ_FAILED',
      `YAML 第 ${line} 行第 ${column} 列处格式有误：${reason}。请检查缩进是否用了空格（YAML 不允许 Tab 缩进）、冒号后是否有空格。`,
      { cause: err, detail: `line=${line} column=${column}` },
    );
  }
  if (value === undefined || value === null) {
    throw new ConversionError('DATA_EMPTY', 'YAML 文件里没有内容');
  }
  return value;
}

function parseCsvInput(api, text) {
  const { delimiter, sniffed } = sniffDelimiter(text, ',');
  const rows = parseCsv(text, delimiter).filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''));
  if (rows.length === 0) {
    throw new ConversionError('DATA_EMPTY', 'CSV 文件里没有可解析的行');
  }
  if (sniffed) {
    api.note('info', `按内容识别出分隔符是「${delimiter === '\t' ? 'Tab' : delimiter}」，已按它解析`);
  }
  const header = rows[0].map((cell) => String(cell ?? '').trim());
  const columns = header.map((name, index) => name || `列${index + 1}`);
  const records = rows.slice(1).map((row) => {
    const record = {};
    columns.forEach((key, index) => { record[key] = coerceScalarText(row[index] ?? ''); });
    return record;
  });
  api.note('info', `CSV 首行已作为列名（${columns.length} 列），纯数字/布尔文本按类型输出`);
  return records;
}

/* --- XML 解析：自己扫一遍，不引 DOM（浏览器/Node 行为一致，也避免 DOMParser 的命名空间差异） --- */

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXmlText(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[body] ?? whole;
  });
}

const encodeXmlText = (text) => String(text).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
const encodeXmlAttr = (text) => String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function parseXml(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  let cursor = 0;
  const stack = [];
  let documentRoot = null;

  const locate = (index) => {
    let line = 1;
    let column = 1;
    for (let i = 0; i < index && i < src.length; i += 1) {
      if (src[i] === '\n') { line += 1; column = 1; } else column += 1;
    }
    return { line, column };
  };
  const fail = (index, message) => {
    const { line, column } = locate(index);
    throw new ConversionError('DATA_READ_FAILED', `XML 第 ${line} 行第 ${column} 列：${message}`);
  };

  while (cursor < src.length) {
    const nextTag = src.indexOf('<', cursor);
    if (nextTag === -1) {
      if (src.slice(cursor).trim() !== '') fail(cursor, '文档结尾出现了不属于任何标签的文本');
      break;
    }
    const chunk = src.slice(cursor, nextTag);
    if (chunk !== '') {
      if (stack.length === 0) {
        if (chunk.trim() !== '') fail(cursor, '根节点之外不能有文本');
      } else {
        stack[stack.length - 1].chunks.push(chunk);
      }
    }
    cursor = nextTag;

    if (src.startsWith('<?', cursor)) {
      const end = src.indexOf('?>', cursor);
      if (end === -1) fail(cursor, '处理指令 <?...?> 没有结束');
      cursor = end + 2;
      continue;
    }
    if (src.startsWith('<!--', cursor)) {
      const end = src.indexOf('-->', cursor);
      if (end === -1) fail(cursor, '注释 <!-- --> 没有结束');
      cursor = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', cursor)) {
      const end = src.indexOf(']]>', cursor);
      if (end === -1) fail(cursor, 'CDATA 段没有结束');
      if (stack.length === 0) fail(cursor, 'CDATA 不能出现在根节点之外');
      stack[stack.length - 1].chunks.push(src.slice(cursor + 9, end));
      cursor = end + 3;
      continue;
    }
    if (src.startsWith('<!', cursor)) {
      const end = src.indexOf('>', cursor);
      if (end === -1) fail(cursor, '文档声明 <!...> 没有结束');
      cursor = end + 1;
      continue;
    }
    if (src.startsWith('</', cursor)) {
      const end = src.indexOf('>', cursor);
      if (end === -1) fail(cursor, '结束标签没有 >');
      const name = src.slice(cursor + 2, end).trim();
      const node = stack.pop();
      if (!node) fail(cursor, `多余的结束标签 </${name}>`);
      if (node.name !== name) fail(cursor, `结束标签 </${name}> 与开始标签 <${node.name}> 不匹配`);
      cursor = end + 1;
      continue;
    }

    const end = findTagEnd(src, cursor);
    if (end === -1) fail(cursor, '开始标签没有 >');
    const body = src.slice(cursor + 1, end);
    const selfClosing = body.trimEnd().endsWith('/');
    const { name, attrs } = parseTagBody(selfClosing ? body.trimEnd().slice(0, -1) : body, cursor, fail);
    const node = { name, attrs, children: [], chunks: [] };
    if (stack.length === 0) {
      if (documentRoot) fail(cursor, '一个 XML 文档只能有一个根节点');
      documentRoot = node;
    } else {
      stack[stack.length - 1].children.push(node);
    }
    if (!selfClosing) stack.push(node);
    cursor = end + 1;
  }

  if (stack.length > 0) fail(src.length, `标签 <${stack[stack.length - 1].name}> 没有对应的结束标签`);
  if (!documentRoot) throw new ConversionError('DATA_READ_FAILED', 'XML 里没有找到任何标签');
  return xmlNodeToValue(documentRoot);
}

function findTagEnd(src, start) {
  let quote = null;
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i;
  }
  return -1;
}

const TAG_TOKEN = /([^\s=/<>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseTagBody(body, tagStart, fail) {
  TAG_TOKEN.lastIndex = 0;
  const first = TAG_TOKEN.exec(body);
  if (!first) fail(tagStart, '标签名是空的');
  const name = first[1];
  const attrs = {};
  let token = TAG_TOKEN.exec(body);
  while (token) {
    if (!token[1]) break;
    const value = token[2] ?? token[3] ?? token[4] ?? '';
    attrs[token[1]] = decodeXmlText(value);
    token = TAG_TOKEN.exec(body);
  }
  return { name, attrs };
}

function xmlNodeToValue(node) {
  const rawText = node.chunks.join('');
  const attrNames = Object.keys(node.attrs);
  const marker = attrNames.length === 1 ? node.attrs[XML_MARKER] : undefined;
  const isMarkerOnly = attrNames.length === 1 && XML_MARKER_TYPES.has(marker);

  if (node.children.length === 0) {
    if (marker === 'string' && isMarkerOnly) return rawText; // 纯空白字符串只能靠标记区分，不能 trim
    const text = decodeXmlText(rawText);
    if (isMarkerOnly) {
      if (marker === 'number') return toNumber(text);
      if (marker === 'boolean') return text === 'true';
      if (marker === 'null') return null;
      if (marker === 'array') return text === '' ? [] : [text];
      if (marker === 'object') return {};
    }
    if (attrNames.length > 0) {
      const value = {};
      for (const attr of attrNames) value[`@${attr}`] = node.attrs[attr];
      if (text !== '') value['#text'] = text;
      return value;
    }
    // 空叶子 = 空对象：空字符串一定带 prism-type="string" 标记，两者不会混淆
    return text === '' ? {} : text;
  }

  // 容器：@属性 + #text + 子元素
  const value = {};
  if (!isMarkerOnly) {
    for (const attr of attrNames) value[`@${attr}`] = node.attrs[attr];
  }
  // 混合内容里的缩进空白必须丢掉，否则漂亮打印会污染 #text
  const text = decodeXmlText(rawText).trim();
  if (text !== '') value['#text'] = text;

  const groups = new Map();
  for (const child of node.children) {
    if (!groups.has(child.name)) groups.set(child.name, []);
    groups.get(child.name).push(child);
  }
  let itemValues = null;
  for (const [childName, list] of groups) {
    const values = list.map(xmlNodeToValue);
    // 同名兄弟 = 数组；只有一个时直接给值。但 item 这一组必须留住整个列表：
    // prism-type="array" 的语义是「子元素都是我的数组元素」，折叠成一个就丢了嵌套（[[]] 会变成 []）。
    if (childName === 'item') itemValues = values;
    value[childName] = values.length === 1 ? values[0] : values;
  }

  if (marker === 'array' && isMarkerOnly) {
    if (groups.size === 1 && groups.has('item')) return itemValues ?? [];
    return [value];
  }
  return value;
}

function toNumber(text) {
  const num = Number(text);
  return Number.isNaN(num) ? text : num;
}

/* --- INI --- */

function parseIni(text) {
  const source = String(text ?? '');
  if (source.trim() === '') throw new ConversionError('DATA_EMPTY', 'INI 文件里没有内容');
  const root = {};
  let section = root;
  const lines = source.split(/\r\n|\r|\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) return;
    if (line.startsWith('[')) {
      const end = line.indexOf(']');
      if (end === -1) {
        throw new ConversionError('DATA_READ_FAILED', `INI 第 ${index + 1} 行：分区名缺少右括号 ]`);
      }
      const name = line.slice(1, end).trim();
      if (name === '') throw new ConversionError('DATA_READ_FAILED', `INI 第 ${index + 1} 行：分区名是空的`);
      if (!isPlainObject(root[name])) root[name] = {};
      section = root[name];
      return;
    }
    const eq = line.indexOf('=');
    if (eq === -1) {
      throw new ConversionError('DATA_READ_FAILED', `INI 第 ${index + 1} 行：既不是 [分区] 也不是 键 = 值`);
    }
    const key = line.slice(0, eq).trim();
    if (key === '') throw new ConversionError('DATA_READ_FAILED', `INI 第 ${index + 1} 行：等号左边没有键名`);
    assignDotted(section, key, parseIniValue(line.slice(eq + 1).trim()));
  });
  return root;
}

function parseIniValue(raw) {
  if (raw.length >= 2 && ((raw[0] === '"' && raw.endsWith('"')) || (raw[0] === "'" && raw.endsWith("'")))) {
    const inner = raw.slice(1, -1);
    // 引号是「这是字符串」的显式声明，不再做类型推断，否则 "123" 会变成数字
    return raw[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\') : inner;
  }
  return coerceScalarText(raw);
}

/** 深层结构在 INI 里压成 a.b[0].c 这样的路径键，解析时反着还原 */
function assignDotted(target, path, value) {
  const parts = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let token = re.exec(path);
  while (token) {
    parts.push(token[1] !== undefined ? token[1] : Number(token[2]));
    token = re.exec(path);
  }
  if (parts.length === 0) { target[path] = value; return; }
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!isPlainObject(node[key]) && !Array.isArray(node[key])) {
      node[key] = typeof parts[i + 1] === 'number' ? [] : {};
    }
    node = node[key];
  }
  node[parts[parts.length - 1]] = value;
}

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isPlainObject(value)) {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}

function indentUnitOf(option) {
  if (option === 'tab') return '\t';
  if (option === '4') return '    ';
  // '0' = 压缩：JSON 走单行、YAML 走流式、XML 不留任何空白
  if (option === '0') return '';
  return '  ';
}

function scalarText(value) {
  if (value === null || value === undefined) return 'null';
  if (value === '') return '""';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

async function serialize(value, target, api, notes) {
  const indentOption = String(api.opt('indent', '2'));
  const unit = indentUnitOf(indentOption);
  switch (target) {
    case 'json': return toJson(value, indentOption);
    case 'jsonl': return toJsonl(value, notes);
    case 'yaml': return toYaml(api, value, indentOption, notes);
    case 'xml': return toXml(value, api, unit, notes);
    case 'ini': return toIni(value, notes);
    case 'txt': return toText(value, api, unit, notes);
    default:
      throw new ConversionError('DATA_UNSUPPORTED', `结构化数据模块不支持输出 ${target.toUpperCase()}`);
  }
}

function toJson(value, indentOption) {
  if (indentOption === '0') return JSON.stringify(value);
  const space = indentOption === 'tab' ? '\t' : Number(indentOption) || 2;
  return JSON.stringify(value, null, space);
}

function toJsonl(value, notes) {
  const items = Array.isArray(value) ? value : [value];
  if (!Array.isArray(value)) notes.push({ level: 'info', message: '输入不是数组，已按「每行一个完整 JSON」输出单行' });
  return `${items.map((item) => JSON.stringify(item) ?? 'null').join('\n')}\n`;
}

async function toYaml(api, value, indentOption, notes) {
  const yaml = await api.lib('js-yaml');
  /** @type {{indent:number, lineWidth:number, noRefs:boolean, flowLevel?:number}} */
  const options = { indent: 2, lineWidth: -1, noRefs: true };
  if (indentOption === '4') options.indent = 4;
  else if (indentOption === 'tab') {
    notes.push({ level: 'info', message: 'YAML 规范不允许 Tab 缩进，已改用 2 空格' });
  } else if (indentOption === '0') {
    options.flowLevel = 0; // 全部走流式写法，配合 lineWidth:-1 就是一行
  }
  // lineWidth:-1 是「中文不变成 \uXXXX」的关键：默认 80 列折行会让 js-yaml 转到双引号转义写法
  return yaml.dump(value, options);
}

function toXml(value, api, unit, notes) {
  const rootTag = sanitizeTagName(api.opt('rootTag', 'root') || 'root');
  if (rootTag !== (api.opt('rootTag', 'root') || 'root')) {
    notes.push({ level: 'warn', message: `根标签名含非法字符，已改成 <${rootTag}>` });
  }
  const pretty = unit !== '';
  const lines = [];
  // 根元素只能有一个：顶层数组统一写成 <根 prism-type="array"><item>…</item></根>，
  // 直接重复根标签是非法 XML
  appendElementValue(lines, rootTag, value, 0, unit, notes);
  const body = pretty ? lines.join('\n') : lines.join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}${pretty ? '\n' : ''}`;
}

function sanitizeTagName(name) {
  // \w 只认 ASCII，会把「数据」这种中文标签名整片打成下划线，所以用 Unicode 类别
  const cleaned = String(name).trim().replace(/[^\p{L}\p{N}_.\-:]/gu, '_');
  if (!cleaned) return 'root';
  // XML 的 NameStartChar 不允许数字/点/连字符/冒号开头
  return /^[\p{N}.\-:]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * 写元素时数组走「单个元素 + item 子元素」的写法。
 * 用在「数组本身是数组的元素」这种嵌套上：直接展开成重复标签会让 [1,2] 和 [[1,2]] 长得一模一样。
 */
function appendElementValue(lines, tagName, value, depth, unit, notes) {
  if (Array.isArray(value)) {
    appendArrayElement(lines, tagName, value, depth, unit, notes);
    return;
  }
  appendElement(lines, tagName, value, depth, unit, notes);
}

/** 数组写成「一个」元素：<tag prism-type="array"><item>…</item></tag> */
function appendArrayElement(lines, tagName, value, depth, unit, notes) {
  const pad = unit.repeat(depth);
  if (value.length === 0) {
    lines.push(`${pad}<${tagName} ${XML_MARKER}="array"/>`);
    return;
  }
  lines.push(`${pad}<${tagName} ${XML_MARKER}="array">`);
  for (const item of value) appendElementValue(lines, 'item', item, depth + 1, unit, notes);
  lines.push(`${pad}</${tagName}>`);
}

/**
 * 把一个值写成 XML 元素。约定：@name → 属性；#text → 元素文本；
 * 对象里某个键的值是多个元素的数组时，重复同名标签（最常见、也最好读的形状）。
 */
function appendElement(lines, tagName, value, depth, unit, notes) {
  const pad = unit.repeat(depth);

  if (Array.isArray(value)) {
    if (value.length >= 2) {
      for (const item of value) appendElementValue(lines, tagName, item, depth, unit, notes);
      return;
    }
    // 空数组与单元素数组没法靠「重复」表达，用 prism-type="array" 标记
    appendArrayElement(lines, tagName, value, depth, unit, notes);
    return;
  }

  if (isPlainObject(value)) {
    const attrs = [];
    let text = null;
    const children = [];
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (key.startsWith('@')) attrs.push([key.slice(1), scalarText(child)]);
      else if (key === '#text') text = child === null || child === undefined ? '' : String(child);
      else children.push([key, child]);
    }
    const attrText = attrs.map(([name, val]) => ` ${sanitizeTagName(name)}="${encodeXmlAttr(val)}"`).join('');
    if (children.length === 0 && text === null) {
      // 空对象要打标记，否则 <tag/> 读回来会是空对象还是空字符串就分不清了（空字符串另有 string 标记）
      const empty = attrs.length === 0 ? ` ${XML_MARKER}="object"` : '';
      lines.push(`${pad}<${tagName}${attrText}${empty}/>`);
      return;
    }
    if (children.length === 0) {
      lines.push(`${pad}<${tagName}${attrText}>${encodeXmlText(text)}</${tagName}>`);
      return;
    }
    lines.push(`${pad}<${tagName}${attrText}>${text === null ? '' : encodeXmlText(text)}`);
    for (const [key, child] of children) {
      const childTag = sanitizeTagName(key);
      if (childTag !== key) notes.push({ level: 'warn', message: `键名「${key}」不是合法 XML 标签，已写成 <${childTag}>` });
      appendElement(lines, childTag, child, depth + 1, unit, notes);
    }
    lines.push(`${pad}</${tagName}>`);
    return;
  }

  if (value === null || value === undefined) {
    lines.push(`${pad}<${tagName} ${XML_MARKER}="null"/>`);
    return;
  }
  appendScalar(lines, tagName, value, depth, unit, notes);
}

/** 标量元素。字符串裸写；数字/布尔/null 打 prism-type 标记——只有本来就会丢类型的位置才有标记，XML 依旧好读 */
function appendScalar(lines, tagName, value, depth, unit, notes) {
  const pad = unit.repeat(depth);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      notes.push({ level: 'warn', message: `数值 ${value} 无法在 XML 里表示，已按字符串输出` });
      lines.push(`${pad}<${tagName} ${XML_MARKER}="string">${encodeXmlText(String(value))}</${tagName}>`);
      return;
    }
    lines.push(`${pad}<${tagName} ${XML_MARKER}="number">${encodeXmlText(String(value))}</${tagName}>`);
    return;
  }
  if (typeof value === 'boolean') {
    lines.push(`${pad}<${tagName} ${XML_MARKER}="boolean">${value ? 'true' : 'false'}</${tagName}>`);
    return;
  }
  const text = String(value);
  if (text === '' || text.trim() === '') {
    // 纯空白字符串与「空元素」在 XML 里长得一样，只能打标记，否则解析回来会丢
    lines.push(`${pad}<${tagName} ${XML_MARKER}="string">${encodeXmlText(text)}</${tagName}>`);
    return;
  }
  lines.push(`${pad}<${tagName}>${encodeXmlText(text)}</${tagName}>`);
}

function toIni(value, notes) {
  if (!isPlainObject(value)) {
    throw new ConversionError(
      'DATA_UNSUPPORTED',
      'INI 只能表示「键 = 值」结构，顶层必须是对象；顶层数组请先转成 JSON 或 YAML',
    );
  }
  const head = [];
  const sections = [];
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (isPlainObject(item) && Object.keys(item).length > 0) {
      const body = [];
      flattenIni(item, '', body, notes);
      sections.push(`[${key}]`, ...body, '');
      continue;
    }
    const flat = [];
    flattenIni({ [key]: item }, '', flat, notes);
    head.push(...flat);
  }
  const lines = [...head, ...(head.length > 0 && sections.length > 0 ? [''] : []), ...sections];
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

function flattenIni(value, prefix, out, notes) {
  if (Array.isArray(value)) {
    if (value.length === 0) { out.push(`${prefix} = []`); return; }
    value.forEach((item, index) => {
      if (isPlainObject(item) || Array.isArray(item)) flattenIni(item, `${prefix}[${index}]`, out, notes);
      else out.push(`${prefix}[${index}] = ${iniScalar(item)}`);
    });
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) { if (prefix) out.push(`${prefix} = {}`); return; }
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const item = value[key];
      if (isPlainObject(item) || Array.isArray(item)) {
        notes.push({ level: 'info', message: `INI 只支持两层以内，「${path}」这类更深的结构已压成 a.b[0] 形式的扁平键` });
        flattenIni(item, path, out, notes);
      } else out.push(`${path} = ${iniScalar(item)}`);
    }
    return;
  }
  if (prefix) out.push(`${prefix} = ${iniScalar(value)}`);
}

/** INI 没有类型：字符串按需加引号，否则 "123" 会被解析成数字、往返后类型就变了 */
function iniScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  if (text === '' || text.trim() !== text || /^[+-]?(\d|\.\d)|^(true|false|null)$/i.test(text)) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  return text;
}

/* --- txt：本产品锚点之一，三种样式都必须「看得懂、能直接粘进文档」 --- */

function toText(value, api, unit, notes) {
  const style = String(api.opt('txtStyle', 'tree'));
  // TXT 是给人看的：压成一行就完全没法读了，所以缩进选项在这里退回 2 空格
  const textUnit = unit === '' ? '  ' : unit;
  if (unit === '' && style !== 'table') {
    notes.push({ level: 'info', message: 'TXT 需要缩进才读得懂，缩进已按 2 空格输出' });
  }
  if (style === 'kv') return renderKv(value);
  if (style === 'table') return renderTable(value, notes);
  return renderTree(value, textUnit);
}

function renderTree(value, unit) {
  const lines = [];
  renderTreeNode(value, 0, null, lines, unit, false);
  return `${lines.join('\n')}\n`;
}

function renderTreeNode(value, depth, label, lines, unit, isArrayItem) {
  const pad = unit.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(label === null ? `${pad}（空数组）` : `${pad}${label}: （空数组）`);
      return;
    }
    if (label !== null && isScalarList(value)) {
      lines.push(`${pad}${label}: ${value.map(scalarText).join('、')}`);
      return;
    }
    if (label !== null) lines.push(`${pad}${label}:`);
    const inner = label !== null ? depth + 1 : depth;
    value.forEach((item, index) => {
      const itemPad = unit.repeat(inner);
      if (Array.isArray(item) || isPlainObject(item)) {
        lines.push(`${itemPad}${index + 1}.`);
        renderTreeNode(item, inner + 1, null, lines, unit, true);
      } else {
        lines.push(`${itemPad}${index + 1}. ${scalarText(item)}`);
      }
    });
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      lines.push(label === null ? `${pad}（空对象）` : `${pad}${label}: （空对象）`);
      return;
    }
    if (label !== null) lines.push(`${pad}${label}:`);
    const inner = label !== null ? depth + 1 : depth;
    const innerPad = unit.repeat(inner);
    const keyWidth = Math.max(...keys.map((key) => displayWidth(key)));
    for (const key of keys) {
      const item = value[key];
      if (Array.isArray(item) || isPlainObject(item)) renderTreeNode(item, inner, key, lines, unit, false);
      else pushKeyValue(lines, `${innerPad}${padDisplay(key, keyWidth)}`, item, innerPad);
    }
    return;
  }
  if (isArrayItem) lines.push(`${pad}${scalarText(value)}`);
  else if (label === null) lines.push(`${pad}${scalarText(value)}`);
  else lines.push(`${pad}${label}: ${scalarText(value)}`);
}

/** 值里有换行时，续行跟着键缩进，粘进文档才不会看起来像新的一条记录 */
function pushKeyValue(lines, prefix, value, innerPad) {
  const chunks = scalarText(value).split('\n');
  lines.push(`${prefix}: ${chunks[0]}`);
  for (const chunk of chunks.slice(1)) lines.push(`${innerPad}  ${chunk}`);
}

function isScalarList(value) {
  if (value.length === 0 || value.length > 5) return false;
  if (!value.every((item) => item === null || typeof item !== 'object')) return false;
  return value.reduce((sum, item) => sum + displayWidth(scalarText(item)), 0) <= 48;
}

function renderKv(value) {
  const pairs = [];
  walkKv(value, '', pairs);
  const width = Math.max(0, ...pairs.map(([path]) => displayWidth(path)));
  return `${pairs.map(([path, text]) => `${padDisplay(path, width)} = ${text}`).join('\n')}\n`;
}

function walkKv(value, path, out) {
  if (Array.isArray(value)) {
    if (value.length === 0) { out.push([path || '(根)', '[]']); return; }
    value.forEach((item, index) => walkKv(item, path ? `${path}[${index}]` : `[${index}]`, out));
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) { out.push([path || '(根)', '{}']); return; }
    for (const key of keys) walkKv(value[key], path ? `${path}.${key}` : key, out);
    return;
  }
  out.push([path || '(根)', scalarText(value)]);
}

function renderTable(value, notes) {
  const rows = toTableRows(value, notes);
  if (!rows) return renderKv(value);
  const { columns, records } = rows;
  const cells = records.map((record) => columns.map((column) => tableCell(record[column])));
  const widths = columns.map((column, index) => Math.max(
    displayWidth(column),
    ...cells.map((row) => displayWidth(row[index])),
  ));
  const header = columns.map((column, index) => padDisplay(column, widths[index])).join('  ');
  const rule = widths.map((width) => '-'.repeat(width)).join('  ');
  const body = cells.map((row) => row.map((cell, index) => padDisplay(cell, widths[index])).join('  ').trimEnd());
  return `${[header, rule, ...body].join('\n')}\n`;
}

/** 只有「对象数组」或「二维数组」才配得上等宽表格，别的形状老实退回键值列表 */
function toTableRows(value, notes) {
  if (!Array.isArray(value) || value.length === 0) {
    notes.push({ level: 'info', message: '数据不是对象数组，表格样式不适用，已改用「键 = 值」样式' });
    return null;
  }
  if (value.every((item) => Array.isArray(item))) {
    const width = Math.max(...value.map((row) => row.length));
    const columns = Array.from({ length: width }, (_, index) => `列${index + 1}`);
    return { columns, records: value.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]]))) };
  }
  if (!value.every((item) => isPlainObject(item))) {
    notes.push({ level: 'info', message: '数组里混了非对象元素，表格样式不适用，已改用「键 = 值」样式' });
    return null;
  }
  const columns = [];
  for (const item of value) {
    for (const key of Object.keys(item)) if (!columns.includes(key)) columns.push(key);
  }
  return { columns, records: value };
}

function tableCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).replace(/\s*\r?\n\s*/g, ' ');
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/** @param {import('./types.js').Input} input @param {Api} api */
export async function convert(input, api) {
  const target = resolveTarget(input, api);
  const source = readSource(api, input);
  if (!meta.to.includes(target)) {
    throw new ConversionError('DATA_UNSUPPORTED', `结构化数据模块不支持转成 ${target.toUpperCase()}`);
  }
  if (!meta.from.includes(source.ext)) {
    throw new ConversionError('DATA_UNSUPPORTED', `结构化数据模块不支持 .${source.ext} 这类输入`);
  }

  api.progress(0.1, '解析输入');
  const parsed = await parseInput(api, source);
  api.progress(0.5, '整理数据');
  const prepared = api.opt('sortKeys', false) ? sortKeysDeep(parsed) : parsed;

  api.progress(0.7, `生成 ${target.toUpperCase()}`);
  const notes = [];
  const text = await serialize(prepared, target, api, notes);
  // 统一走 api.note：引擎会把 api 侧的提示与返回值里的 notes 合并，两处都写会重复报给用户
  for (const note of notes) api.note(note.level, note.message);
  api.progress(0.9, '写出文件');

  const base = baseNameOf(source.name) || 'data';
  const fileName = api.fileName(`${base}.${target}`);
  return {
    files: [{ name: fileName, bytes: api.encode(text, api.opt('encoding', 'utf-8')), mime: mimeOfExt(target), kind: 'text' }],
    preview: text.slice(0, 2000),
  };
}
