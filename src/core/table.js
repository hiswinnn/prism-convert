/**
 * 表格互转：xlsx / xls / ods / csv / tsv → csv / tsv / xlsx / ods / json / md / html
 *
 * 设计要点：
 * 1) 内部只有一种模型：`{ name, rows }`，rows 是「行 → 单元格」的二维数组，单元格保留原类型
 *    （xlsx 里的数字/日期是真的数字/日期，csv 里的是字符串）。所有输出都从它出发，读写各写一次。
 * 2) 单元格类型只在「写出去」的那一刻决定长什么样：csv 里日期按 Excel 的显示习惯格式化，
 *    json 里数字还是数字。反过来，csv 的纯数字文本会被识别成数字（否则 csv→json 全是字符串，
 *    用起来很难受），前导零的编号、邮编、电话不在此列。
 * 3) 多工作表只在目标是 xlsx/ods 时才合成一个工作簿，其它目标一律一表一个文件，
 *    否则「三张表转 csv」会得到一坨谁也没法用的东西。
 *
 * 本文件顶层不 import 任何第三方库——xlsx 只在 convert() 里 await api.lib('xlsx') 取。
 * 同时共享 data.js 里的五个小工具（JSON 位置报错、显示宽度、右侧补齐、分隔符嗅探、文本类型识别）：
 * 它们是「表格 / 结构化数据」这条线共用的，放 util.js 会让所有模块共享的文件承担并行改动风险。
 */
import { ConversionError } from './errors.js';
import { canonicalExt } from './registry.js';
import { baseNameOf, extOf, htmlEscape, mimeOfExt, parseCsv, stringifyCsv, toBytes } from './util.js';
import { coerceScalarText, displayWidth, padDisplay, parseJsonText, sniffDelimiter } from './data.js';

/** @typedef {import('./types.js').Api} Api */

export const meta = {
  id: 'table', category: 'table', label: '表格',
  from: ['xlsx', 'xls', 'csv', 'tsv', 'ods'],
  to: ['csv', 'tsv', 'xlsx', 'json', 'md', 'html', 'ods'],
  priority: 80,
  options: [
    { key: 'sheet', type: 'select', label: '工作表', default: 'all', choices: [
      { value: 'all', label: '全部工作表' }, { value: 'first', label: '仅第一个' }] },
    { key: 'header', type: 'boolean', label: '首行作为表头', default: true },
    { key: 'delimiter', type: 'select', label: 'CSV 分隔符', default: ',', choices: [
      { value: ',', label: '逗号 ,' }, { value: ';', label: '分号 ;' }, { value: 'tab', label: '制表符 Tab' }] },
    { key: 'bom', type: 'boolean', label: 'CSV 加 UTF-8 BOM（Excel 打开不乱码）', default: true },
    { key: 'jsonShape', type: 'select', label: 'JSON 结构', default: 'array', choices: [
      { value: 'array', label: '对象数组' }, { value: 'columns', label: '{columns, rows}' }] },
    { key: 'encoding', type: 'encoding', label: '输出编码', default: 'utf-8' },
  ],
};

/** 超过这个单元格数就提醒一句：浏览器还能跑，但会很慢，界面该给用户心理预期 */
const CELL_WARN_LIMIT = 200000;
/** Excel 的工作表名上限 31 个字符，超了 SheetJS 会自己截断，不如我们先截得干净 */
const SHEET_NAME_LIMIT = 31;

const WORKBOOK_TARGETS = new Set(['xlsx', 'ods']);
const BINARY_SOURCES = new Set(['xlsx', 'xls', 'ods']);
const TEXT_SOURCES = new Set(['csv', 'tsv']);

/** 拿不到目标格式时的兜底（xlsx→csv、csv→xlsx，与 registry 的 DEFAULT_TARGET 一致） */
const DEFAULT_TARGET_BY_EXT = {
  xlsx: 'csv', xls: 'csv', ods: 'csv', csv: 'xlsx', tsv: 'csv', json: 'csv',
};

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * 输出格式来源（按优先级）：opt('target') / api.target / input.target → 按输入扩展名的默认值。
 * 引擎的 buildApi 三处都会挂上 target，取其一即可；默认值兜底的是「模块被直接调用」的场景
 * （测试、单元复用的调用方），否则 csv 这类多目标输入会不知道自己该输出什么。
 */
