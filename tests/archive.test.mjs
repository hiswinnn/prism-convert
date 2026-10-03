import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, unzipSync, zipSync } from 'fflate';

import { convert } from '../src/core/archive.js';
import { ConversionError } from '../src/core/errors.js';
import { createApi, decodeBytes, gbkEncode } from './helpers/module-api-stub.mjs';
import { buildGbkNameZip, buildTar, buildZip } from './helpers/archive-fixtures.mjs';

const utf8 = (text) => new TextEncoder().encode(text);

function apiFor(bytes, { name = '包.zip', ext = 'zip', options = {}, target } = {}) {
  return createApi({ bytes, name, ext, options, target });
}

const nameOf = (result) => result.files.map((file) => file.name).sort();

test('zip 解压：保留目录结构，中文文件名与内容都对得上', async () => {
  const zip = zipSync({
    'docs/说明.txt': utf8('棱镜中文内容'),
    'readme.md': utf8('# readme'),
  });
  const api = apiFor(zip, { options: { action: 'extract' } });
  const result = await convert(api.input, api);

  assert.deepEqual(nameOf(result), ['docs/说明.txt', 'readme.md']);
  const doc = result.files.find((file) => file.name === 'docs/说明.txt');
  assert.equal(decodeBytes(doc.bytes, 'utf-8'), '棱镜中文内容');
  assert.equal(doc.mime, 'text/plain');
  assert.equal(api.progressCalls.at(-1).ratio, 1);
});

test('flatten 把目录拉平成「目录_文件名」', async () => {
  const zip = zipSync({ 'docs/说明.txt': utf8('内容'), 'docs/图片/图.png': utf8('png') });
  const api = apiFor(zip, { options: { action: 'extract', flatten: true } });
  const result = await convert(api.input, api);

  assert.deepEqual(nameOf(result), ['docs_图片_图.png', 'docs_说明.txt']);
});

test('tar 解析：自建 512 字节头，中文名字正常', async () => {
  const tar = buildTar([
    { name: '说明/中文.txt', data: utf8('tar 里的中文') },
    { name: 'plain.txt', data: utf8('plain') },
  ]);
  const api = apiFor(tar, { name: '归档.tar', ext: 'tar', options: { action: 'extract' } });
  const result = await convert(api.input, api);

  assert.deepEqual(nameOf(result), ['plain.txt', '说明/中文.txt']);
  const doc = result.files.find((file) => file.name === '说明/中文.txt');
  assert.equal(decodeBytes(doc.bytes, 'utf-8'), 'tar 里的中文');
});

test('tgz：gzip 包住 tar 也能解出一层层结构', async () => {
  const tar = buildTar([{ name: 'reports/汇总.txt', data: utf8('汇总内容') }]);
  const tgz = gzipSync(tar);
  const api = apiFor(tgz, { name: '包.tgz', ext: 'tgz', options: { action: 'extract' } });
  const result = await convert(api.input, api);

  assert.deepEqual(nameOf(result), ['reports/汇总.txt']);
  assert.equal(decodeBytes(result.files[0].bytes, 'utf-8'), '汇总内容');
});

test('gz 单文件：输出名去掉 .gz 后缀，内容完整', async () => {
  const gz = gzipSync(utf8('gzip 里的中文'));
  const api = apiFor(gz, { name: '笔记.txt.gz', ext: 'gz', options: { action: 'extract' } });
  const result = await convert(api.input, api);

  assert.deepEqual(nameOf(result), ['笔记.txt']);
  assert.equal(decodeBytes(result.files[0].bytes, 'utf-8'), 'gzip 里的中文');
});

test('list：清单里出现中文文件名、大小与 CRC 列，并带 preview', async () => {
  const zip = zipSync({ '说明.txt': utf8('内容内容') });
  const api = apiFor(zip, { options: { action: 'list' } });
  const result = await convert(api.input, api);

  assert.equal(result.files.length, 1);
  assert.match(result.files[0].name, /\.清单\.txt$/);
  const listing = decodeBytes(result.files[0].bytes, 'utf-8');
  assert.match(listing, /说明\.txt/);
  assert.match(listing, /CRC32/);
  assert.match(listing, /[0-9A-F]{8}/);
  assert.ok(result.preview.includes('说明.txt'), 'preview 应能直接看到文件名');
});

test('list + GBK 输出编码：字节不是 UTF-8，用 GBK 能解回中文', async () => {
  const zip = zipSync({ '说明.txt': utf8('内容') });
  const api = apiFor(zip, { options: { action: 'list', encoding: 'gbk' } });
  const result = await convert(api.input, api);

  const bytes = result.files[0].bytes;
  assert.notEqual(decodeBytes(bytes, 'utf-8'), new TextDecoder('gbk').decode(bytes), 'GBK 编码时两种解法的结果应当不同');
  assert.match(new TextDecoder('gbk').decode(bytes), /说明\.txt/);
});

test('list + json：给出结构化清单', async () => {
  const zip = zipSync({ '说明.txt': utf8('内容') });
  const api = apiFor(zip, { name: '包.zip', options: { action: 'list' }, target: 'json' });
  const result = await convert(api.input, api);

  assert.match(result.files[0].name, /\.manifest\.json$/);
  const manifest = JSON.parse(decodeBytes(result.files[0].bytes, 'utf-8'));
  assert.equal(manifest.format, 'ZIP');
  assert.equal(manifest.entries[0].name, '说明.txt');
  assert.match(manifest.entries[0].crc32, /^[0-9A-F]{8}$/);
});

