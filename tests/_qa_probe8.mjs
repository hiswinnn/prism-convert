// QA 探针：目标格式未下发时，模块是否「静默产出错误格式」而不是报错
import { convertFile } from '../src/core/engine.js';
import { encodeText } from '../src/core/encoding.js';
import { extOf } from '../src/core/util.js';

const cases = [
  { label: 'json → yaml（data）', name: 'config.json', text: '{"名称":"棱镜","版本":"1.0"}', target: 'yaml' },
  { label: 'json → xml（data）', name: 'config.json', text: '{"名称":"棱镜"}', target: 'xml' },
  { label: 'csv → json（table）', name: '人员.csv', text: '姓名,城市\n张三,北京\n', target: 'json' },
  { label: 'csv → xlsx（table）', name: '人员.csv', text: '姓名,城市\n张三,北京\n', target: 'xlsx' },
  { label: 'srt → vtt（subtitle）', name: '字幕.srt', text: '1\n00:00:01,000 --> 00:00:03,500\n你好，世界\n', target: 'vtt' },
  { label: 'srt → txt（subtitle）', name: '字幕.srt', text: '1\n00:00:01,000 --> 00:00:03,500\n你好，世界\n', target: 'txt' },
];

for (const item of cases) {
  const file = { name: item.name, bytes: encodeText(item.text, 'utf-8') };
  try {
    const res = await convertFile(file, { target: item.target });
    const out = res.files[0];
    const actualExt = extOf(out.name);
    const flag = actualExt === item.target ? 'OK  ' : '错格式';
    console.log(`${flag} ${item.label} → 请求 .${item.target}，实际产出 ${out.name}（${res.converterId}） 正文: ${JSON.stringify(String(out.text ?? '').slice(0, 60))}`);
  } catch (err) {
    console.log(`报错 ${item.label} → ${err.code} ${String(err.message).slice(0, 90)}`);
  }
}