function resolveTarget(input, api) {
  const explicit = canonicalExt(api.opt('target', '') || api.target || input?.target || input?.outExt || '');
  if (explicit) return explicit;
  const ext = canonicalExt(input?.ext ?? api.input?.ext ?? extOf(input?.name ?? ''));
  return DEFAULT_TARGET_BY_EXT[ext] ?? 'csv';
}

/** @param {import('./types.js').Input} input @param {Api} api */
export async function convert(input, api) {
  const target = resolveTarget(input, api);
  if (!meta.to.includes(target)) {
    throw new ConversionError('TABLE_UNSUPPORTED', `表格模块不支持转成 ${target.toUpperCase()}`);
  }
  const source = readSource(api, input);
  if (!meta.from.includes(source.ext) && source.ext !== 'json') {
    throw new ConversionError('TABLE_UNSUPPORTED', `表格模块不支持 .${source.ext} 这类输入`);
  }

  api.progress(0.05, '读取表格');
  const sheets = await readSheets(api, source);
  api.progress(0.5, '整理数据');

  const selected = selectSheets(sheets, api);
  const totalCells = selected.reduce((sum, sheet) => sum + sheet.rows.length * (sheet.rows[0]?.length ?? 0), 0);
  if (totalCells > CELL_WARN_LIMIT) {
    api.note('warn', `表格较大（约 ${formatCount(totalCells)} 个单元格），转换会慢一些，请稍等`);
  }

  api.progress(0.7, `生成 ${target.toUpperCase()}`);
  const notes = [];
  const files = await writeOutput(selected, target, source, api, notes);
  // 统一走 api.note：引擎会把 api 侧的提示与返回值里的 notes 合并，两处都写会重复报给用户
  for (const note of notes) api.note(note.level, note.message);
  api.progress(0.95, '写出文件');

  const preview = files.find((file) => file.text !== undefined)?.text?.slice(0, 2000) ?? null;
  // text 只用于上面取预览，不进返回值——契约里 files 的成员是 {name, bytes, mime}
  return { files: files.map(({ name, bytes, mime, kind }) => ({ name, bytes, mime, kind })), preview };
}

function readSource(api, input) {
  const name = input?.name ?? api.input?.name ?? 'input.csv';
  const ext = canonicalExt(input?.ext ?? api.input?.ext ?? extOf(name));
  const bytes = toBytes(api.bytes());
  if (bytes.length === 0) {
    throw new ConversionError('TABLE_EMPTY', '文件是空的，没有可转换的表格内容');
  }
  return { name, ext, bytes };
}

