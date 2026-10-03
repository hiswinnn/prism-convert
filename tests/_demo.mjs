import { convert } from '../src/core/chat-export.js';
import { decodeBytes, encodeText } from '../src/core/encoding.js';
import { sanitizeFileName } from '../src/core/util.js';

const at = (y, mo, d, h, mi) => Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000);
const source = JSON.stringify([
  {
    title: '如何写小说开头',
    create_time: at(2026, 3, 1, 20, 11),
    current_node: 'n3',
    mapping: {
      n3: { id: 'n3', parent: 'n2', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['开头最重要的是把读者按进场景里。\n\n例如：\n\n```js\nconst hook = 1;\n```'] }, create_time: at(2026, 3, 1, 20, 13), metadata: { model_slug: 'deepseek-chat' } } },
      n1: { id: 'n1', parent: null, children: ['n2'], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['最近想写个小说开头，有什么建议？'] }, create_time: at(2026, 3, 1, 20, 11) } },
      n2: { id: 'n2', parent: 'n1', children: ['n3'], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['先说结论：别从天气写起。'] }, create_time: at(2026, 3, 1, 20, 12), metadata: { model_slug: 'deepseek-chat' } } },
    },
  },
  {
    title: '周报怎么写',
    create_time: at(2026, 3, 2, 9, 30),
    current_node: 'a',
    mapping: { a: { id: 'a', parent: null, children: [], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['周报总写成流水账'] }, create_time: at(2026, 3, 2, 9, 30) } } },
  },
]);

function createApi(options) {
  const bytes = encodeText(source, 'utf-8');
  const notes = [];
  return {
    input: { name: 'conversations.json', ext: 'json', mime: 'application/json', size: bytes.length, bytes },
    bytes: () => bytes,
    text: () => decodeBytes(bytes, 'utf-8'),
    opt: (key, fallback) => (key in options ? options[key] : fallback),
    encode: (text, encoding = 'utf-8') => encodeText(text, encoding),
    decode: (data, encoding) => decodeBytes(data, encoding),
    progress: () => {},
    note: (level, message) => notes.push(`${level}: ${message}`),
    fileName: (name) => sanitizeFileName(name),
    env: 'node',
    notes,
  };
}

for (const options of [{ to: 'txt' }, { to: 'txt', layout: 'plain' }, { to: 'md', layout: 'transcript' }]) {
  const api = createApi(options);
  const result = await convert(api.input, api);
  console.log(`===== ${JSON.stringify(options)} → ${result.files[0].name} =====`);
  console.log(decodeBytes(result.files[0].bytes, 'utf-8'));
  console.log('notes:', api.notes.join(' | '));
}
