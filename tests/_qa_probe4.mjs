import { analyzeFile, convertFile } from '../src/core/engine.js';
import { encodeText } from '../src/core/encoding.js';
import { loadLib } from '../src/core/lib-loader.js';
import { targetsFor } from '../src/core/registry.js';

const show = (l, v) => console.log(l, '=>', typeof v === 'string' ? JSON.stringify(v) : v);

function makeBmp(width, height, colorAt) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const out = new Uint8Array(14 + 40 + pixelBytes);
  const view = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  view.setUint32(2, out.length, true); view.setUint32(10, 54, true); view.setUint32(14, 40, true);
  view.setInt32(18, width, true); view.setInt32(22, height, true);
  view.setUint16(26, 1, true); view.setUint16(28, 24, true); view.setUint32(34, pixelBytes, true);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colorAt(x, y);
      const offset = 54 + (height - 1 - y) * rowSize + x * 3;
      out[offset] = b; out[offset + 1] = g; out[offset + 2] = r;
    }
  }
  return out;
}

// --- 1. BMP -> PNG 实际产出 ---
const bmp = makeBmp(7, 5, (x, y) => [(x * 36) % 256, (y * 51) % 256, 128]);
try {
  const res = await convertFile({ name: '色块.bmp', bytes: bmp }, { target: 'png' });
  show('bmp->png converter', res.converterId);
  show('files', res.files.map((f) => ({ name: f.name, size: f.size, mime: f.mime, head: Array.from(f.bytes.slice(0, 32)) })));
  show('notes', res.notes);
} catch (err) {
  show('bmp->png error', { code: err.code, message: err.message, cause: err.cause?.message });
}

// --- 2. JSON 聊天记录产出文件数与命名 ---
const chat = [{ title: '中文会话', create_time: 1710000000, mapping: {
  a: { id: 'a', message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['你好'] } }, parent: null, children: ['b'] },
  b: { id: 'b', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['好的'] } }, parent: 'a', children: [] },
} }];
try {
  const res = await convertFile({ name: 'conversations.json', bytes: encodeText(JSON.stringify(chat), 'utf-8') }, { target: 'txt' });
  show('chat files', res.files.map((f) => f.name));
  show('chat text head', res.files[0].text?.slice(0, 120));
} catch (err) { show('chat error', err.code + ' ' + err.message); }

// --- 3. zip list 产出文件数 ---
const { zipBytes } = await import('../src/core/zip.js');
const z = await zipBytes([{ name: '中文文件名.txt', bytes: encodeText('内容', 'utf-8') }]);
try {
  const res = await convertFile({ name: '素材包.zip', bytes: z }, { target: 'txt', options: { action: 'list' } });
  show('zip list files', res.files.map((f) => f.name));
  show('zip list text', res.files[0].text?.slice(0, 220));
} catch (err) { show('zip list error', err.code + ' ' + err.message); }

// --- 4. txt -> txt 的候选顺序（pdf 是否劫持） ---
show('targetsFor(txt)', targetsFor('txt'));
try {
  const res = await convertFile({ name: 'a.txt', bytes: encodeText('中文内容', 'utf-8') }, { target: 'txt', options: { encoding: 'utf-8' } });
  show('txt->txt converter', res.converterId);
} catch (err) { show('txt->txt error', { code: err.code, message: err.message, cause: err.cause?.message }); }
