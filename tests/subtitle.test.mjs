import test from 'node:test';
import assert from 'node:assert/strict';

import { convert, parseTimecode } from '../src/core/subtitle.js';
import { createApi, decodeBytes, encodeText } from './helpers/module-api-stub.mjs';

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:04,000',
  '第一句中文',
  '',
  '2',
  '00:00:05,500 --> 00:00:08,250',
  '第二句 <i>带标签</i>',
  '',
].join('\r\n');

const ASS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 1280',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize',
  'Style: Default,Arial,48',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,第一句\\N第二行',
  'Dialogue: 0,0:00:05.50,0:00:08.25,SubStyle,,0,0,0,,含,逗号的句子',
  '',
].join('\r\n');

function subtitleApi(text, options = {}, { name = 'a.srt', ext = 'srt' } = {}) {
  return createApi({ text, name, ext, options });
}

async function run(text, options, config) {
  const api = subtitleApi(text, options, config);
  const result = await convert(api.input, api);
  return { result, text: decodeBytes(result.files[0].bytes, 'utf-8'), api };
}

const timingLines = (text) => text.split(/\r?\n/).filter((line) => line.includes('-->')).map((line) => line.trim());

test('srt → vtt：时间用点号、带 WEBVTT 头、中文与时间都不丢', async () => {
  const { result, text } = await run(SRT, { format: 'vtt' });

  assert.equal(result.files[0].name, 'a.vtt');
  assert.ok(text.startsWith('WEBVTT\n'));
  assert.deepEqual(timingLines(text), [
    '00:00:01.000 --> 00:00:04.000',
    '00:00:05.500 --> 00:00:08.250',
  ]);
  assert.match(text, /第一句中文/);
  assert.match(text, /第二句 <i>带标签<\/i>/);
});

test('srt → vtt → srt 往返：时间轴完全一致', async () => {
  const vtt = (await run(SRT, { format: 'vtt' })).text;
  const back = (await run(vtt, { format: 'srt' }, { name: 'a.vtt', ext: 'vtt' })).text;

  assert.deepEqual(timingLines(back), timingLines(SRT));
  assert.match(back, /第一句中文/);
});

test('ass → srt：\\N 变成换行、逗号留在正文里、时间换算正确', async () => {
  const { text } = await run(ASS, { format: 'srt' }, { name: 'a.ass', ext: 'ass' });

  assert.deepEqual(timingLines(text), [
    '00:00:01,000 --> 00:00:04,000',
    '00:00:05,500 --> 00:00:08,250',
  ]);
  assert.match(text, /第一句\n第二行/);
  assert.match(text, /含,逗号的句子/);
});

test('srt → ass：生成合法的 Script Info / V4+ Styles / Events 段', async () => {
  const { text } = await run(SRT, { format: 'ass' });

  assert.match(text, /^\[Script Info\]/);
  assert.match(text, /\[V4\+ Styles\]/);
  assert.match(text, /^Style: Default,/m);
  assert.match(text, /\[Events\]/);
  assert.match(text, /Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text/);
  assert.match(text, /Dialogue: 0,0:00:01\.00,0:00:04\.00,Default,,0,0,0,,第一句中文/);
});

test('ass → ass：用到的样式名都有对应定义，覆写标签不被转义', async () => {
  const withTag = ASS.replace('第一句\\N第二行', '{\\an8}第一句\\N第二行');
  const { text } = await run(withTag, { format: 'ass' }, { name: 'a.ass', ext: 'ass' });

  assert.match(text, /^Style: Default,/m);
  assert.match(text, /^Style: SubStyle,/m);
  assert.match(text, /\{\\an8\}第一句\\N第二行/);
  assert.ok(!text.includes('\\{\\an8\\}'), '覆写标签不能被当成普通花括号转义');
});

test('srt 正文里的花括号：转成 ASS 时按字面量转义', async () => {
  const literal = '1\r\n00:00:01,000 --> 00:00:02,000\r\n{这是正文不是标签}\r\n';
  const { text } = await run(literal, { format: 'ass' });

  assert.match(text, /\\\{这是正文不是标签\\\}/);
});

test('shift 平移：负值越界时截到 0 并给出提示', async () => {
  const { result, text } = await run(SRT, { format: 'srt', shift: '-2' });

  assert.deepEqual(timingLines(text), [
    '00:00:00,000 --> 00:00:02,000',
    '00:00:03,500 --> 00:00:06,250',
  ]);
  const note = result.notes.find((item) => item.message.includes('截到 0'));
  assert.ok(note, '应提示有字幕被截到 0');
  assert.equal(note.level, 'info');
});

test('shift 平移：正值整体后移', async () => {
  const { text } = await run(SRT, { format: 'srt', shift: '1.25' });

  assert.deepEqual(timingLines(text), [
    '00:00:02,250 --> 00:00:05,250',
    '00:00:06,750 --> 00:00:09,500',
  ]);
});

test('shift 非数字：抛 SUBTITLE_BAD_SHIFT', async () => {
  const api = subtitleApi(SRT, { format: 'srt', shift: '一秒' });
  await assert.rejects(() => convert(api.input, api), (err) => {
    assert.equal(err.code, 'SUBTITLE_BAD_SHIFT');
    return true;
  });
});

