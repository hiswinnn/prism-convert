/**
 * 结构化数据模块测试：node --test
 * 重点在「往返不丢东西」和「生成的文本人要看得懂」——不是只断言没抛错。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as data from '../src/core/data.js';
import { createApi, expectConversionError, textOf } from './helpers.mjs';

function apiFor(text, { name, ext, options = {} }) {
  return createApi(text, { name, ext, options });
}

async function run(text, ext, target, options = {}) {
  const api = apiFor(text, { name: `input.${ext}`, ext, options: { target, ...options } });
  const result = await data.convert(api.input, api);
  return { api, result, text: textOf(result) };
}

test('meta 声明与实现一致', () => {
  assert.equal(data.meta.id, 'data');
  assert.equal(data.meta.category, 'text');
  const keys = data.meta.options.map((option) => option.key);
  assert.deepEqual(keys, ['txtStyle', 'indent', 'sortKeys', 'rootTag', 'encoding']);
  assert.ok(data.meta.from.includes('csv') && data.meta.to.includes('txt'));
});

test('json → yaml → json：中文原样、没有 \\u 转义、值不变', async () => {
  const source = {
    姓名: '张三', 城市: ['北京', '上海'], 年龄: 30, 在职: true, 备注: null,
    地址: { 省: '北京市', 邮编: '100080' },
  };
  const toYaml = await run(JSON.stringify(source), 'json', 'yaml');
  assert.ok(toYaml.text.includes('张三'), 'yaml 里应出现中文');
  assert.ok(!/\\u[0-9a-fA-F]{4}/.test(toYaml.text), 'yaml 里不应出现 \\uXXXX 转义');
  assert.match(toYaml.text, /姓名: 张三/);

  const back = await run(toYaml.text, 'yaml', 'json');
  assert.deepEqual(JSON.parse(back.text), source);
});

test('json → xml → json：数字/布尔/null/数组/属性/文本类型都能还原', async () => {
  const source = {
    name: '张三', age: 30, score: 95.5, active: true, deleted: false, note: null,
    tags: ['北京', '上海'], single: ['唯一'], empty: [],
    address: { '@lang': 'zh', '#text': '北京市', zip: '100080' },
    friends: [{ name: '李四', age: 28 }, { name: '王五', age: 31 }],
  };
  const toXml = await run(JSON.stringify(source), 'json', 'xml');
  assert.ok(toXml.text.includes('张三') && !/\\u[0-9a-fA-F]{4}/.test(toXml.text));
  assert.match(toXml.text, /<root>/);
  assert.match(toXml.text, /prism-type="number">30</);

  const back = await run(toXml.text, 'xml', 'json');
  const restored = JSON.parse(back.text);
  assert.deepEqual(restored, source);
  assert.equal(typeof restored.age, 'number');
  assert.equal(typeof restored.score, 'number');
  assert.equal(restored.active, true);
  assert.equal(restored.note, null);
});

test('xml 往返覆盖刁钻结构：空数组/空对象/嵌套数组/空字符串/像数字的文本', async () => {
  const tricky = {
    a: '', b: ' ', c: [], d: {}, e: [[]], f: [[1, 2], [3, 4]], g: '007', h: 0, i: '你好',
  };
  const toXml = await run(JSON.stringify(tricky), 'json', 'xml');
  // 一个 XML 文档只能有一个根元素
  assert.equal((toXml.text.match(/<root[ >]/g) ?? []).length, 1);
  const back = await run(toXml.text, 'xml', 'json');
  assert.deepEqual(JSON.parse(back.text), tricky);

  const array = ['一', '二'];
  const arrayXml = await run(JSON.stringify(array), 'json', 'xml');
  assert.equal((arrayXml.text.match(/<root[ >]/g) ?? []).length, 1);
  assert.deepEqual(JSON.parse((await run(arrayXml.text, 'xml', 'json')).text), array);

  // 压缩成一行（indent:0）也要能读回来
  const compact = await run(JSON.stringify(tricky), 'json', 'xml', { indent: '0' });
  assert.equal(compact.text.trim().split('\n').length, 2, '压缩模式除声明外应只有一行');
  assert.deepEqual(JSON.parse((await run(compact.text, 'xml', 'json')).text), tricky);
});

test('xml 只有属性的元素解析成 @属性 对象，而不是空字符串', async () => {
  const { text } = await run('<root lang="zh" version="1"/>', 'xml', 'json');
  assert.deepEqual(JSON.parse(text), { '@lang': 'zh', '@version': '1' });
});

test('xml 根标签可以用 rootTag 覆盖', async () => {
  const { text } = await run(JSON.stringify({ a: 1 }), 'json', 'xml', { rootTag: '数据' });
  assert.match(text, /<数据>/);
  assert.match(text, /<\/数据>/);
  assert.equal(JSON.parse((await run(text, 'xml', 'json')).text).a, 1);
});

test('json → jsonl → json：数组逐行，非数组对象单行', async () => {
  const list = [{ id: 1, 城市: '北京' }, { id: 2, 城市: '上海' }];
  const jsonl = await run(JSON.stringify(list), 'json', 'jsonl');
  const lines = jsonl.text.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('北京'));
  assert.deepEqual(JSON.parse((await run(jsonl.text, 'jsonl', 'json')).text), list);

  const single = await run(JSON.stringify({ id: 1 }), 'json', 'jsonl');
  assert.equal(single.text.trimEnd().split('\n').length, 1);
  assert.ok(single.api.notes.some((note) => /不是数组/.test(note.message)));
});

test('json → txt（tree）：键值对齐、数组带序号、对象数组带序号', async () => {
  const source = {
    姓名: '张三', 城市: '北京', 简介: '作家',
    标签: ['文学', '旅行'],
    联系: { 邮箱: 'zhang@example.com', 电话: '13800138000' },
    作品: [{ 标题: '长夜', 年份: 2020 }, { 标题: '微光', 年份: 2022 }],
  };
  const { text } = await run(JSON.stringify(source), 'json', 'txt', { txtStyle: 'tree' });
  const lines = text.split('\n');
  assert.match(text, /姓名: 张三/);
  assert.match(text, /标签: 文学、旅行/);
  assert.match(text, /^\s+邮箱: zhang@example\.com$/m);
  assert.match(text, /^\s+1\.$/m);
  assert.match(text, /^\s+标题: 长夜$/m);
  // 键名对齐：同一层的冒号落在同一列
  const colonOf = (key) => lines.find((line) => line.includes(`${key}:`)).indexOf(':');
  assert.equal(colonOf('姓名'), colonOf('城市'));
  assert.equal(colonOf('姓名'), colonOf('简介'));
});

test('json → txt（kv）：用 a.b[0].c 路径摊平', async () => {
  const source = { 姓名: '张三', 标签: ['文学', '旅行'], 联系: { 邮箱: 'a@b.c' }, 作品: [{ 标题: '长夜' }] };
  const { text } = await run(JSON.stringify(source), 'json', 'txt', { txtStyle: 'kv' });
  assert.match(text, /^姓名\s+= 张三$/m);
  assert.match(text, /^标签\[0\]\s+= 文学$/m);
  assert.match(text, /^标签\[1\]\s+= 旅行$/m);
  assert.match(text, /^联系\.邮箱\s+= a@b\.c$/m);
  assert.match(text, /^作品\[0\]\.标题\s+= 长夜$/m);
});

test('json → txt（table）：对象数组转等宽表格，列宽按中文算', async () => {
  const source = [{ 姓名: '张三', 城市: '北京' }, { 姓名: '李四四', 城市: '上海' }];
  const { text } = await run(JSON.stringify(source), 'json', 'txt', { txtStyle: 'table' });
  const lines = text.trimEnd().split('\n');
  assert.match(lines[0], /^姓名\s+城市$/);
  assert.match(lines[1], /^-+\s+-+$/);
  // 「李四四」比「姓名」宽，第二列起点必须跟着变——按显示宽度比，不是字符串下标
  const columnOf = (line, marker) => data.displayWidth(line.slice(0, line.indexOf(marker)));
  assert.equal(columnOf(lines[2], '北京'), columnOf(lines[3], '上海'));
  assert.ok(lines[2].includes('张三'));

  const fallback = await run(JSON.stringify({ a: 1 }), 'json', 'txt', { txtStyle: 'table' });
  assert.match(fallback.text, /^a = 1$/m);
  assert.ok(fallback.api.notes.some((note) => /表格样式不适用/.test(note.message)));
});

test('json ↔ ini：两层结构往返，深层压成 a.b 扁平键', async () => {
  const source = {
    名称: '棱镜', 版本: 3, 调试: false, 空值: null,
    服务器: { 主机: '127.0.0.1', 端口: 8080, 标签: ['稳定', '内网'] },
  };
  const toIni = await run(JSON.stringify(source), 'json', 'ini');
  assert.match(toIni.text, /^名称 = 棱镜$/m);
  assert.match(toIni.text, /^\[服务器\]$/m);
  assert.match(toIni.text, /^端口 = 8080$/m);
  assert.match(toIni.text, /^标签\[0\] = 稳定$/m);

  const back = await run(toIni.text, 'ini', 'json');
  assert.deepEqual(JSON.parse(back.text), source);

  // 顶层对象当分区，分区里面更深的结构才压成 a.b 扁平键
  const deep = await run(JSON.stringify({ a: { b: { c: 1 } } }), 'json', 'ini');
  assert.match(deep.text, /^\[a\]$/m);
  assert.match(deep.text, /^b\.c = 1$/m);
  assert.ok(deep.api.notes.some((note) => /两层/.test(note.message)));
  assert.deepEqual(JSON.parse((await run(deep.text, 'ini', 'json')).text), { a: { b: { c: 1 } } });

  await expectConversionError(
    () => run(JSON.stringify([1, 2]), 'json', 'ini'),
    'DATA_UNSUPPORTED',
  );
});

test('csv → json：首行当列名，纯数字还原成数字', async () => {
  const { text, api } = await run('姓名,年龄,邮编\r\n张三,30,100080\r\n', 'csv', 'json');
  assert.deepEqual(JSON.parse(text), [{ 姓名: '张三', 年龄: 30, 邮编: 100080 }]);
  assert.ok(api.notes.some((note) => /列名/.test(note.message)));
});

test('缩进与键名排序选项生效', async () => {
  const source = JSON.stringify({ b: 1, a: { d: 2, c: 3 } });
  assert.match((await run(source, 'json', 'json', { indent: '4' })).text, /^    "a": \{$/m);
  assert.match((await run(source, 'json', 'json', { indent: '0' })).text, /^\{"b":1,"a":\{"d":2,"c":3\}\}$/);
  assert.match((await run(source, 'json', 'json', { indent: 'tab' })).text, /^\t"a": \{$/m);
  const sorted = JSON.parse((await run(source, 'json', 'json', { sortKeys: true })).text);
  assert.deepEqual(Object.keys(sorted), ['a', 'b']);
  assert.deepEqual(Object.keys(sorted.a), ['c', 'd']);
});

test('坏 JSON：抛 ConversionError 且消息里有行列号', async () => {
  const broken = '{\n  "姓名": "张三",\n  "年龄": 30,\n}';
  const error = await expectConversionError(() => run(broken, 'json', 'yaml'), 'DATA_READ_FAILED');
  assert.match(error.message, /第 4 行第 1 列/);
  assert.equal(error.detail, 'line=4 column=1');

  const midLine = '{"a": 1, "b": }';
  const second = await expectConversionError(() => run(midLine, 'json', 'yaml'), 'DATA_READ_FAILED');
  assert.match(second.message, /第 1 行/);
});

test('坏 YAML / 坏 XML：都给出中文行列号', async () => {
  const yamlError = await expectConversionError(() => run('姓名: 张三\n标签: [北京, 上海', 'yaml', 'json'), 'DATA_READ_FAILED');
  assert.match(yamlError.message, /YAML 第 2 行第 \d+ 列/);

  const xmlError = await expectConversionError(
    () => run('<root>\n  <姓名>张三</root>', 'xml', 'json'),
    'DATA_READ_FAILED',
  );
  assert.match(xmlError.message, /XML 第 2 行第 \d+ 列/);
  assert.match(xmlError.message, /不匹配/);
});

test('坏 JSONL / 坏 INI / 空文件：错误码与提示', async () => {
  const jsonlError = await expectConversionError(
    () => run('{"a": 1}\n{"b": }\n', 'jsonl', 'json'),
    'DATA_READ_FAILED',
  );
  assert.match(jsonlError.message, /第 2 行/);

  const iniError = await expectConversionError(() => run('[分区\n键 = 值\n', 'ini', 'json'), 'DATA_READ_FAILED');
  assert.match(iniError.message, /第 1 行/);
  assert.match(iniError.message, /右括号/);

  await expectConversionError(() => run('', 'json', 'yaml'), 'DATA_EMPTY');
  await expectConversionError(() => run('   ', 'xml', 'json'), 'DATA_EMPTY');
});

test('不支持的目标格式报 DATA_UNSUPPORTED', async () => {
  await expectConversionError(() => run('{"a":1}', 'json', 'csv'), 'DATA_UNSUPPORTED');
});

test('yaml 里的中文不转义，且 YAML → txt 的树形可读', async () => {
  const yamlText = '名称: 棱镜\n标签:\n  - 中文\n  - English\n嵌套:\n  键: 值\n';
  const { text } = await run(yamlText, 'yaml', 'txt', { txtStyle: 'tree' });
  assert.match(text, /名称: 棱镜/);
  assert.match(text, /标签: 中文、English/);
  assert.match(text, /键: 值/);
});
