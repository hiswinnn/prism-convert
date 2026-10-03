/**
 * 字幕模块：srt / vtt / ass / ssa 互转，附整体平移、去标签、合并同轴、GBK 输出。
 *
 * 统一中间结构：{ index, start(ms), end(ms), text, style? }。
 * 时间解析刻意做宽容（老播放器导出的字幕千奇百怪），但解析不出来必须报错，
 * 不能让一条坏时间静默变成 0，否则整条字幕会悄悄消失。
 *
 * @typedef {import('./types.js').Api} Api
 */
import { ConversionError } from './errors.js';
import { mimeOfExt, stringifyCsv } from './util.js';

const PREVIEW_CHARS = 2000;
const DEFAULT_STYLE = 'Default';

export const meta = {
  id: 'subtitle',
  category: 'subtitle',
  label: '字幕',
  from: ['srt', 'vtt', 'ass', 'ssa'],
  to: ['srt', 'vtt', 'ass', 'txt', 'csv'],
  priority: 75,
  options: [
    { key: 'shift', type: 'text', label: '整体平移（秒，可为负，如 -0.5）', default: '0' },
    { key: 'stripTags', type: 'boolean', label: '去掉样式标签', default: false },
    { key: 'merge', type: 'boolean', label: '合并同时间轴的重复行', default: false },
    { key: 'encoding', type: 'encoding', label: '输出编码（srt 给老播放器用 GBK 很常见）', default: 'utf-8' },
  ],
};

/** @param {import('./types.js').Input} input @param {Api} api */
export async function convert(input, api) {
  const source = api.text();
  if (!source.trim()) throw new ConversionError('SUBTITLE_EMPTY', '输入是空字幕文件');

  api.progress(0.15, '识别字幕格式');
  const format = detectFormat(source, input.ext);
  let cues = format === 'ass' ? parseAss(source) : parseSrtLike(source);
  if (!cues.length) {
    throw new ConversionError(
      'SUBTITLE_BAD_FORMAT',
      `按 ${format.toUpperCase()} 解析时没有找到任何字幕行，请确认文件里带时间轴`,
    );
  }

  const notes = [];
  const stripTags = api.opt('stripTags', false) === true;
  if (stripTags) for (const cue of cues) cue.text = stripStyleTags(cue.text);

  api.progress(0.5, '处理时间轴');
  const shiftMs = readShift(api);
  if (shiftMs) {
    const clamped = applyShift(cues, shiftMs);
    if (clamped) {
      notes.push({
        level: 'info',
        message: `平移 ${formatShift(shiftMs)} 后有 ${clamped} 条字幕起点会早于 0，已截到 0（原时间轴与平移量不匹配）`,
      });
    }
  }

  if (api.opt('merge', false) === true) {
    const merged = mergeSameTimeline(cues);
    cues = merged.cues;
    if (merged.count > 0) notes.push({ level: 'info', message: `合并了 ${merged.count} 条同时间轴的字幕` });
  }

  const target = resolveTarget(api, meta.to[0]);
  const rendered = render(cues, target, input.name ?? 'subtitle');
  if (!rendered) {
    throw new ConversionError('SUBTITLE_UNSUPPORTED_TARGET', `暂不支持输出成 ${target}（可选 srt / vtt / ass / txt / csv）`);
  }

  api.progress(0.9, '编码输出');
  const name = `${stripExt(input.name ?? 'subtitle')}.${target}`;
  api.progress(1, '完成');
  return {
    files: [{
      name: api.fileName(name),
      bytes: api.encode(rendered, api.opt('encoding', 'utf-8')),
      mime: mimeOfExt(target),
    }],
    preview: rendered.length > PREVIEW_CHARS ? `${rendered.slice(0, PREVIEW_CHARS)}\n…（已截断）` : rendered,
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * 格式识别
 * ------------------------------------------------------------------ */

function detectFormat(text, ext) {
  const head = text.slice(0, 600).replace(/^\uFEFF/, '');
  if (/^WEBVTT/.test(head.trimStart())) return 'vtt';
  if (/^\s*\[Script Info\]/i.test(head) || /^\s*\[Events\]/im.test(head)) return 'ass';
  const e = String(ext ?? '').toLowerCase();
  if (e === 'vtt') return 'vtt';
  if (e === 'ass' || e === 'ssa') return 'ass';
  return 'srt';
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/**
 * SRT 与 WebVTT 共用一套扫描：两者只有时间分隔符（, / .）和文件头不同，
 * 而且现实里两边经常混用，所以直接按「含 --> 的行就是时间轴」来找。
 */
function parseSrtLike(text) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues = [];
  let index = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const timing = readTimingLine(lines[i]);
    if (!timing) continue;
    index += 1;
    const body = [];
    let cursor = i + 1;
    for (; cursor < lines.length; cursor += 1) {
      if (!lines[cursor].trim()) break;
      if (lines[cursor].includes('-->')) break;
      body.push(lines[cursor]);
    }
    // 单换行分隔（没有空行）的文件里，下一段的序号会被误收进来
    if (cursor < lines.length && lines[cursor].includes('-->')) {
      while (body.length && /^\d+$/.test(body[body.length - 1].trim())) body.pop();
    }
    cues.push({
      index,
      start: timing.start,
      end: timing.end,
      text: decodeVttEntities(body.join('\n').trim()),
    });
    i = cursor - 1;
  }
  return cues;
}

function readTimingLine(line) {
  if (!line || !line.includes('-->')) return null;
  const arrow = line.indexOf('-->');
  const left = line.slice(0, arrow).trim();
  const right = line.slice(arrow + 3).trim().split(/\s+/)[0] ?? '';
  return { start: parseTimecode(left), end: parseTimecode(right) };
}

/**
 * 宽容时间解析：`00:00:01,000` / `00:00:01.000` / `0:01:02.34` / `1:02` / `12.5`。
 * 小数位按「不足三位补零、超过三位截断」换算成毫秒。
 */
export function parseTimecode(value) {
  const raw = String(value ?? '').trim();
  const match = /^(?:(\d{1,4}):)?(?:(\d{1,3}):)?(\d{1,3})(?:[.,](\d{1,4}))?$/.exec(raw);
  if (!match) {
    throw new ConversionError('SUBTITLE_BAD_TIME', `时间「${raw || '(空)'}」解析不了，应该是 00:00:01,000 这类写法`);
  }
  const [, first, second, third, fraction] = match;
  // 一段 = 秒，两段 = 分:秒，三段 = 时:分:秒
  const [hours, minutes, seconds] = second === undefined
    ? [0, first === undefined ? 0 : Number(first), Number(third)]
    : [Number(first), Number(second), Number(third)];
  const ms = fraction ? Number(fraction.padEnd(3, '0').slice(0, 3)) : 0;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
}

function parseAss(text) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues = [];
  let section = '';
  let eventFields = null;
  let index = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const header = /^\[(.+)\]$/.exec(trimmed);
    if (header) {
      section = header[1].toLowerCase();
      eventFields = null;
      continue;
    }
    if (section !== 'events') continue;
    const field = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!field) continue;
    const key = field[1].toLowerCase();
    if (key === 'format') {
      eventFields = field[2].split(',').map((name) => name.trim().toLowerCase());
      continue;
    }
    if (key !== 'dialogue' && key !== 'comment') continue;
    if (key === 'comment') continue; // 注释行不是字幕，不参与转换

    const fields = splitEventFields(field[2], eventFields ? eventFields.length : 10);
    const at = (name) => (eventFields ? fields[eventFields.indexOf(name)] : undefined);
    const start = at('start') ?? fields[1];
    const end = at('end') ?? fields[2];
    const style = at('style') ?? fields[3];
    const body = at('text') ?? fields.slice(9).join(',');
    index += 1;
    cues.push({
      index,
      start: parseTimecode(start),
      end: parseTimecode(end),
      text: decodeAssText(body),
      style: style?.trim() || DEFAULT_STYLE,
    });
  }
  return cues;
}