test('坏时间：抛 SUBTITLE_BAD_TIME 而不是静默变成 0', async () => {
  const broken = '1\r\n00:00:1x,000 --> 00:00:04,000\r\n中文\r\n';
  const api = subtitleApi(broken, { format: 'srt' });

  await assert.rejects(() => convert(api.input, api), (err) => {
    assert.equal(err.code, 'SUBTITLE_BAD_TIME');
    assert.match(err.message, /解析不了/);
    return true;
  });
});

test('宽容时间解析：几种常见写法都能读', () => {
  assert.equal(parseTimecode('00:00:01,000'), 1000);
  assert.equal(parseTimecode('00:00:01.000'), 1000);
  assert.equal(parseTimecode('0:01:02.34'), 62340);
  assert.equal(parseTimecode('0:00:01.00'), 1000);
  assert.equal(parseTimecode('1:02:03'), 3723000);
  assert.equal(parseTimecode('01:02'), 62000);
  assert.equal(parseTimecode('12.5'), 12500);
  assert.throws(() => parseTimecode('abc'), /解析不了/);
  assert.throws(() => parseTimecode(''), /解析不了/);
});

test('GBK 输出：字节不是 UTF-8，用 GBK 能解回中文', async () => {
  const { result } = await run(SRT, { format: 'srt', encoding: 'gbk' });
  const bytes = result.files[0].bytes;

  assert.notEqual(decodeBytes(bytes, 'utf-8'), new TextDecoder('gbk').decode(bytes));
  assert.match(new TextDecoder('gbk').decode(bytes), /第一句中文/);
  assert.ok(!bytes.every((byte, i) => byte === encodeText(SRT, 'utf-8')[i]), 'GBK 字节不应等于 UTF-8 字节');
});

test('stripTags：去掉 <i> 与 ASS 覆写标签', async () => {
  const { text } = await run(SRT, { format: 'srt', stripTags: true });
  assert.match(text, /第二句 带标签/);
  assert.ok(!text.includes('<i>'));

  const ass = (await run(ASS, { format: 'srt', stripTags: true }, { name: 'a.ass', ext: 'ass' })).text;
  const withTags = (await run(ASS, { format: 'ass' }, { name: 'a.ass', ext: 'ass' })).text;
  assert.ok(!ass.includes('{\\an8}'));
  assert.match(withTags, /第一句\\N第二行/);
});

test('merge：同时间轴的重复行并成一条', async () => {
  const dup = [
    '1', '00:00:01,000 --> 00:00:02,000', '甲', '',
    '2', '00:00:01,000 --> 00:00:02,000', '乙', '',
  ].join('\r\n');
  const { result, text } = await run(dup, { format: 'srt', merge: true });

  assert.equal(timingLines(text).length, 1);
  assert.match(text, /甲\n乙/);
  assert.ok(result.notes.some((note) => note.message.includes('合并')));
});

test('txt 输出：只有文本行，没有时间轴', async () => {
  const { result, text } = await run(SRT, { format: 'txt' });

  assert.equal(result.files[0].name, 'a.txt');
  assert.ok(!text.includes('-->'));
  assert.match(text, /第一句中文/);
  assert.match(text, /第二句 <i>带标签<\/i>/);
});

test('csv 输出：表头 + 每行一条，含逗号的文本被正确加引号', async () => {
  const { text } = await run(ASS, { format: 'csv' }, { name: 'a.ass', ext: 'ass' });
  const lines = text.trim().split('\r\n');

  assert.equal(lines[0], '序号,开始,结束,文本');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^1,00:00:01\.000,00:00:04\.000,"第一句/);
  assert.match(lines[2], /"含,逗号的句子"/);
});

test('vtt 输入：自带 NOTE、cue 设置与 MM:SS 短时间也能读', async () => {
  const vtt = [
    'WEBVTT',
    '',
    'NOTE 这是一条注释',
    '',
    '00:00:01.000 --> 00:00:04.000 align:start position:10%',
    '你好，世界',
    '',
    '00:05.000 --> 00:08.000',
    '短时间写法',
    '',
  ].join('\n');
  const { text } = await run(vtt, { format: 'srt' }, { name: 'a.vtt', ext: 'vtt' });

  assert.deepEqual(timingLines(text), [
    '00:00:01,000 --> 00:00:04,000',
    '00:00:05,000 --> 00:00:08,000',
  ]);
  assert.match(text, /你好，世界/);
  assert.match(text, /短时间写法/);
});

test('空文件与无时间轴的文件：抛明确错误', async () => {
  const empty = subtitleApi('   ', { format: 'srt' });
  await assert.rejects(() => convert(empty.input, empty), (err) => {
    assert.equal(err.code, 'SUBTITLE_EMPTY');
    return true;
  });

  const noTiming = subtitleApi('这里没有时间轴', { format: 'srt' });
  await assert.rejects(() => convert(noTiming.input, noTiming), (err) => {
    assert.equal(err.code, 'SUBTITLE_BAD_FORMAT');
    return true;
  });
});

test('不支持的目标格式：抛 SUBTITLE_UNSUPPORTED_TARGET', async () => {
  const api = subtitleApi(SRT, { format: 'docx' });
  await assert.rejects(() => convert(api.input, api), (err) => {
    assert.equal(err.code, 'SUBTITLE_UNSUPPORTED_TARGET');
    return true;
  });
});