function formatCount(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ------------------------------------------------------------------ *
 * 读
 * ------------------------------------------------------------------ */

async function readSheets(api, source) {
  const { ext, bytes } = source;
  if (BINARY_SOURCES.has(ext)) return readWorkbook(api, bytes, ext);
  if (TEXT_SOURCES.has(ext)) return readDelimited(api, source);
  if (ext === 'json') return readJson(api, source);
  // 扩展名不认识时按内容兜底：PK 头是 xlsx/ods，OLE 头是 xls
  if (looksLikeZip(bytes)) return readWorkbook(api, bytes, 'xlsx');
  if (looksLikeOle(bytes)) return readWorkbook(api, bytes, 'xls');
  return readDelimited(api, source);
}

function looksLikeZip(bytes) {
  return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

function looksLikeOle(bytes) {
  return bytes.length > 7 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

async function readWorkbook(api, bytes, ext) {
  const xlsx = await api.lib('xlsx');
  let workbook;
  try {
    // cellDates:true 让日期单元格直接给 Date，后面按本地时区分量格式化，避免时区把日期退回前一天
    workbook = xlsx.read(bytes, { type: 'array', cellDates: true });
  } catch (err) {
    throw new ConversionError(
      'TABLE_READ_FAILED',
      `读不出这个 ${ext.toUpperCase()} 文件：${describeReadError(err)}。文件可能已损坏，或它其实是别的格式被改了扩展名。`,
      { cause: err, detail: err?.message },
    );
  }
  const names = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames : [];
  if (names.length === 0) {
    throw new ConversionError('TABLE_READ_FAILED', `这个 ${ext.toUpperCase()} 文件里没有任何工作表，可能已损坏或只存了空的框架`);
  }
  const sheets = [];
  for (const name of names) {
    const rows = sheetToRows(xlsx, workbook.Sheets[name]);
    if (rows.length > 0) sheets.push({ name: String(name), rows });
  }
  if (sheets.length === 0) {
    throw new ConversionError('TABLE_EMPTY', '所有工作表都是空的，没有可转换的内容');
  }
  return sheets;
}

function describeReadError(err) {
  const message = String(err?.message ?? err ?? '未知错误');
  if (/Unsupported file|File is not/i.test(message)) return '这不是有效的 Excel/ODS 文件';
  if (/password|encrypt/i.test(message)) return '文件有密码保护，请先用 Excel 去掉密码';
  return message.split('\n')[0].slice(0, 120);
}

function sheetToRows(xlsx, sheet) {
  if (!sheet) return [];
  // header:1 拿到二维数组；blankrows:true 保住中间的空行（末尾空行由 normalizeRows 收掉）
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: true });
  return normalizeRows(rows);
}

function readDelimited(api, source) {
  const text = api.text();
  if (text.trim() === '') {
    throw new ConversionError('TABLE_EMPTY', '文件里只有空白字符，没有可转换的表格内容');
  }
  const preferred = delimiterChar(api.opt('delimiter', ','), source.ext);
  const { delimiter, sniffed } = sniffDelimiter(text, preferred);
  if (sniffed) {
    api.note('info', `按内容识别出分隔符是「${labelDelimiter(delimiter)}」，已按它解析`);
  }
  const rows = normalizeRows(parseCsv(text, delimiter));
  if (rows.length === 0) {
    throw new ConversionError('TABLE_EMPTY', '文件里没有可转换的表格行');
  }
  return [{ name: '', rows }];
}

function readJson(api, source) {
  const parsed = parseJsonText(api.text(), { code: 'TABLE_READ_FAILED', format: 'JSON' });
  const rows = jsonToRows(parsed, api);
  if (rows.length === 0) {
    throw new ConversionError('TABLE_EMPTY', 'JSON 里没有可以排成表格的记录');
  }
  return [{ name: '', rows }];
}

function jsonToRows(value, api) {
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    if (value.every((item) => Array.isArray(item))) return normalizeRows(value.map((row) => row.slice()));
    if (value.every((item) => isPlainObject(item))) {
      api.note('info', 'JSON 对象数组已按「键 → 列」展开成表格');
      return recordsToRows(value, api);
    }
    api.note('info', 'JSON 数组里不是对象，已按单列输出');
    return normalizeRows(value.map((item) => [item]));
  }
  if (isPlainObject(value)) {
    if (Array.isArray(value.rows)) return normalizeRows(value.rows.map((row) => (Array.isArray(row) ? row.slice() : [row])));
    api.note('info', 'JSON 是单个对象，已按「键 / 值」两列输出');
    return normalizeRows(Object.entries(value).map(([key, item]) => [key, item]));
  }
  throw new ConversionError('TABLE_READ_FAILED', '这个 JSON 不是数组或对象，排不成表格');
}

/** 对象数组 → 表格：列取所有键的并集（对象数组里常有缺键，少列会丢数据） */
function recordsToRows(records, api) {
  const columns = [];
  for (const record of records) {
    for (const key of Object.keys(record)) if (!columns.includes(key)) columns.push(key);
  }
  let nested = 0;
  const rows = [columns.slice()];
  for (const record of records) {
    rows.push(columns.map((key) => {
      const value = record[key];
      if (isPlainObject(value) || Array.isArray(value)) { nested += 1; return JSON.stringify(value); }
      return value === undefined ? null : value;
    }));
  }
  if (nested > 0) {
    api.note('warn', `有 ${nested} 处嵌套的对象/数组，已序列化成 JSON 文本放进单元格`);
  }
  return normalizeRows(rows);
}

function delimiterChar(option, ext) {
  if (ext === 'tsv') return '\t';
  if (option === 'tab') return '\t';
  return option === ';' ? ';' : ',';
}

