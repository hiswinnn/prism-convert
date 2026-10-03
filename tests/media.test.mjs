import test from 'node:test';
import assert from 'node:assert/strict';

import { buildArgs, convert, meta } from '../src/core/media.js';
import { ConversionError } from '../src/core/errors.js';
import { createApi } from './helpers/module-api-stub.mjs';

const MP4 = { name: 'in.mp4', ext: 'mp4' };
const audio = { name: 'in.mp3', ext: 'mp3' };

function argsOf(action, options, input, output) {
  return buildArgs(action, options, input, output);
}

test('convert 视频转音频：-vn 加对应编码器与码率', () => {
  assert.deepEqual(argsOf('convert', {}, MP4, 'out.mp3'), ['-y', '-i', 'in.mp4', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k']);
  assert.deepEqual(argsOf('convert', { audioBitrate: '320k' }, MP4, 'out.aac'), ['-y', '-i', 'in.mp4', '-vn', '-c:a', 'aac', '-b:a', '320k']);
  // wav / flac 是无损，不该出现码率参数
  assert.deepEqual(argsOf('convert', {}, MP4, 'out.wav'), ['-y', '-i', 'in.mp4', '-vn', '-c:a', 'pcm_s16le']);
  assert.deepEqual(argsOf('convert', {}, MP4, 'out.flac'), ['-y', '-i', 'in.mp4', '-vn', '-c:a', 'flac']);
});

test('convert 转视频：H.264 + CRF，webm 走 VP9（要配 -b:v 0）', () => {
  assert.deepEqual(argsOf('convert', {}, MP4, 'out.mp4'), [
    '-y', '-i', 'in.mp4', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
  ]);
  assert.deepEqual(argsOf('convert', { videoCrf: 33 }, MP4, 'out.webm'), [
    '-y', '-i', 'in.mp4', '-c:v', 'libvpx-vp9', '-crf', '33', '-b:v', '0', '-c:a', 'libopus', '-b:a', '192k',
  ]);
});

test('scale 表达式：最长边限制同时管住横屏与竖屏', () => {
  const args = argsOf('convert', { scale: '720' }, MP4, 'out.mp4');
  const vf = args[args.indexOf('-vf') + 1];
  assert.equal(vf, "scale='if(gt(iw,ih),min(720,iw),-2)':'if(gt(iw,ih),-2,min(720,ih))'");
  // 保持原样时不产生 -vf
  assert.ok(!argsOf('convert', { scale: 'source' }, MP4, 'out.mp4').includes('-vf'));
});

test('GIF：一次 exec 走两遍调色板法（split + palettegen + paletteuse）', () => {
  const args = argsOf('convert', { gifFps: 15, scale: '480' }, MP4, 'out.gif');
  const graph = args[args.indexOf('-filter_complex') + 1];

  assert.deepEqual(args, ['-y', '-i', 'in.mp4', '-filter_complex', graph, '-an']);
  assert.equal(graph, 'fps=15,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse');
  assert.ok(args.includes('-an'), 'GIF 不该带音轨');
});

test('抽帧：-ss 放在 -i 前，-frames:v 1 收尾', () => {
  assert.deepEqual(argsOf('extractFrame', { frameAt: '1' }, MP4, 'out.png'), ['-y', '-ss', '1', '-i', 'in.mp4', '-frames:v', '1']);
  assert.deepEqual(argsOf('extractFrame', { frameAt: '00:00:02.5', scale: '480' }, MP4, 'out.jpg'), [
    '-y', '-ss', '2.5', '-i', 'in.mp4', '-frames:v', '1',
    '-vf', "scale='if(gt(iw,ih),min(480,iw),-2)':'if(gt(iw,ih),-2,min(480,ih))'",
    '-q:v', '2',
  ]);
  // 视频转图片等价于抽帧，用户不必先切操作
  assert.deepEqual(argsOf('convert', { frameAt: '1' }, MP4, 'out.png'), argsOf('extractFrame', { frameAt: '1' }, MP4, 'out.png'));
});

test('提取音频：目标必须是音频格式，wav 不带码率', () => {
  assert.deepEqual(argsOf('extractAudio', {}, MP4, 'out.m4a'), ['-y', '-i', 'in.mp4', '-vn', '-c:a', 'aac', '-b:a', '192k']);
  assert.deepEqual(argsOf('extractAudio', {}, MP4, 'out.opus'), ['-y', '-i', 'in.mp4', '-vn', '-c:a', 'libopus', '-b:a', '192k']);
});

test('裁剪：00:01:23 解析成 83 秒，时长用 -t 表达', () => {
  assert.deepEqual(argsOf('trim', { trimStart: '00:01:23', trimEnd: '00:02:00' }, MP4, 'out.mp4'), [
    '-y', '-ss', '83', '-i', 'in.mp4', '-t', '37',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
  ]);
  // 只填起点时不出现 -t
  assert.deepEqual(argsOf('trim', { trimStart: '5.5' }, MP4, 'out.mp4'), [
    '-y', '-ss', '5.5', '-i', 'in.mp4',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
  ]);
  // 只填终点时按 0 起点裁剪
  const tailOnly = argsOf('trim', { trimEnd: '10' }, MP4, 'out.mp4');
  assert.equal(tailOnly[tailOnly.indexOf('-t') + 1], '10');
  // 裁成音频 / GIF 也走对应分支
  assert.deepEqual(argsOf('trim', { trimStart: '1', trimEnd: '3' }, MP4, 'out.mp3'), [
    '-y', '-ss', '1', '-i', 'in.mp4', '-t', '2', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k',
  ]);
  assert.ok(argsOf('trim', { trimStart: '1' }, MP4, 'out.gif').includes('-filter_complex'));
});

test('压缩：视频降 CRF，音频码率封顶 128k', () => {
  const video = argsOf('compress', { videoCrf: 32, scale: '480' }, MP4, 'out.mp4');
  assert.equal(video[video.indexOf('-crf') + 1], '32');
  assert.ok(video.includes('-vf'));

  assert.deepEqual(argsOf('compress', { audioBitrate: '320k' }, audio, 'out.mp3'), ['-y', '-i', 'in.mp3', '-vn', '-c:a', 'libmp3lame', '-b:a', '128k']);
  assert.deepEqual(argsOf('compress', { audioBitrate: '64k' }, audio, 'out.mp3'), ['-y', '-i', 'in.mp3', '-vn', '-c:a', 'libmp3lame', '-b:a', '64k']);
});

test('buildArgs 是纯函数：不修改入参，重复调用结果一致', () => {
  const options = { trimStart: '00:00:01', trimEnd: '00:00:03', scale: '720' };
  const snapshot = JSON.stringify(options);
  const first = buildArgs('trim', options, MP4, 'out.mp4');
  const second = buildArgs('trim', options, MP4, 'out.mp4');

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(options), snapshot);
  // 输入信息也可以直接给字符串
  assert.deepEqual(buildArgs('convert', {}, 'in.mp4', 'out.mp3'), ['-y', '-i', 'in.mp4', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k']);
});

test('非法参数：全部抛 ConversionError', () => {
  const cases = [
    [() => buildArgs('explode', {}, MP4, 'out.mp4'), 'MEDIA_BAD_ACTION'],
    [() => buildArgs('convert', {}, MP4, 'out.docx'), 'MEDIA_UNSUPPORTED_TARGET'],
    [() => buildArgs('convert', {}, MP4, 'out'), 'MEDIA_BAD_OUTPUT'],
    [() => buildArgs('extractFrame', {}, MP4, 'out.mp4'), 'MEDIA_UNSUPPORTED_TARGET'],
    [() => buildArgs('extractAudio', {}, MP4, 'out.mp4'), 'MEDIA_UNSUPPORTED_TARGET'],
    [() => buildArgs('trim', {}, MP4, 'out.mp4'), 'MEDIA_BAD_TRIM'],
    [() => buildArgs('trim', { trimStart: '10', trimEnd: '10' }, MP4, 'out.mp4'), 'MEDIA_BAD_TRIM'],
    [() => buildArgs('trim', { trimStart: '2', trimEnd: '1' }, MP4, 'out.mp4'), 'MEDIA_BAD_TRIM'],
    [() => buildArgs('trim', { trimStart: '-3' }, MP4, 'out.mp4'), 'MEDIA_BAD_TIME'],
    [() => buildArgs('trim', { trimStart: 'abc' }, MP4, 'out.mp4'), 'MEDIA_BAD_TIME'],
    [() => buildArgs('extractFrame', { frameAt: '第3秒' }, MP4, 'out.png'), 'MEDIA_BAD_TIME'],
    [() => buildArgs('convert', { videoCrf: 99 }, MP4, 'out.mp4'), 'MEDIA_BAD_PARAM'],
    [() => buildArgs('convert', { videoCrf: 'high' }, MP4, 'out.mp4'), 'MEDIA_BAD_PARAM'],
    [() => buildArgs('convert', { gifFps: 0 }, MP4, 'out.gif'), 'MEDIA_BAD_PARAM'],
    [() => buildArgs('convert', { scale: '变大一点' }, MP4, 'out.mp4'), 'MEDIA_BAD_PARAM'],
    [() => buildArgs('convert', { audioBitrate: '192' }, MP4, 'out.mp3'), 'MEDIA_BAD_PARAM'],
    [() => buildArgs('convert', {}, null, 'out.mp3'), 'MEDIA_BAD_INPUT'],
  ];

  for (const [run, code] of cases) {
    assert.throws(run, (err) => {
      assert.ok(err instanceof ConversionError, `${code} 应该是 ConversionError`);
      assert.equal(err.code, code);
      assert.ok(err.message.length > 0, '错误必须带用户可读文案');
      return true;
    });
  }
});

test('Node 环境：没有 ffmpeg core 时抛 ENGINE_UNAVAILABLE', async () => {
  const api = createApi({
    bytes: new Uint8Array([1, 2, 3]),
    name: 'a.mp4',
    ext: 'mp4',
    env: 'node',
    assets: null,
    options: { mediaAction: 'convert', format: 'mp3' },
  });

  await assert.rejects(() => convert(api.input, api), (err) => {
    assert.ok(err instanceof ConversionError);
    assert.equal(err.code, 'ENGINE_UNAVAILABLE');
    assert.equal(err.message, '音视频转换需要浏览器环境（正在使用 WebAssembly 版 ffmpeg）');
    return true;
  });
});

test('mp3cut 预设：映射成裁剪 + mp3 输出，不会撞上「不支持的目标」', async () => {
  const api = createApi({
    bytes: new Uint8Array([1, 2, 3]),
    name: 'a.mp4',
    ext: 'mp4',
    env: 'node',
    options: { mediaAction: 'trim', format: 'mp3cut', trimStart: '00:00:10', trimEnd: '00:00:20' },
  });

  // Node 里必然停在 ENGINE_UNAVAILABLE，说明此前的参数构造已经通过（否则会是 MEDIA_* 错误）
  await assert.rejects(() => convert(api.input, api), (err) => {
    assert.equal(err.code, 'ENGINE_UNAVAILABLE');
    return true;
  });
});

test('meta 声明与实现一致：from/to 覆盖各操作需要的能力', () => {
  assert.equal(meta.id, 'media');
  assert.ok(meta.to.includes('mp3cut'));
  for (const ext of ['mp3', 'wav', 'mp4', 'webm', 'gif', 'png', 'jpg']) {
    assert.ok(meta.to.includes(ext), `to 应该包含 ${ext}`);
  }
});
