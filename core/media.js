/**
 * 音视频模块：基于 @ffmpeg/ffmpeg（WASM）做格式转换、抽音频、抽帧、裁剪、压缩。
 *
 * 关键约束：
 * - core 的 URL 由引擎通过 api.asset() 提供（浏览器指 /vendor/ffmpeg/...）；Node 里没有 wasm 运行时，
 *   直接抛 ENGINE_UNAVAILABLE，而不是让用户等一个必然失败的加载。
 * - ffmpeg.load() 很贵（要下几十 MB 的 wasm），所以实例做模块级单例；exec 用队列串行，
 *   同一个实例并发 exec 会互相踩文件系统。
 * - buildArgs() 是纯函数并单独导出：它是本模块唯一能在 Node 里测的部分，参数构造的错误必须在这里暴露。
 *
 * @typedef {import('./types.js').Api} Api
 */
import { ConversionError } from './errors.js';
import { loadFfmpegCore } from './lib-loader.js';
import { extOf, mimeOfExt } from './util.js';

const AUDIO_TARGETS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus']);
const VIDEO_TARGETS = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi']);
const IMAGE_TARGETS = new Set(['png', 'jpg']);
const ACTIONS = ['convert', 'extractAudio', 'extractFrame', 'trim', 'compress'];

/** 日志只留最后这些行：用户判断「是不是格式不支持」看这几行就够了，全量会把错误卡片撑爆 */
const LOG_TAIL_LINES = 30;

// ffmpeg 的编码器名与容器名不同名，这里显式列出，避免把 m4a 当成编解码器名传进去
const AUDIO_CODEC = {
  mp3: 'libmp3lame', m4a: 'aac', aac: 'aac', ogg: 'libvorbis', opus: 'libopus', flac: 'flac', wav: 'pcm_s16le',
};
const LOSSESS_AUDIO = new Set(['flac', 'wav']);

export const meta = {
  id: 'media',
  category: 'media',
  label: '音视频',
  from: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'mp4', 'webm', 'mkv', 'mov', 'avi', 'gif'],
  to: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'mp4', 'webm', 'gif', 'png', 'jpg', 'mp3cut'],
  priority: 85,
  options: [
    { key: 'mediaAction', type: 'select', label: '操作', default: 'convert', choices: [
      { value: 'convert', label: '转换格式' },
      { value: 'extractAudio', label: '提取音频（视频→音频）' },
      { value: 'extractFrame', label: '截取一帧图片' },
      { value: 'trim', label: '裁剪片段' },
      { value: 'compress', label: '压缩体积' },
    ] },
    { key: 'audioBitrate', type: 'select', label: '音频码率', default: '192k', choices: [
      { value: '320k', label: '320k' }, { value: '192k', label: '192k' },
      { value: '128k', label: '128k' }, { value: '64k', label: '64k' },
    ] },
    { key: 'videoCrf', type: 'range', label: '视频质量 CRF（越大越小越糊）', default: 28, min: 18, max: 40, step: 1 },
    { key: 'trimStart', type: 'text', label: '裁剪起点（秒 / 00:01:23）', default: '' },
    { key: 'trimEnd', type: 'text', label: '裁剪终点', default: '' },
    { key: 'frameAt', type: 'text', label: '截帧时间点（秒）', default: '1' },
    { key: 'scale', type: 'select', label: '分辨率', default: 'source', choices: [
      { value: 'source', label: '保持原样' }, { value: '1080', label: '最长边 1080' },
      { value: '720', label: '最长边 720' }, { value: '480', label: '最长边 480' },
    ] },
    { key: 'gifFps', type: 'range', label: 'GIF 帧率', default: 12, min: 5, max: 30, step: 1 },
  ],
};

