import { createApi } from './helpers.mjs';
import * as data from '../src/core/data.js';

async function tryCase(label, text, ext, target, options = {}) {
  const api = createApi(text, { name: `in.${ext}`, ext, options: { target, ...options } });
  try {
    const r = await data.convert(api.input, api);
    const out = new TextDecoder().decode(r.files[0].bytes);
    console.log(`--- ${label} [${r.files[0].name}] ---`);
    console.log(out.trimEnd().slice(0, 320));
  } catch (e) {
    console.log(`--- ${label} FAILED: ${e.code} ${e.message}`);
  }
}

const tricky = { a: '', b: ' ', c: [], d: {}, e: [[]], f: [[1, 2]], g: '007', h: 0 };
await tryCase('root array json->txt tree', '[1,"中文",true,null]', 'json', 'txt');
await tryCase('root array json->xml', '["a","b"]', 'json', 'xml');
await tryCase('tricky json->xml', JSON.stringify(tricky), 'json', 'xml');
await tryCase('yaml list->json', '- 一\n- 二\n', 'yaml', 'json');
await tryCase('jsonl scalars->txt', '1\n"二"\ntrue\n', 'jsonl', 'txt');
await tryCase('csv semicolon->json', '姓名;城市\n张三;北京\n', 'csv', 'json');
await tryCase('xml comments', '<!-- c --><root><a>1</a></root>', 'xml', 'json');
await tryCase('xml attr+text', '<root lang="zh">你好</root>', 'xml', 'json');
await tryCase('ini quotes', '名称 = "007"\n数字 = 7\n[分区]\n键 = 值\n', 'ini', 'json');
await tryCase('compressed xml', JSON.stringify({ a: [1, 2] }), 'xml', 'xml', { indent: '0' });
await tryCase('compressed yaml', JSON.stringify({ a: [1, 2] }), 'json', 'yaml', { indent: '0' });
await tryCase('xml->txt table', '<root><item><a>1</a><b>2</b></item><item><a>3</a><b>4</b></item></root>', 'xml', 'txt', { txtStyle: 'table' });

const xmlApi = createApi(JSON.stringify(tricky), { name: 'in.json', ext: 'json', options: { target: 'xml' } });
const xmlOut = await data.convert(xmlApi.input, xmlApi);
const backApi = createApi(new TextDecoder().decode(xmlOut.files[0].bytes), { name: 'in.xml', ext: 'xml', options: { target: 'json' } });
const back = await data.convert(backApi.input, backApi);
const restored = JSON.parse(new TextDecoder().decode(back.files[0].bytes));
console.log('tricky 往返完全一致：', JSON.stringify(restored) === JSON.stringify(tricky));
if (JSON.stringify(restored) !== JSON.stringify(tricky)) {
  console.log('  期望：', JSON.stringify(tricky));
  console.log('  实际：', JSON.stringify(restored));
}
