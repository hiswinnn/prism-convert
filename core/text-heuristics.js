/**
 * 文本类文件的特征识别：JSON / JSONL / CSV / TSV / HTML / XML / SVG / 字幕 / Markdown / 纯文本。
 * 与 detect.js 分开，是因为这里只回答「这堆字节像哪种文本格式」，不关心二进制魔数。
 */
import { decodeBytes, looksGarbled } from './encoding.js';
import { parseCsv } from './util.js';

const NAMED = (ext, mime, label, family = 'text', extra = {}) => ({ ext, mime, label, family, ...extra });

function lookahead(text, limit = 64 * 1024) {
  return text.slice(0, limit);
}

/**
 * @param {Uint8Array} bytes
 * @param {string} [name]
 * @returns {{ext:string,mime:string,family:string,label:string,confidence:number,detail?:object}|null}
 */
export function looksLikeText(bytes, name = '') {
  if (bytes.length === 0) return null;

  // JSON 直接尝试解析：比任何特征匹配都可靠
  const firstByte = bytes.find((b) => b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0xef && b !== 0xbb && b !== 0xbf);
  if (firstByte === 0x7b || firstByte === 0x5b) {
    const text = decodeBytes(bytes, 'auto');
    const trimmed = text.trim();
    if (trimmed.length > 1) {
      try {
        const parsed = JSON.parse(trimmed);
        const isJsonl = (trimmed.match(/\n/g) ?? []).length > 0 && !trimmed.endsWith('}') === false && false;
        return NAMED('json', 'application/json', Array.isArray(parsed) ? 'JSON 数组' : 'JSON 对象', 'text', {
          confidence: 0.99,
          detail: { rootType: Array.isArray(parsed) ? 'array' : typeof parsed, size: parsed ? Object.keys(parsed).length : 0, isJsonl },
        });
      } catch {
        // 可能是 JSONL：逐行解析抽样
        const lines = trimmed.split(/\r?\n/).filter(Boolean).slice(0, 5);
        if (lines.length >= 1 && lines.every((line) => {
          try {
            JSON.parse(line);
            return true;
          } catch {
            return false;
          }
        })) {
          return NAMED('jsonl', 'application/x-ndjson', 'JSON Lines (每行一个 JSON)', 'text', { confidence: 0.95 });
        }
      }
    }
  }

  const text = decodeBytes(bytes, 'auto');
  const sample = lookahead(text);

  if (/^\s*(<\?xml[\s\S]{0,200}?)?<svg[\s>]/i.test(sample)) {
    return NAMED('svg', 'image/svg+xml', 'SVG 矢量图', 'image', { confidence: 0.95 });
  }
  if (/^\s*<!doctype html/i.test(sample) || /^\s*<html[\s>]/i.test(sample)) {
    return NAMED('html', 'text/html', 'HTML 网页', 'text', { confidence: 0.9 });
  }
  if (/^\s*<\?xml/i.test(sample) && !/<svg/i.test(sample)) {
    return NAMED('xml', 'application/xml', 'XML 文档', 'text', { confidence: 0.85 });
  }
  if (/^\s*\{\\(rtf|fonttbl)/.test(sample)) {
    return NAMED('rtf', 'application/rtf', 'RTF 富文本', 'document', { confidence: 0.9 });
  }
  if (/^\s*WEBVTT/.test(sample)) {
    return NAMED('vtt', 'text/vtt', 'WebVTT 字幕', 'subtitle', { confidence: 0.95 });
  }
  if (/^\s*\[Script Info\]/i.test(sample) || /^\s*\[V4\+? Styles\]/im.test(sample)) {
    return NAMED('ass', 'text/x-ssa', 'ASS/SSA 字幕', 'subtitle', { confidence: 0.9 });
  }
  if (/^\s*\d+\s*\r?\n\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(sample)) {
    return NAMED('srt', 'application/x-subrip', 'SRT 字幕', 'subtitle', { confidence: 0.95 });
  }
  if (/^(---\r?\n|#{1,6}\s|\s*[-*+]\s|\s*>\s)/m.test(sample) && /\.(md|markdown|mdx)$/i.test(name)) {
    return NAMED('md', 'text/markdown', 'Markdown 文档', 'text', { confidence: 0.8 });
  }
  if (/^\s*(?:[^\n,]*\t[^\n]*\n){1,}[^\n,]*\t/.test(sample)) {
    const rows = parseCsv(sample, '\t');
    if (rows.length >= 2 && rows[0].length >= 2) {
      return NAMED('tsv', 'text/tab-separated-values', 'TSV 表格', 'table', { confidence: 0.8, detail: { rows: rows.length, cols: rows[0].length } });
    }
  }

  const csvProbe = probeDelimited(sample);
  if (csvProbe) return csvProbe;

  if (hasControlChaos(sample) && looksGarbled(text)) return null;

  // YAML 靠「像 key: value 且无控制字符」判断，置信度天然不高，仅用于兜底
  if (/\.(ya?ml)$/i.test(name)) {
    return NAMED('yaml', 'application/yaml', 'YAML 配置', 'text', { confidence: 0.8 });
  }
  if (/^[\s\S]*\n?[A-Za-z_][\w.-]*:\s+\S/.test(sample) && /\.(ini|conf|cfg|env|properties|toml)$/i.test(name)) {
    return NAMED('ini', 'text/plain', '配置文本', 'text', { confidence: 0.7 });
  }

  const mdLike = /\.(md|markdown|mdx)$/i.test(name);
  if (mdLike) return NAMED('md', 'text/markdown', 'Markdown 文档', 'text', { confidence: 0.7 });

  if (!isProbablyText(sample)) return null;

  return NAMED('txt', 'text/plain', '纯文本', 'text', { confidence: 0.6 });
}

function probeDelimited(sample) {
  const lines = sample.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 12);
  if (lines.length < 2) return null;
  for (const delimiter of [',', ';', '|']) {
    const counts = lines.map((line) => parseCsv(line, delimiter)[0]?.length ?? 1);
    const first = counts[0];
    if (first >= 2 && counts.filter((c) => c === first).length >= Math.ceil(counts.length * 0.8)) {
      const rows = parseCsv(sample, delimiter);
      const label = delimiter === ',' ? 'CSV 表格' : `${delimiter} 分隔表格`;
      return NAMED('csv', 'text/csv', label, 'table', {
        confidence: 0.75,
        detail: { delimiter, rows: rows.length, cols: first },
      });
    }
  }
  return null;
}

function hasControlChaos(sample) {
  const bad = (sample.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g) ?? []).length;
  return bad / Math.max(1, sample.length) > 0.02;
}

function isProbablyText(sample) {
  if (!sample) return false;
  const printable = (sample.match(/[\t\n\r\x20-\x7e\u00a0-\uffff]/g) ?? []).length;
  return printable / sample.length > 0.92;
}
