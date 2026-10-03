/**
 * 表格模块测试：node --test
 * fixture 全部现场生成（SheetJS / 字符串），不提交二进制大文件。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as table from '../src/core/table.js';
import { displayWidth } from '../src/core/data.js';
import { parseCsv } from '../src/core/util.js';
import { createApi, expectConversionError, fileOf, textOf } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures');

async function xlsxBytes(build) {
  const xlsx = await import('xlsx');
  const workbook = xlsx.utils.book_new();
  build(xlsx, workbook);
  return new Uint8Array(xlsx.write(workbook, { type: 'array', bookType: 'xlsx' }));
}

async function convertCsvFirst(text, options = {}) {
  const api = createApi(text, { name: 'input.csv', ext: 'csv', options });
  const result = await table.convert(api.input, api);
  return { result, api };
}

test('meta 声明与实现一致（界面靠它渲染选项）', () => {
  assert.equal(table.meta.id, 'table');
  assert.equal(table.meta.category, 'table');
  assert.deepEqual(table.meta.from, ['xlsx', 'xls', 'csv', 'tsv', 'ods']);
  assert.ok(table.meta.to.includes('csv') && table.meta.to.includes('ods'));
  const keys = table.meta.options.map((option) => option.key);
  assert.deepEqual(keys, ['sheet', 'header', 'delimiter', 'bom', 'jsonShape', 'encoding']);
  for (const option of table.meta.options) {
    assert.ok(option.label && option.default !== undefined, `选项 ${option.key} 缺 label/default`);
  }
});

test('xlsx → csv：中文原样保留', async () => {
  const bytes = await xlsxBytes((xlsx, workbook) => {
    xlsx.utils.book_append_sheet(
      workbook,
      xlsx.utils.aoa_to_sheet([['姓名', '城市', '备注'], ['张三', '北京', '老同学'], ['李四', '上海', '']]),
      '员工表',
    );
  });
  const api = createApi(bytes, { name: '员工.xlsx', ext: 'xlsx', options: { target: 'csv' } });
  const result = await table.convert(api.input, api);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].name, '员工.csv');
  const text = textOf(result);
  assert.match(text, /姓名,城市,备注/);
  assert.match(text, /张三,北京,老同学/);
  // api.text() 与文件内容都要能看见中文，避免只验证「没报错」
  assert.ok(text.includes('李四'), '结果里应出现中文姓名');
});

test('csv → xlsx → csv 往返：带逗号、引号、换行的字段不丢', async () => {
  const original = '标题,描述,数量\r\n"带,逗号","他说""你好""",3\r\n多行,"第一行\n第二行",4\r\n';
  const toXlsx = createApi(original, { name: '订单.csv', ext: 'csv', options: { target: 'xlsx' } });
  const xlsxResult = await table.convert(toXlsx.input, toXlsx);
  assert.equal(xlsxResult.files[0].name, '订单.xlsx');
  assert.equal(xlsxResult.files[0].bytes[0], 0x50, 'xlsx 应该是 zip 容器（PK）');

  const back = createApi(xlsxResult.files[0].bytes, { name: '订单.xlsx', ext: 'xlsx', options: { target: 'csv' } });
  const csvResult = await table.convert(back.input, back);
  const rows = parseCsv(textOf(csvResult));
  assert.deepEqual(rows[0], ['标题', '描述', '数量']);
  assert.deepEqual(rows[1], ['带,逗号', '他说"你好"', '3']);
  assert.deepEqual(rows[2], ['多行', '第一行\n第二行', '4']);
  assert.deepEqual(rows, parseCsv(original).filter((row) => row.length > 1 || row[0] !== ''));
});

test('多工作表：目标不是 xlsx 时一表一个文件，目标是 xlsx 时合成一个工作簿', async () => {
  const bytes = await xlsxBytes((xlsx, workbook) => {
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['a', 'b'], [1, 2]]), '第一表');
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['中文列'], ['广州']]), '第二表');
  });

  const csvApi = createApi(bytes, { name: '季度报表.xlsx', ext: 'xlsx', options: { target: 'csv' } });
  const csvResult = await table.convert(csvApi.input, csvApi);
  assert.deepEqual(csvResult.files.map((file) => file.name), ['季度报表-第一表.csv', '季度报表-第二表.csv']);
  assert.ok(textOf(csvResult, '季度报表-第二表.csv').includes('广州'));

  const xlsxApi = createApi(csvResult.files[0].bytes, {
    name: '季度报表-第一表.csv', ext: 'csv', options: { target: 'xlsx' },
  });
  const single = await table.convert(xlsxApi.input, xlsxApi);
  assert.equal(single.files.length, 1);
  assert.equal(single.files[0].name, '季度报表-第一表.xlsx');

  // sheet:'first' 只留第一张表
  const firstApi = createApi(bytes, { name: '季度报表.xlsx', ext: 'xlsx', options: { target: 'csv', sheet: 'first' } });
  const firstResult = await table.convert(firstApi.input, firstApi);
  assert.deepEqual(firstResult.files.map((file) => file.name), ['季度报表.csv']);

  // xlsx → xlsx 保持多表在同一工作簿
  const keepApi = createApi(bytes, { name: '季度报表.xlsx', ext: 'xlsx', options: { target: 'xlsx' } });
  const keepResult = await table.convert(keepApi.input, keepApi);
  assert.equal(keepResult.files.length, 1);
  const xlsx = await import('xlsx');
  const reopened = xlsx.read(keepResult.files[0].bytes, { type: 'array' });
  assert.deepEqual(reopened.SheetNames, ['第一表', '第二表']);
});

test('BOM 选项：打开时字节以 EF BB BF 开头，关闭时不加', async () => {
  const withBom = await convertCsvFirst('姓名,城市\r\n张三,北京\r\n', { target: 'csv', bom: true });
  const bytes = fileOf(withBom.result).bytes;
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);

  const withoutBom = await convertCsvFirst('姓名,城市\r\n张三,北京\r\n', { target: 'csv', bom: false });
  const plain = fileOf(withoutBom.result).bytes;
  assert.notDeepEqual([...plain.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(textOf(withoutBom.result).includes('张三'));
});

test('分隔符选项：分号与 Tab 都按选择输出', async () => {
  const semi = await convertCsvFirst('a;b\r\n1;2\r\n', { target: 'csv', delimiter: ';' });
  assert.match(textOf(semi.result), /^a;b/m);
  const tsv = await convertCsvFirst('a,b\r\n1,2\r\n', { target: 'tsv' });
  assert.match(textOf(tsv.result), /^a\tb/m);
  assert.equal(tsv.result.files[0].name, 'input.tsv');
});

test('tsv → csv：制表符换成分隔符，中文不受影响', async () => {
  const api = createApi('名称\t数量\n苹果\t3\n香蕉\t5\n', { name: '水果.tsv', ext: 'tsv', options: { target: 'csv' } });
  const result = await table.convert(api.input, api);
  assert.equal(result.files[0].name, '水果.csv');
  const rows = parseCsv(textOf(result));
  assert.deepEqual(rows[1], ['苹果', '3']);
});

test('CSV → JSON：对象数组与 {columns, rows} 两种结构', async () => {
  const source = '姓名,年龄\r\n张三,30\r\n李四,25\r\n';
  const arrayApi = createApi(source, { name: 'people.csv', ext: 'csv', options: { target: 'json', jsonShape: 'array' } });
  const arrayResult = await table.convert(arrayApi.input, arrayApi);
  const records = JSON.parse(textOf(arrayResult));
  assert.deepEqual(records, [{ 姓名: '张三', 年龄: 30 }, { 姓名: '李四', 年龄: 25 }]);
  assert.equal(typeof records[0].年龄, 'number', '纯数字文本应还原成数字');

  const columnsApi = createApi(source, { name: 'people.csv', ext: 'csv', options: { target: 'json', jsonShape: 'columns' } });
  const columnsResult = await table.convert(columnsApi.input, columnsApi);
  assert.deepEqual(JSON.parse(textOf(columnsResult)), { columns: ['姓名', '年龄'], rows: [['张三', 30], ['李四', 25]] });
});

test('CSV → JSON：前导零编号/邮编保持文本，无表头时输出二维数组', async () => {
  const api = createApi('编号,邮编\r\n007,100080\r\n', { name: 'codes.csv', ext: 'csv', options: { target: 'json' } });
  const result = await table.convert(api.input, api);
  const records = JSON.parse(textOf(result));
  assert.equal(records[0].编号, '007');
  assert.equal(records[0].邮编, 100080);

  const noHeader = createApi('a,b\r\n1,2\r\n', {
    name: 'raw.csv', ext: 'csv', options: { target: 'json', header: false },
  });
  const noHeaderResult = await table.convert(noHeader.input, noHeader);
  assert.deepEqual(JSON.parse(textOf(noHeaderResult)), [['a', 'b'], [1, 2]]);
});

test('JSON → CSV / XLSX：对象数组展开，嵌套值序列化成 JSON 文本并给出提示', async () => {
  const source = JSON.stringify([
    { 姓名: '张三', 标签: ['北京', '作家'], 详情: { 城市: '北京' } },
    { 姓名: '李四', 标签: [], 详情: { 城市: '上海' } },
  ]);
  const csvApi = createApi(source, { name: 'people.json', ext: 'json', options: { target: 'csv' } });
  const csvResult = await table.convert(csvApi.input, csvApi);
  const rows = parseCsv(textOf(csvResult));
  assert.deepEqual(rows[0], ['姓名', '标签', '详情']);
  assert.equal(rows[1][1], '["北京","作家"]');
  const warnings = csvApi.notes.filter((note) => note.level === 'warn');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /嵌套/);

  const xlsxApi = createApi(source, { name: 'people.json', ext: 'json', options: { target: 'xlsx' } });
  const xlsxResult = await table.convert(xlsxApi.input, xlsxApi);
  const xlsx = await import('xlsx');
  const reopened = xlsx.read(xlsxResult.files[0].bytes, { type: 'array' });
  const sheet = xlsx.utils.sheet_to_json(reopened.Sheets[reopened.SheetNames[0]], { header: 1 });
  assert.deepEqual(sheet[1][0], '张三');
});

test('Markdown 输出：中文按 2 列宽对齐', async () => {
  const api = createApi('姓名,城市\r\n张三,北京\r\n李四四,上海\r\n', {
    name: 'people.csv', ext: 'csv', options: { target: 'md' },
  });
  const result = await table.convert(api.input, api);
  const lines = textOf(result).split('\n');
  assert.match(lines[0], /^\| 姓名\s+\| 城市 \|$/);
  assert.match(lines[1], /^\|\s*-+\s*\|\s*-+\s*\|$/);
  // 「张三」显示宽度 4、「李四四」6，列宽取大者，两个数据行的第二根竖线要落在同一显示列
  const columnOf = (line, marker) => displayWidth(line.slice(0, line.indexOf(marker, 2)));
  assert.equal(columnOf(lines[2], '|'), columnOf(lines[3], '|'), '中文列对齐后竖线位置应一致');
  assert.ok(lines[2].includes('张三') && lines[3].includes('李四四'));
});

test('HTML 输出：带 charset、标题与内联样式的 <table>', async () => {
  const api = createApi('姓名,城市\r\n张三,北京\r\n', {
    name: 'people.csv', ext: 'csv', options: { target: 'html' },
  });
  const result = await table.convert(api.input, api);
  const html = textOf(result);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<table style="border-collapse:collapse/);
  assert.match(html, /<th style="border:1px solid #d0d7de/);
  assert.ok(html.includes('<td style=') && html.includes('张三'));
});

test('日期单元格按本地日期输出，不会因时区退回前一天', async () => {
  const bytes = await xlsxBytes((xlsx, workbook) => {
    const sheet = xlsx.utils.aoa_to_sheet([['日期'], [new Date(2024, 0, 1)]]);
    xlsx.utils.book_append_sheet(workbook, sheet, '日期表');
  });
  const api = createApi(bytes, { name: '日期.xlsx', ext: 'xlsx', options: { target: 'csv' } });
  const result = await table.convert(api.input, api);
  assert.match(textOf(result), /2024-01-01/);
});

test('大表（>20 万单元格）给出警告但仍然完成', async () => {
  const rows = [];
  const columns = new Array(120).fill('列');
  rows.push(columns);
  for (let i = 0; i < 2000; i += 1) rows.push(columns.map((_, index) => `${i}-${index}`));
  const csv = rows.map((row) => row.join(',')).join('\r\n');
  const api = createApi(csv, { name: 'big.csv', ext: 'csv', options: { target: 'csv' } });
  const result = await table.convert(api.input, api);
  assert.equal(result.files.length, 1);
  const warned = api.notes.find((note) => note.level === 'warn' && /单元格/.test(note.message));
  assert.ok(warned, `应给出大表警告，实际提示：${JSON.stringify(api.notes)}`);
  assert.match(warned.message, /240,120/);
});

test('坏 xlsx / 空文件：抛 ConversionError 且 code 正确', async () => {
  const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]);
  const brokenApi = createApi(broken, { name: 'broken.xlsx', ext: 'xlsx', options: { target: 'csv' } });
  const error = await expectConversionError(() => table.convert(brokenApi.input, brokenApi), 'TABLE_READ_FAILED');
  assert.match(error.message, /读不出|损坏/);

  const emptyApi = createApi('', { name: 'empty.csv', ext: 'csv', options: { target: 'csv' } });
  const emptyError = await expectConversionError(() => table.convert(emptyApi.input, emptyApi), 'TABLE_EMPTY');
  assert.match(emptyError.message, /空/);

  const blankXlsx = await xlsxBytes((xlsx, workbook) => {
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([]), '空表');
  });
  const blankApi = createApi(blankXlsx, { name: 'blank.xlsx', ext: 'xlsx', options: { target: 'csv' } });
  await expectConversionError(() => table.convert(blankApi.input, blankApi), 'TABLE_EMPTY');
});

test('不支持的目标格式：报 TABLE_UNSUPPORTED', async () => {
  const api = createApi('a,b\r\n1,2\r\n', {
    name: 'input.csv', ext: 'csv', options: { target: 'txt' },
  });
  await expectConversionError(() => table.convert(api.input, api), 'TABLE_UNSUPPORTED');
});

test('ODS 往返：csv → ods → csv，中文与数字都不丢', async () => {
  const api = createApi('姓名,年龄\r\n张三,30\r\n李四,25\r\n', {
    name: 'people.csv', ext: 'csv', options: { target: 'ods' },
  });
  const odsResult = await table.convert(api.input, api);
  assert.equal(odsResult.files[0].name, 'people.ods');
  assert.equal(odsResult.files[0].bytes[0], 0x50, 'ods 应该是 zip 容器（PK）');

  const back = createApi(odsResult.files[0].bytes, { name: 'people.ods', ext: 'ods', options: { target: 'csv' } });
  const csvResult = await table.convert(back.input, back);
  const rows = parseCsv(textOf(csvResult));
  assert.deepEqual(rows[1], ['张三', '30']);
  assert.deepEqual(rows[2], ['李四', '25']);
});

test('xls（BIFF8）也能读：中文不丢', async () => {
  const xlsx = await import('xlsx');
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['姓名'], ['张三']]), '旧表');
  const bytes = new Uint8Array(xlsx.write(workbook, { type: 'array', bookType: 'biff8' }));
  const api = createApi(bytes, { name: '旧表.xls', ext: 'xls', options: { target: 'csv' } });
  const result = await table.convert(api.input, api);
  assert.equal(result.files[0].name, '旧表.csv');
  assert.ok(textOf(result).includes('张三'));
});

test('fixtures 目录下的坏文件也走同一条错误路径', async () => {
  const brokenPath = join(FIXTURES, 'broken.xlsx');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(brokenPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x09, 0x09]));
  const bytes = new Uint8Array(readFileSync(brokenPath));
  const api = createApi(bytes, { name: 'broken.xlsx', ext: 'xlsx', options: { target: 'csv' } });
  await expectConversionError(() => table.convert(api.input, api), 'TABLE_READ_FAILED');
});