/** Text 一定是最后一个字段，逗号要留在正文里，所以只按前 n-1 个逗号切 */
function splitEventFields(rest, count) {
  const parts = [];
  let cursor = 0;
  for (let i = 0; i < count - 1; i += 1) {
    const comma = rest.indexOf(',', cursor);
    if (comma < 0) break;
    parts.push(rest.slice(cursor, comma));
    cursor = comma + 1;
  }
  parts.push(rest.slice(cursor));
  return parts;
}

function decodeAssText(text) {
  return text
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, '\u00a0')
    .trim();
}

function decodeVttEntities(text) {
  return text
    .replace(/&lrm;/g, '\u200e')
    .replace(/&rlm;/g, '\u200f')
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ *
 * 选项处理
 * ------------------------------------------------------------------ */

function readShift(api) {
  const raw = String(api.opt('shift', '0') ?? '0').trim();
  if (!raw) return 0;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) {
    throw new ConversionError('SUBTITLE_BAD_SHIFT', `平移量「${raw}」不是数字，请填秒数（如 1.5 或 -0.5）`);
  }
  return Math.round(seconds * 1000);
}

/** 平移后起点不能为负：截到 0，并告诉用户截了几条 */
function applyShift(cues, shiftMs) {
  let clamped = 0;
  for (const cue of cues) {
    const start = cue.start + shiftMs;
    const end = cue.end + shiftMs;
    if (start < 0 || end < 0) clamped += 1;
    cue.start = Math.max(0, start);
    cue.end = Math.max(0, end);
    if (cue.end < cue.start) cue.end = cue.start;
  }
  return clamped;
}

function formatShift(ms) {
  return `${ms > 0 ? '+' : ''}${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
}

function mergeSameTimeline(cues) {
  const merged = [];
  const seen = new Map();
  for (const cue of cues) {
    const key = `${cue.start}|${cue.end}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, cue);
      merged.push(cue);
      continue;
    }
    // 同一时间轴上重复的行并成一条，内容去重后按行拼
    const lines = existing.text.split('\n');
    for (const line of cue.text.split('\n')) {
      if (line.trim() && !lines.includes(line)) lines.push(line);
    }
    existing.text = lines.join('\n');
  }
  merged.forEach((cue, i) => { cue.index = i + 1; });
  return { cues: merged, count: cues.length - merged.length };
}