test('repackage：重新打包的 zip 能被再次解压，内容一致', async () => {
  const zip = zipSync({ 'docs/说明.txt': utf8('往返内容') });
  const api = apiFor(zip, { name: '原包.zip', options: { action: 'repackage' } });
  const result = await convert(api.input, api);

  assert.deepEqual(nameOf(result), ['原包.zip']);
  assert.equal(result.files[0].mime, 'application/zip');
  const again = unzipSync(result.files[0].bytes);
  assert.equal(decodeBytes(again['docs/说明.txt'], 'utf-8'), '往返内容');
});

test('ZIP 中文名乱码：GBK 名字且未置 bit 11 时按 GBK 修正', async () => {
  const zip = buildGbkNameZip('中文名称.txt', utf8('内容'));
  const api = apiFor(zip, { options: { action: 'extract' } });
  const result = await convert(api.input, api);

  assert.equal(result.files[0].name, '中文名称.txt');
  assert.equal(decodeBytes(result.files[0].bytes, 'utf-8'), '内容');
  assert.ok(result.notes.some((note) => note.message.includes('GBK')), '应提示做了文件名编码修正');
});

test('TAR 里的 GBK 文件名同样能修正', async () => {
  const tar = buildTar([{ nameBytes: gbkEncode('中文归档.txt'), data: utf8('内容') }]);
  const api = apiFor(tar, { name: 'a.tar', ext: 'tar', options: { action: 'extract' } });
  const result = await convert(api.input, api);

  assert.equal(result.files[0].name, '中文归档.txt');
});

test('隐藏文件默认跳过，勾选后包含', async () => {
  const zip = buildZip([
    { name: '.env', data: utf8('SECRET=1') },
    { name: 'keep.txt', data: utf8('可见') },
  ]);

  const apiA = apiFor(zip, { options: { action: 'extract' } });
  const resultA = await convert(apiA.input, apiA);
  assert.deepEqual(nameOf(resultA), ['keep.txt']);

  const apiB = apiFor(zip, { options: { action: 'extract', includeHidden: true } });
  const resultB = await convert(apiB.input, apiB);
  assert.deepEqual(nameOf(resultB), ['.env', 'keep.txt']);
});

test('zip slip：../ 段被丢弃，不会写到压缩包外面', async () => {
  const zip = buildZip([{ name: '../../evil.txt', data: utf8('x') }]);
  const api = apiFor(zip, { options: { action: 'extract' } });
  const result = await convert(api.input, api);

  assert.equal(result.files[0].name, 'evil.txt');
  assert.ok(!result.files.some((file) => file.name.includes('..')));
});

test('解压后总大小超过 300MB：拒绝并给出明确错误', async () => {
  const zip = buildZip([{ name: 'huge.bin', data: utf8('x'), declaredSize: 400 * 1024 * 1024 }]);
  const api = apiFor(zip, { options: { action: 'extract' } });

  await assert.rejects(() => convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.equal(err.code, 'ARCHIVE_TOO_LARGE');
    assert.match(err.message, /300 MB/);
    return true;
  });
});

test('单文件超过 50MB：能解出来，但要给 warn 提示', async () => {
  const big = new Uint8Array(51 * 1024 * 1024);
  const zip = zipSync({ 'big.bin': big });
  const api = apiFor(zip, { options: { action: 'extract' } });
  const result = await convert(api.input, api);

  assert.equal(result.files[0].bytes.length, big.length);
  const warn = result.notes.find((note) => note.level === 'warn');
  assert.ok(warn, '应有超过 50MB 的提示');
  assert.match(warn.message, /50/);
});

test('空压缩包：抛 ARCHIVE_EMPTY', async () => {
  const zip = buildZip([]);
  const api = apiFor(zip, { options: { action: 'extract' } });

  await assert.rejects(() => convert(api.input, api), (err) => {
    assert.equal(err.code, 'ARCHIVE_EMPTY');
    return true;
  });
});

test('坏数据：抛 ConversionError 而不是原始异常', async () => {
  const broken = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const api = apiFor(broken, { options: { action: 'extract' } });

  await assert.rejects(() => convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.equal(err.code, 'ARCHIVE_CORRUPT');
    return true;
  });
});

test('认不出的格式：抛 ARCHIVE_UNKNOWN', async () => {
  const api = apiFor(utf8('这不是压缩包'), { name: 'x.bin', ext: 'bin', options: { action: 'extract' } });
  await assert.rejects(() => convert(api.input, api), (err) => {
    assert.equal(err.code, 'ARCHIVE_UNKNOWN');
    return true;
  });
});

test('非法操作名：抛 ARCHIVE_BAD_ACTION', async () => {
  const zip = zipSync({ 'a.txt': utf8('a') });
  const api = apiFor(zip, { options: { action: 'explode' } });
  await assert.rejects(() => convert(api.input, api), (err) => {
    assert.equal(err.code, 'ARCHIVE_BAD_ACTION');
    return true;
  });
});
