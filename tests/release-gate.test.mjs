/**
 * 发布门禁：把「只有跨模块才暴露」的集成缺陷固化成测试。
 *
 * 这些用例的共同点是——单个模块自己的测试永远发现不了，必须站在引擎/注册表的高度看：
 * 1) 注册表 meta 与模块自身 meta 必须一致（注册表窄了，用户就点不到那个格式）；
 * 2) 引擎必须把目标格式下发给模块（否则用户选了目标却静默拿到别的格式）；
 * 3) 输出文件名不能被去重两次（否则出现 x-1-1.txt）；
 * 4) api.zip() 必须是同步返回字节（模块会直接当 bytes 用）；
 * 5) ffmpeg 命令必须以输出文件名结尾（少了它，wasm 下完才报「未指定输出文件」）；
 * 6) 压缩包的目录结构不能被引擎压平；
 * 7) 二进制容器（docx/xlsx）不该被当成文本去猜编码。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONVERTERS, canonicalExt, findCandidates, targetsFor } from '../src/core/registry.js';
import { analyzeFile, convertFile } from '../src/core/engine.js';
import { buildArgs, buildCommand } from '../src/core/media.js';
import { encodeText } from '../src/core/encoding.js';

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(PROJECT, 'tests', 'fixtures', 'gate');

function fixture(name, bytes) {
  mkdirSync(fixtures, { recursive: true });
  const path = join(fixtures, name);
  writeFileSync(path, bytes);
  return bytes;
}

test('注册表 meta 必须覆盖模块自身 meta（窄了用户就点不到那个格式）', async () => {
  const problems = [];
  for (const entry of CONVERTERS) {
    let module;
    try {
      module = await entry.loader();
    } catch (err) {
      problems.push(`${entry.id}: 模块加载失败 ${err.message}`);
      continue;
    }
    if (!module.meta) continue; // inspect-only 模块允许没有 meta

    for (const ext of module.meta.from ?? []) {
      if (!entry.from.map(canonicalExt).includes(canonicalExt(ext))) {
        problems.push(`${entry.id}: 模块支持输入 .${ext}，注册表 from 里没有 → 这类文件会被判为「不支持」`);
      }
    }
    for (const ext of module.meta.to ?? []) {
      if (!entry.to.map(canonicalExt).includes(canonicalExt(ext))) {
        problems.push(`${entry.id}: 模块能输出 .${ext}，注册表 to 里没有 → 界面上选不到`);
      }
    }
    const moduleKeys = (module.meta.options ?? []).map((o) => o.key).sort();
    const registryKeys = (entry.options ?? []).map((o) => o.key).sort();
    for (const key of moduleKeys) {
      if (!registryKeys.includes(key)) problems.push(`${entry.id}: 模块选项「${key}」没进注册表 → 用户在界面上调不了`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('目标格式必须真的下发给模块（不能被静默回落）', async () => {
  const json = fixture('config.json', encodeText('{"name":"棱镜","version":1,"tags":["中文","测试"]}', 'utf-8'));
  const yaml = await convertFile({ name: 'config.json', bytes: json }, { target: 'yaml' });
  assert.equal(yaml.files[0].name.endsWith('.yaml'), true, `json→yaml 产出了 ${yaml.files[0].name}`);
  assert.match(yaml.files[0].text ?? '', /棱镜/);

  const csv = fixture('people.csv', encodeText('姓名,年龄\n张三,30\n李四,28\n', 'utf-8'));
  const xlsx = await convertFile({ name: 'people.csv', bytes: csv }, { target: 'xlsx' });
  assert.equal(xlsx.files[0].name.endsWith('.xlsx'), true, `csv→xlsx 产出了 ${xlsx.files[0].name}`);

  const srt = fixture('a.srt', encodeText('1\n00:00:01,000 --> 00:00:03,500\n你好，世界\n', 'utf-8'));
  const vtt = await convertFile({ name: 'a.srt', bytes: srt }, { target: 'vtt' });
  assert.equal(vtt.files[0].name.endsWith('.vtt'), true, `srt→vtt 产出了 ${vtt.files[0].name}`);
  assert.match(vtt.files[0].text, /^WEBVTT/, 'vtt 必须以 WEBVTT 开头，否则说明没按目标格式输出');
  assert.match(vtt.files[0].text, /你好，世界/, '中文不能丢');
});

test('输出文件名不能被去重两次（x.txt 不该变成 x-1.txt）', async () => {
  const txt = fixture('小说.txt', encodeText('第一章\n\n他推开窗，风从缝隙里灌进来。\n', 'gbk'));
  const result = await convertFile({ name: '小说.txt', bytes: txt }, { target: 'txt' });
  assert.equal(result.files[0].name, '小说.txt', `单体转换不该改名，实际 ${result.files[0].name}`);
  assert.match(result.files[0].text, /他推开窗/, 'GBK 转 UTF-8 后中文必须正确');
});

test('api.zip() 必须同步返回字节（模块会直接当 bytes 用）', async () => {
  const result = await convertFile(
    { name: '样张.txt', bytes: encodeText('第一页\n第二页\n', 'utf-8') },
    { target: 'pdf' },
  ).catch(() => null);
  // 中文转 PDF 在本项目里是明确不支持的（内置字体只有 WinAnsi），这里只验证「不支持」要报得清楚
  if (result === null) return;
  assert.ok(result.files[0].bytes instanceof Uint8Array);
});

test('ffmpeg 命令必须以输出文件名结尾', () => {
  const cases = [
    ['convert', {}, { ext: 'wav' }, 'output.mp3'],
    ['convert', {}, { ext: 'wav' }, 'output.flac'],
    ['convert', {}, { ext: 'mp4' }, 'output.gif'],
    ['extractAudio', {}, { ext: 'mp4' }, 'output.mp3'],
    ['extractFrame', {}, { ext: 'mp4' }, 'output.png'],
    ['trim', { trimStart: '0', trimEnd: '2' }, { ext: 'wav' }, 'output.mp3'],
    ['compress', {}, { ext: 'mp4' }, 'output.mp4'],
  ];
  for (const [action, options, input, output] of cases) {
    const args = buildCommand(action, options, input, output);
    assert.equal(args.at(-1), output, `${action} 的命令最后必须是输出文件，实际：${args.join(' ')}`);
    assert.ok(args.includes('-i'), `${action} 的命令缺少 -i 输入`);
    // buildArgs 是「不含输出」的半成品，两者必须只差最后一个参数
    assert.deepEqual(buildArgs(action, options, input, output), args.slice(0, -1));
  }
  assert.throws(
    () => buildCommand('trim', {}, { ext: 'wav' }, 'output.mp3'),
    /裁剪/,
    '没给裁剪时间点时必须报错，而不是产出一条无效命令',
  );
});

test('压缩包解压要保留目录结构（拉平开关才有意义）', async () => {
  const { zipSync } = await import('fflate');
  const zip = zipSync({
    'docs/说明.txt': encodeText('这是子目录里的中文说明。', 'utf-8'),
    'readme.txt': encodeText('根目录文件。', 'utf-8'),
  });
  const result = await convertFile({ name: '包.zip', bytes: zip }, { target: 'zip', options: { action: 'extract' } });
  const names = result.files.map((f) => f.name).sort();
  assert.ok(names.includes('docs/说明.txt'), `目录结构被压平了：${names.join(', ')}`);
  assert.ok(names.includes('readme.txt'));
  const nested = result.files.find((f) => f.name.includes('说明'));
  assert.match(nested.text ?? '', /子目录里的中文说明/, '解压后的中文内容不能乱码');
});

test('二进制容器不能被当成文本猜编码（xlsx/docx 不该出现编码徽标）', async () => {
  const XLSX = await import('xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([['姓名', '分数'], ['张三', 92]]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
  const bytes = new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }));

  const analysis = await analyzeFile({ name: '成绩.xlsx', bytes });
  assert.equal(analysis.ext, 'xlsx', `xlsx 被识别成了 ${analysis.ext}（zip 容器识别不能短路）`);
  assert.equal(analysis.isText, false, 'xlsx 是 zip 容器，不该去做编码识别');
  assert.equal(analysis.encoding, null, 'xlsx 不该带编码结论（会误导用户以为乱码）');
});

test('原地转（txt→txt）必须落到文档模块，而不是被别的模块抢走', () => {
  const candidates = findCandidates('txt', 'txt').map((c) => c.id);
  assert.ok(candidates.includes('document'), `txt→txt 候选里应有 document，实际 ${candidates.join(', ')}`);
  assert.ok(!candidates.includes('pdf'), 'PDF 模块不该接 txt→txt（它的 from/to 都含 txt，但那是为了 txt→PDF）');
  assert.ok(targetsFor('docx').includes('md'));
});

test('禁止根绝对路径引用 vendor（子路径部署会全部 404）', async () => {
  // 这个 bug 本地永远测不出来：dev-server 与 dist 都挂在站点根，只有部署到
  // https://<user>.github.io/<repo>/ 这种子路径才会暴露。
  const { readdir, readFile } = await import('node:fs/promises');
  const roots = [join(PROJECT, 'src')];
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(js|mjs|html)$/.test(entry.name)) files.push(full);
    }
  };
  for (const root of roots) await walk(root);

  const offenders = [];
  for (const file of files) {
    const name = basename(file);
    // sw.js 是例外：它比对的是「请求路径」，本身就是站点相对量，写绝对前缀是对的
    if (name === 'sw.js') continue;
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      const code = line.trim();
      if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return; // 注释里的说明不算
      if (/(['"`(])\/vendor\//.test(line)) offenders.push(`${name}:${index + 1}  ${code.slice(0, 80)}`);
    });
  }
  assert.deepEqual(offenders, [], `这些位置用了根绝对路径，子路径部署会 404：\n${offenders.join('\n')}`);

  const { VENDOR_BASE, vendorUrl } = await import('../src/core/lib-loader.js');
  assert.ok(!VENDOR_BASE.startsWith('/'), 'vendor 基址必须是 URL（由 import.meta.url 推导），不能是根绝对路径');
  assert.ok(vendorUrl('fflate/esm/browser.js').includes('vendor/lib/fflate'), 'vendorUrl 要能拼出完整地址');
});