function stripStyleTags(text) {
  return text
    .replace(/\{[^}]*\}/g, '')     // ASS 覆写标签 {\an8}{\pos(...)}
    .replace(/<\/?[^>]+>/g, '')    // SRT/VTT 里的 <i> <b> <c.colorE5E5E5> 等
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */

function render(cues, target, sourceName) {
  switch (target) {
    case 'srt': return renderSrt(cues);
    case 'vtt': return renderVtt(cues);
    case 'ass': return renderAss(cues, sourceName);
    case 'ssa': return renderAss(cues, sourceName); // 只做输入：输出统一给 V4+（ASS）语法
    case 'txt': return renderTxt(cues);
    case 'csv': return renderCsv(cues);
    default: return null;
  }
}

function renderSrt(cues) {
  // 老播放器对 CRLF 更友好；SRT 的落地场景里「读不出来」比「多一个 \r」严重得多
  return cues.map((cue, i) => [
    String(i + 1),
    `${formatClock(cue.start, ',')} --> ${formatClock(cue.end, ',')}`,
    cue.text,
  ].join('\r\n')).join('\r\n\r\n') + '\r\n';
}

function renderVtt(cues) {
  const body = cues.map((cue) => [
    `${formatClock(cue.start, '.')} --> ${formatClock(cue.end, '.')}`,
    cue.text,
  ].join('\n'));
  return `WEBVTT\n\n${body.join('\n\n')}\n`;
}

const ASS_SCRIPT_INFO = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'WrapStyle: 0',
  'ScaledBorderAndShadow: yes',
  'PlayResX: 1280',
  'PlayResY: 720',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
];

const ASS_EVENTS_HEADER = [
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
];

/** 只要文件里出现过样式名就必须有对应定义，否则播放器只能拿默认样式兜底 */
function assStyleLine(styleName) {
  return `Style: ${styleName},Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1`;
}

function renderAss(cues, sourceName) {
  const styles = [];
  for (const cue of cues) {
    const style = cue.style || DEFAULT_STYLE;
    if (!styles.includes(style)) styles.push(style);
  }
  if (!styles.length) styles.push(DEFAULT_STYLE);

  const header = [
    ...ASS_SCRIPT_INFO,
    ...styles.map(assStyleLine),
    '',
    ...ASS_EVENTS_HEADER,
  ];
  const events = cues.map((cue) => {
    const style = cue.style || DEFAULT_STYLE;
    return `Dialogue: 0,${formatAssClock(cue.start)},${formatAssClock(cue.end)},${style},,0,0,0,,${encodeAssText(cue.text)}`;
  });
  return [...header, ...events, ''].join('\r\n');
}

/**
 * ASS 的时间是「时:分:秒.厘秒」，且花括号是覆写标签的定界符。
 * ASS 转过来的 `{\an8}` 要原样保留（用户没勾「去掉样式标签」），只有零散的花括号才转义。
 */
function encodeAssText(text) {
  return text
    .split(/(\{\\[^}]*\})/)
    .map((part, i) => (i % 2 === 1
      ? part
      : part.replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N')))
    .join('');
}

function renderTxt(cues) {
  const lines = [];
  for (const cue of cues) {
    const text = cue.text.trim();
    if (!text) continue;
    if (lines[lines.length - 1] === text) continue; // 连续重复行没必要占两遍
    lines.push(text);
  }
  return `${lines.join('\n')}\n`;
}

function renderCsv(cues) {
  const rows = [['序号', '开始', '结束', '文本']];
  cues.forEach((cue, i) => {
    rows.push([String(i + 1), formatClock(cue.start, '.'), formatClock(cue.end, '.'), cue.text]);
  });
  return `${stringifyCsv(rows)}\r\n`;
}

function formatClock(ms, separator) {
  const total = Math.max(0, Math.round(ms));
  return `${pad(Math.floor(total / 3600000))}:${pad(Math.floor(total / 60000) % 60)}:${pad(Math.floor(total / 1000) % 60)}${separator}${String(total % 1000).padStart(3, '0')}`;
}

function formatAssClock(ms) {
  const total = Math.max(0, Math.round(ms));
  return `${Math.floor(total / 3600000)}:${pad(Math.floor(total / 60000) % 60)}:${pad(Math.floor(total / 1000) % 60)}.${String(Math.floor((total % 1000) / 10)).padStart(2, '0')}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/* ------------------------------------------------------------------ *
 * 杂项
 * ------------------------------------------------------------------ */

function stripExt(name) {
  const clean = String(name).split(/[\\/]/).pop() ?? 'subtitle';
  const dot = clean.lastIndexOf('.');
  return dot > 0 ? clean.slice(0, dot) : clean;
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