function labelDelimiter(delimiter) {
  if (delimiter === '\t') return 'Tab';
  return delimiter;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** 补齐每行长度到同一列数，并去掉末尾的整空行（csv 末尾的换行、Excel 的空尾行都会产生它） */
function normalizeRows(rows) {
  const grid = rows.filter((row) => Array.isArray(row));
  while (grid.length > 0 && isEmptyRow(grid[grid.length - 1])) grid.pop();
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  return grid.map((row) => {
    const out = row.slice(0, width);
    while (out.length < width) out.push(null);
    return out;
  });
}

function isEmptyRow(row) {
  return row.every((cell) => cell === null || cell === undefined || String(cell).trim() === '');
}

/* ------------------------------------------------------------------ *
 * 选表 / 写
 * ------------------------------------------------------------------ */

function selectSheets(sheets, api) {
  if (api.opt('sheet', 'all') === 'first') return sheets.slice(0, 1);
  return sheets;
}

async function writeOutput(selected, target, source, api, notes) {
  const base = baseNameOf(source.name) || 'table';
  const suffixFor = (sheet, index, count) => (count > 1 ? `-${sheetNameForFile(sheet, index)}` : '');
  if (WORKBOOK_TARGETS.has(target)) {
    return [await writeWorkbook(selected, target, base, api)];
  }
  if (target === 'csv' || target === 'tsv') {
    return selected.map((sheet, index) => writeDelimitedSheet(sheet, target, base, suffixFor(sheet, index, selected.length), api));
  }
  if (target === 'json') {
    return selected.map((sheet, index) => {
      const text = sheetToJson(sheet, api, notes);
      const name = api.fileName(`${base}${suffixFor(sheet, index, selected.length)}.json`);
      return { name, bytes: api.encode(text, api.opt('encoding', 'utf-8')), mime: mimeOfExt('json'), kind: 'text', text };
    });
  }
  if (target === 'md') {
    return selected.map((sheet, index) => {
      const text = sheetToMarkdown(sheet, api, notes);
      const name = api.fileName(`${base}${suffixFor(sheet, index, selected.length)}.md`);
      return { name, bytes: api.encode(text, api.opt('encoding', 'utf-8')), mime: mimeOfExt('md'), kind: 'text', text };
    });
  }
  if (target === 'html') {
    return selected.map((sheet, index) => {
      const text = sheetToHtml(sheet, base, api);
      const name = api.fileName(`${base}${suffixFor(sheet, index, selected.length)}.html`);
      return { name, bytes: api.encode(text, api.opt('encoding', 'utf-8')), mime: mimeOfExt('html'), kind: 'text', text };
    });
  }
  throw new ConversionError('TABLE_UNSUPPORTED', `表格模块不支持转成 ${target.toUpperCase()}`);
}

function sheetNameForFile(sheet, index) {
  const fallback = `表${index + 1}`;
  const raw = sheet.name && sheet.name !== '' ? sheet.name : fallback;
  return String(raw).slice(0, SHEET_NAME_LIMIT);
}

function encodeTextOutput(api, text, { bom = false } = {}) {
  let encoding = String(api.opt('encoding', 'utf-8') ?? 'utf-8');
  // BOM 只对 UTF-8 有意义；用户选了 GBK 之类就别硬塞 BOM，那是乱码来源
  if (bom && (encoding === 'utf-8' || encoding === 'utf-8-bom')) encoding = 'utf-8-bom';
  return api.encode(text, encoding);
}

function writeDelimitedSheet(sheet, target, base, suffix, api) {
  const delimiter = target === 'tsv' ? '\t' : delimiterChar(api.opt('delimiter', ','), target);
  const body = sheet.rows.map((row) => row.map(cellToText));
  const text = `${stringifyCsv(body, delimiter)}\r\n`;
  const name = api.fileName(`${base}${suffix}.${target}`);
  const bom = api.opt('bom', true);
  return {
    name,
    bytes: encodeTextOutput(api, text, { bom }),
    mime: mimeOfExt(target),
    kind: 'text',
    text,
  };
}

async function writeWorkbook(selected, target, base, api) {
  const xlsx = await api.lib('xlsx');
  const workbook = xlsx.utils.book_new();
  const used = new Set();
  selected.forEach((sheet, index) => {
    const name = uniqueSheetName(sheetNameForFile(sheet, index), used);
    const worksheet = xlsx.utils.aoa_to_sheet(sheet.rows.map((row) => row.map(cellToExcel)));
    worksheet['!cols'] = columnWidths(sheet.rows);
    xlsx.utils.book_append_sheet(workbook, worksheet, name);
  });
  const written = xlsx.write(workbook, { type: 'array', bookType: target === 'ods' ? 'ods' : 'xlsx', cellDates: true });
  return {
    name: api.fileName(`${base}.${target}`),
    bytes: toBytes(written),
    mime: mimeOfExt(target),
    kind: 'binary',
  };
}

/** Excel 不允许同名工作表，也不允许空名 */
function uniqueSheetName(name, used) {
  const cleaned = String(name ?? '').slice(0, SHEET_NAME_LIMIT) || 'Sheet1';
  if (!used.has(cleaned)) { used.add(cleaned); return cleaned; }
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${cleaned.slice(0, SHEET_NAME_LIMIT - 3)}(${i})`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
  const fallback = `Sheet${used.size + 1}`;
  used.add(fallback);
  return fallback;
}

function columnWidths(rows) {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const widths = [];
  for (let col = 0; col < width; col += 1) {
    let best = 6;
    for (const row of rows) best = Math.max(best, displayWidth(cellToText(row[col])));
    widths.push({ wch: Math.min(60, best + 2) });
  }
  return widths;
}

/* ------------------------------------------------------------------ *
 * 单元格 → 各种输出
 * ------------------------------------------------------------------ */

const pad2 = (value) => String(value).padStart(2, '0');

/**
 * 日期单元格在 cellDates:true 下是本地时区的 Date。
 * 两处坑：
 * 1) 用本地分量拼字符串（不是 toISOString）——东八区 2024-01-01 00:00 转 ISO 会退回 2023-12-31；
 * 2) 四舍五入到秒——Excel 序列号只有约 15 位有效数字，读回来常带亚秒误差（00:00:00 会变成
 *    前一天 23:59:59.999），用户看到的日期就无缘无故少一天。
 */
function formatDateCell(input) {
  const date = new Date(Math.round(input.getTime() / 1000) * 1000);
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const h = date.getHours();
  const m = date.getMinutes();
  const s = date.getSeconds();
  if (h === 0 && m === 0 && s === 0) return day;
  return `${day} ${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function cellToText(cell) {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return formatDateCell(cell);
  if (typeof cell === 'object') return JSON.stringify(cell);
  return String(cell);
}

/** 写进 Excel 的单元格：Date 保留成日期、数字保留成数字，字符串原样（不猜类型，Excel 自己会提示） */
function cellToExcel(cell) {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return cell;
  if (typeof cell === 'object') return JSON.stringify(cell);
  return cell;
}

/**
 * 单元格 → JSON 值。
 * csv 进来的都是字符串，纯数字/布尔文本会被识别成对应类型（前导零的编号、邮编、电话除外），
 * 否则 csv→json 得到一堆带引号的数字，用起来很难受；xlsx 进来的本来就带类型，原样保留。
 */
function cellToJsonValue(cell, stats) {
  if (cell === null || cell === undefined) return null;
  if (cell instanceof Date) return formatDateCell(cell);
  if (typeof cell === 'string') {
    const coerced = coerceScalarText(cell);
    if (typeof coerced !== 'string' && stats) stats.coerced += 1;
    return coerced;
  }
  return cell;
}

function sheetToJson(sheet, api, notes) {
  const header = api.opt('header', true) !== false;
  const shape = String(api.opt('jsonShape', 'array'));
  const rows = sheet.rows;
  const stats = { coerced: 0 };
  let value;
  if (shape === 'columns') {
    if (!header) {
      notes.push({ level: 'info', message: '「首行作为表头」已关闭，{columns, rows} 里的 columns 只能是空的' });
    }
    const columns = header ? (rows[0] ?? []).map(columnName) : [];
    const body = header ? rows.slice(1) : rows;
    value = { columns, rows: body.map((row) => row.map((cell) => cellToJsonValue(cell, stats))) };
  } else if (!header) {
    value = rows.map((row) => row.map((cell) => cellToJsonValue(cell, stats)));
  } else {
    const [head, ...body] = rows;
    const columns = (head ?? []).map(columnName);
    const seen = new Map();
    const keys = columns.map((column, index) => {
      const count = (seen.get(column) ?? 0) + 1;
      seen.set(column, count);
      return count === 1 ? column : `${column}_${count}`;
    });
    if (keys.join('\u0000') !== columns.join('\u0000')) {
      notes.push({ level: 'warn', message: '表头里有重名的列，已给后面的同名列加 _2、_3 后缀，避免 JSON 里互相覆盖' });
    }
    value = body.map((row) => {
      const record = {};
      keys.forEach((key, index) => { record[key] = cellToJsonValue(row[index], stats); });
      return record;
    });
  }
  if (stats.coerced > 0) {
    notes.push({ level: 'info', message: `有 ${stats.coerced} 个「看起来是数字/布尔值」的文本已按对应类型输出（前导零的编号、邮编、电话会保留为文本）` });
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

function columnName(cell, index) {
  const text = cellToText(cell).trim();
  if (text !== '') return text;
  return `列${index + 1}`;
}

/** Markdown 表格：列宽按显示宽度（中文=2）补齐，源码里列也是齐的 */
function sheetToMarkdown(sheet, api, notes) {
  const rows = sheet.rows;
  if (rows.length === 0) return '';
  const header = api.opt('header', true) !== false;
  const cells = rows.map((row) => row.map(cellToMarkdown));
  const head = cells[0];
  const body = cells.slice(1);
  if (!header) {
    notes.push({ level: 'info', message: '「首行作为表头」已关闭，但 Markdown 表格必须有表头，仍用第一行当表头' });
  }
  const columns = Math.max(head.length, ...body.map((row) => row.length), 1);
  const widths = [];
  for (let col = 0; col < columns; col += 1) {
    let width = displayWidth(head[col] ?? '');
    for (const row of body) width = Math.max(width, displayWidth(row[col] ?? ''));
    widths.push(Math.max(width, 3)); // 分隔行至少要 ---
  }
  const line = (row) => `| ${widths.map((width, col) => padDisplay(row[col] ?? '', width)).join(' | ')} |`;
  const rule = `|${widths.map((width) => `${'-'.repeat(width + 2)}|`).join('')}`;
  return `${[line(head), rule, ...body.map(line)].join('\n')}\n`;
}

function cellToMarkdown(cell) {
  // 竖线会破坏表格结构，换行只能靠 <br>（Markdown 单元格里不能有真换行）
  return cellToText(cell).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/** HTML 表格：单文件自带 charset 与内联样式，双击就能看、复制到别处也不掉样子 */
function sheetToHtml(sheet, base, api) {
  const rows = sheet.rows;
  const header = api.opt('header', true) !== false;
  const title = sheet.name && sheet.name !== '' ? sheet.name : base;
  const cellStyle = 'border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top';
  const headStyle = `${cellStyle};background:#f2f4f7;font-weight:600`;
  const renderRow = (row, style, tag) => `      <tr>${row.map((cell) => `<${tag} style="${style}">${htmlCell(cell)}</${tag}>`).join('')}</tr>`;
  const head = rows[0] ?? [];
  const body = rows.slice(1);
  const parts = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${htmlEscape(title)}</title>`,
    '</head>',
    '<body style="margin:24px;font-family:-apple-system,\'Segoe UI\',\'Microsoft YaHei\',sans-serif;font-size:14px;color:#1f2328">',
    `<table style="border-collapse:collapse;min-width:320px">`,
  ];
  if (header) {
    parts.push('    <thead>', renderRow(head, headStyle, 'th'), '    </thead>');
    parts.push('    <tbody>', ...body.map((row) => renderRow(row, cellStyle, 'td')), '    </tbody>');
  } else {
    parts.push('    <tbody>', ...rows.map((row) => renderRow(row, cellStyle, 'td')), '    </tbody>');
  }
  parts.push('</table>', '</body>', '</html>');
  return `${parts.join('\n')}\n`;
}

function htmlCell(cell) {
  return htmlEscape(cellToText(cell)).replace(/\r?\n/g, '<br>');
}