/** @param {import('./types.js').Input} input @param {Api} api */
export async function convert(input, api) {
  const requestedAction = String(api.opt('mediaAction', 'convert'));
  if (!ACTIONS.includes(requestedAction)) {
    throw new ConversionError('MEDIA_BAD_ACTION', `不认识的音视频操作「${requestedAction}」`);
  }

  const inputExt = String(input.ext ?? '').toLowerCase();
  let action = requestedAction;
  let target = resolveTarget(api, defaultTarget(action, inputExt));
  if (target === 'mp3cut') { // meta.to 里的「裁成 mp3」预设：等价于裁剪 + mp3 输出
    action = 'trim';
    target = 'mp3';
  }

  const inputName = `input.${inputExt || 'bin'}`;
  const outputName = `output.${target}`;
  // 参数先在 Node 也能跑的地方构造出来：坏参数要在下载 wasm 之前就报给用户。
  // 注意：buildArgs 只产出「怎么转」，输出文件名必须由 buildCommand 补上——漏掉它 ffmpeg 会报
  // "At least one output file must be specified"，而且是在下载完 30MB wasm 之后才报。
  const args = buildCommand(action, resolveOptions(api), { name: inputName, ext: inputExt }, outputName);

  if (api.env === 'node') throw engineUnavailable();

  api.progress(0.05, '准备 ffmpeg');
  const ffmpeg = await acquireFFmpeg(api);

  return withLock(async () => {
    const logs = [];
    const onLog = ({ message }) => {
      logs.push(message);
      if (logs.length > LOG_TAIL_LINES) logs.shift();
    };
    const onProgress = ({ progress }) => {
      const ratio = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
      api.progress(0.1 + ratio * 0.8, 'ffmpeg 处理中');
    };
    ffmpeg.on('log', onLog);
    ffmpeg.on('progress', onProgress);

    try {
      await ffmpeg.writeFile(inputName, api.bytes());
      await ffmpeg.exec(args);

      const data = await ffmpeg.readFile(outputName);
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      if (!bytes || !bytes.length) {
        throw new ConversionError('MEDIA_EMPTY_OUTPUT', 'ffmpeg 没有产出数据，通常是这个文件里没有对应的轨道（比如无声视频提取音频）', {
          detail: logs.join('\n'),
        });
      }

      api.progress(1, '完成');
      return {
        files: [{ name: api.fileName(outputFileName(input, target)), bytes, mime: mimeOfExt(target) }],
        notes: [
          { level: 'info', message: '已在本地用 WebAssembly 版 ffmpeg 完成，文件没有上传到服务器' },
        ],
      };
    } catch (err) {
      if (err instanceof ConversionError) throw err;
      throw new ConversionError('MEDIA_FFMPEG_FAILED', 'ffmpeg 处理失败，可能是这个格式或编码不被支持', {
        cause: err,
        detail: logs.join('\n'),
      });
    } finally {
      ffmpeg.off('log', onLog);
      ffmpeg.off('progress', onProgress);
      // 临时文件留在虚拟 FS 里会一直占内存，尽力清掉（清不掉也不影响结果）
      for (const name of [inputName, outputName]) {
        try {
          await ffmpeg.deleteFile(name);
        } catch {
          // 文件本来就不存在时 deleteFile 会抛，这里无需处理
        }
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 * 参数构造（纯函数，Node 可测）
 * ------------------------------------------------------------------ */

/**
 * @param {string} action convert | extractAudio | extractFrame | trim | compress
 * @param {object} options 界面选项（缺项按 meta 默认值补齐）
 * @param {string|{name?:string, ext?:string}} input 输入文件在 ffmpeg 虚拟 FS 里的名字
 * @param {string} output 输出文件名（扩展名决定编码参数）
 * @returns {string[]} ffmpeg 参数（不含开头的 ffmpeg 自身）
 */
/**
 * 完整 ffmpeg 命令 = 转换参数 + 输出文件名。
 * 单独抽出来是为了让「输出文件名必须是最后一个参数」这条规则能被测试钉死——
 * 之前 buildArgs 忘了带输出，只有在浏览器里真跑 ffmpeg 时才炸，Node 单测完全看不出来。
 */
export function buildCommand(action, options, input, output) {
  return [...buildArgs(action, options, input, output), output];
}

export function buildArgs(action, options, input, output) {  if (!ACTIONS.includes(action)) {
    throw new ConversionError('MEDIA_BAD_ACTION', `不认识的音视频操作「${action}」`);
  }
  const opts = normalizeOptions(options);
  const inputFile = inputFileName(input);
  const inputExt = inputExtOf(input);
  const outExt = extOf(output);
  if (!outExt) {
    throw new ConversionError('MEDIA_BAD_OUTPUT', `输出文件名「${output}」缺少扩展名，无法判断要转成什么格式`);
  }

  switch (action) {
    case 'convert': return convertArgs(inputFile, outExt, opts);
    case 'extractAudio': return extractAudioArgs(inputFile, outExt, opts);
    case 'extractFrame': return extractFrameArgs(inputFile, outExt, opts);
    case 'trim': return trimArgs(inputFile, inputExt, outExt, opts);
    case 'compress': return compressArgs(inputFile, inputExt, outExt, opts);
    default: throw new ConversionError('MEDIA_BAD_ACTION', `不认识的音视频操作「${action}」`);
  }
}

function convertArgs(inputFile, outExt, opts) {
  // 视频转图片 = 抽一帧，用户不必先去选「截取一帧图片」再回来
  if (IMAGE_TARGETS.has(outExt)) return extractFrameArgs(inputFile, outExt, opts);
  if (outExt === 'gif') return gifArgs(inputFile, opts);
  if (AUDIO_TARGETS.has(outExt)) return ['-y', '-i', inputFile, '-vn', ...audioCodecArgs(outExt, opts)];
  if (VIDEO_TARGETS.has(outExt)) return ['-y', '-i', inputFile, ...videoCodecArgs(outExt, opts, scaleFilter(opts.scale))];
  throw unsupportedTarget(outExt);
}

function extractAudioArgs(inputFile, outExt, opts) {
  if (!AUDIO_TARGETS.has(outExt)) {
    throw unsupportedTarget(outExt, '提取音频只能输出 mp3 / wav / ogg / flac / m4a / aac / opus');
  }
  return ['-y', '-i', inputFile, '-vn', ...audioCodecArgs(outExt, opts)];
}

function extractFrameArgs(inputFile, outExt, opts) {
  if (!IMAGE_TARGETS.has(outExt)) throw unsupportedTarget(outExt, '截帧只能输出 png / jpg');
  const at = readSeconds(opts.frameAt, 'frameAt') ?? 0;
  const filter = scaleFilter(opts.scale);
  return [
    '-y',
    '-ss', formatSeconds(at), // 放在 -i 前是快速定位，抽一帧不需要精确解码到那一帧
    '-i', inputFile,
    '-frames:v', '1',
    ...(filter ? ['-vf', filter] : []),
    ...(outExt === 'jpg' ? ['-q:v', '2'] : []),
  ];
}

function trimArgs(inputFile, inputExt, outExt, opts) {
  const start = readSeconds(opts.trimStart, 'trimStart');
  const end = readSeconds(opts.trimEnd, 'trimEnd');
  if (start === null && end === null) {
    throw new ConversionError('MEDIA_BAD_TRIM', '裁剪需要「起点」或「终点」至少填一个');
  }
  if (start !== null && end !== null && end <= start) {
    throw new ConversionError('MEDIA_BAD_TRIM', `裁剪终点（${formatSeconds(end)}s）必须大于起点（${formatSeconds(start)}s）`);
  }
  const args = ['-y'];
  if (start !== null) args.push('-ss', formatSeconds(start));
  args.push('-i', inputFile);
  // -ss 放在 -i 前会重置时间轴，所以时长要用 -t（而不是 -to）表达
  if (end !== null) args.push('-t', formatSeconds(end - (start ?? 0)));

  if (outExt === 'gif') return [...args, ...gifFilterArgs(opts)];
  if (IMAGE_TARGETS.has(outExt)) return [...args, '-frames:v', '1'];
  if (AUDIO_TARGETS.has(outExt)) return [...args, '-vn', ...audioCodecArgs(outExt, opts)];
  if (VIDEO_TARGETS.has(outExt)) {
    // 裁剪不做额外压缩：保持源规格，只换容器/编码
    return [...args, ...videoCodecArgs(outExt, opts, scaleFilter(opts.scale))];
  }
  throw unsupportedTarget(outExt);
}

function compressArgs(inputFile, inputExt, outExt, opts) {
  if (AUDIO_TARGETS.has(outExt)) {
    // 压缩音频就是把码率压下来；用户选了 320k 那就不叫「压」了，所以封顶 128k
    const capped = Math.min(bitrateKbps(opts.audioBitrate), 128);
    return ['-y', '-i', inputFile, '-vn', ...audioCodecArgs(outExt, { ...opts, audioBitrate: `${capped}k` })];
  }
  if (outExt === 'gif') return gifArgs(inputFile, opts);
  if (VIDEO_TARGETS.has(outExt)) {
    if (AUDIO_TARGETS.has(inputExt)) {
      throw unsupportedTarget(outExt, '纯音频文件压不成视频');
    }
    return ['-y', '-i', inputFile, ...videoCodecArgs(outExt, opts, scaleFilter(opts.scale))];
  }
  throw unsupportedTarget(outExt);
}

function gifArgs(inputFile, opts) {
  return ['-y', '-i', inputFile, ...gifFilterArgs(opts)];
}

/**
 * GIF 两遍调色板法：先把所有帧降采样成一张全局调色板，再用它做 dither。
 * 一次 exec 用 filter_complex 表达，省掉中间文件（浏览器里也没有真正的地方放）。
 */
function gifFilterArgs(opts) {
  const fps = readNumber(opts.gifFps, 'gifFps');
  if (!Number.isFinite(fps) || fps < 1 || fps > 60) {
    throw new ConversionError('MEDIA_BAD_PARAM', `GIF 帧率「${opts.gifFps}」应该在 1~60 之间`);
  }
  const width = opts.scale && opts.scale !== 'source' ? readNumber(opts.scale, 'scale') : null;
  if (width !== null && (!Number.isFinite(width) || width <= 0)) {
    throw new ConversionError('MEDIA_BAD_PARAM', `分辨率「${opts.scale}」不认识`);
  }
  const chain = [`fps=${fps}`, `scale=${width ?? 'iw'}:-1:flags=lanczos`].join(',');
  return ['-filter_complex', `${chain},split[a][b];[a]palettegen[p];[b][p]paletteuse`, '-an'];
}

function videoCodecArgs(outExt, opts, filter) {
  const crf = readNumber(opts.videoCrf, 'videoCrf');
  if (!Number.isFinite(crf) || crf < 1 || crf > 51) {
    throw new ConversionError('MEDIA_BAD_PARAM', `CRF「${opts.videoCrf}」应该在 1~51 之间`);
  }
  const args = filter ? ['-vf', filter] : [];
  if (outExt === 'webm') {
    // VP9 的恒定质量要配 -b:v 0，否则 -crf 会被码率目标覆盖
    return [...args, '-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-c:a', 'libopus', '-b:a', opts.audioBitrate];
  }
  return [...args, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', opts.audioBitrate];
}

function audioCodecArgs(outExt, opts) {
  const codec = AUDIO_CODEC[outExt];
  if (!codec) throw unsupportedTarget(outExt, '音频输出支持 mp3 / wav / ogg / flac / m4a / aac / opus');
  if (LOSSESS_AUDIO.has(outExt)) return ['-c:a', codec]; // 无损格式没有码率可设
  return ['-c:a', codec, '-b:a', String(opts.audioBitrate)];
}

function scaleFilter(scale) {
  const value = String(scale ?? 'source');
  if (!value || value === 'source') return null;
  const limit = readNumber(value, 'scale');
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new ConversionError('MEDIA_BAD_PARAM', `分辨率「${scale}」不认识`);
  }
  // 「最长边」要同时管住横屏与竖屏：横屏压宽、竖屏压高，另一边交给 -2 保持比例并对齐偶数
  return `scale='if(gt(iw,ih),min(${limit},iw),-2)':'if(gt(iw,ih),-2,min(${limit},ih))'`;
}

function unsupportedTarget(ext, hint) {
  return new ConversionError('MEDIA_UNSUPPORTED_TARGET', `暂不支持输出成 ${ext}${hint ? `（${hint}）` : ''}`);
}

/* ------------------------------------------------------------------ *
 * 参数规整
 * ------------------------------------------------------------------ */

function normalizeOptions(options) {
  const source = options && typeof options === 'object' ? options : {};
  const bitrate = String(source.audioBitrate ?? '192k').trim();
  if (!/^\d{2,3}k$/.test(bitrate)) {
    throw new ConversionError('MEDIA_BAD_PARAM', `音频码率「${bitrate}」不像合法值（如 192k）`);
  }
  return {
    audioBitrate: bitrate,
    videoCrf: source.videoCrf ?? 28,
    trimStart: String(source.trimStart ?? '').trim(),
    trimEnd: String(source.trimEnd ?? '').trim(),
    frameAt: String(source.frameAt ?? '1').trim(),
    scale: String(source.scale ?? 'source').trim(),
    gifFps: source.gifFps ?? 12,
  };
}

function bitrateKbps(bitrate) {
  return Number.parseInt(String(bitrate).replace(/k$/, ''), 10);
}

function readNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new ConversionError('MEDIA_BAD_PARAM', `「${label}」的值「${value}」不是数字`);
  }
  return number;
}

/** 秒 / 00:01:23 / 1:02:03.5 都能解析；空串返回 null；负数不接受 */
function readSeconds(value, label) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const simple = /^\d+(?:\.\d+)?$/.exec(raw);
  if (simple) return Number(raw);

  const clock = /^(?:(\d{1,4}):)?(?:(\d{1,3}):)?(\d{1,3}(?:\.\d+)?)$/.exec(raw);
  if (clock) {
    const [, first, second, third] = clock;
    const parts = second === undefined ? [first, third] : [first, second, third];
    const numbers = parts.map(Number);
    const [hours, minutes, seconds] = numbers.length === 3 ? numbers : [0, numbers[0], numbers[1]];
    return hours * 3600 + minutes * 60 + seconds;
  }
  throw new ConversionError('MEDIA_BAD_TIME', `「${label}」的值「${raw}」解析不了，请填秒数（如 12.5）或 00:01:23`);
}

function formatSeconds(seconds) {
  return String(Number(seconds.toFixed(3)));
}

function inputFileName(input) {
  if (typeof input === 'string' && input.trim()) return input.trim();
  if (input && typeof input === 'object' && input.name) return String(input.name);
  if (input && typeof input === 'object' && input.ext) return `input.${String(input.ext).replace(/^\./, '')}`;
  throw new ConversionError('MEDIA_BAD_INPUT', '缺少输入文件信息');
}

function inputExtOf(input) {
  if (typeof input === 'string') return extOf(input);
  if (input && typeof input === 'object') return String(input.ext ?? extOf(input.name ?? '')).toLowerCase().replace(/^\./, '');
  return '';
}

function outputFileName(input, target) {
  const base = String(input.name ?? 'output').split(/[\\/]/).pop() ?? 'output';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem || 'output'}.${target}`;
}

function defaultTarget(action, inputExt) {
  if (action === 'extractFrame') return 'png';
  if (action === 'extractAudio') return 'mp3';
  if (meta.to.includes(inputExt)) return inputExt; // 裁剪/压缩这类操作默认保持原格式
  return VIDEO_TARGETS.has(inputExt) || inputExt === 'gif' ? 'mp4' : 'mp3';
}

/** 目标扩展名：引擎会把目标格式同时挂在这几个键上（engine.js 的 TARGET_KEYS），逐个兜底 */
function resolveTarget(api, fallback) {
  const candidates = [
    api.opt('format', ''), api.opt('to', ''), api.opt('output', ''), api.opt('outExt', ''),
    typeof api.target === 'string' ? api.target : '',
  ];
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim().toLowerCase().replace(/^\./, '');
    if (value) return value;
  }
  return fallback;
}

function resolveOptions(api) {
  return {
    audioBitrate: api.opt('audioBitrate', '192k'),
    videoCrf: api.opt('videoCrf', 28),
    trimStart: api.opt('trimStart', ''),
    trimEnd: api.opt('trimEnd', ''),
    frameAt: api.opt('frameAt', '1'),
    scale: api.opt('scale', 'source'),
    gifFps: api.opt('gifFps', 12),
  };
}

/* ------------------------------------------------------------------ *
 * FFmpeg 实例：单例加载 + exec 队列
 * ------------------------------------------------------------------ */

let ffmpegPromise = null;
let queueTail = Promise.resolve();

function engineUnavailable() {
  return new ConversionError('ENGINE_UNAVAILABLE', '音视频转换需要浏览器环境（正在使用 WebAssembly 版 ffmpeg）');
}

async function acquireFFmpeg(api) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await api.lib('@ffmpeg/ffmpeg');
      // 引擎来源由 lib-loader 决定：国内 npm 镜像优先（实测 15MB/s），本站与公共 CDN 兜底。
      // 直接把 asset 里的两个 URL 丢给 ffmpeg.load() 是不够的——本站若在海外托管，
      // 30MB 的 wasm 可能让用户等上十几分钟。
      const core = await loadFfmpegCore({
        onProgress: (ratio, received, total, label) => {
          const mb = (n) => (n / 1024 / 1024).toFixed(1);
          api.progress(0.05 + ratio * 0.15, total ? `${label} ${mb(received)}/${mb(total)} MB` : label);
        },
        onNote: (message) => api.note('info', message),
      });
      const ffmpeg = new FFmpeg();
      try {
        await ffmpeg.load({ coreURL: core.coreURL, wasmURL: core.wasmURL });
      } catch (err) {
        core.revoke?.(); // blob URL 要回收，否则反复重试会把内存吃掉
        throw err;
      }
      return ffmpeg;
    })().catch((err) => {
      ffmpegPromise = null; // 加载失败不能把坏实例一直缓存着，否则用户重试也永远失败
      throw err;
    });
  }
  return ffmpegPromise;
}

/** 同一个实例不能并发 exec：后到的任务排队，而不是互相覆盖虚拟 FS 里的文件 */
function withLock(task) {
  const run = queueTail.then(task, task);
  queueTail = run.then(() => undefined, () => undefined);
  return run;
}
