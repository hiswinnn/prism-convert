// 临时探针：验证 .js 源文件在无 package.json 时能否被 ESM 载入
import { analyzeFile, convertFile } from '../src/core/engine.js';
import { encodeText, decodeBytes } from '../src/core/encoding.js';

const gbk = encodeText('你好，世界。这是一段中文测试。', 'gbk');
const a = await analyzeFile({ name: 'zh.txt', bytes: gbk });
console.log('enc=', a.encoding?.encoding, 'conf=', a.encoding?.confidence, 'garbled=', a.garbled);
console.log('preview=', JSON.stringify(a.preview));
console.log('targets=', a.targets.map((t) => t.ext).join(','));
console.log('defaultTarget=', a.defaultTarget);

try {
  const r = await convertFile({ name: 'zh.txt', bytes: gbk }, { target: 'utf-8' });
  console.log('converted', r.converterId, r.files[0].name, decodeBytes(r.files[0].bytes, 'utf-8').slice(0, 40));
} catch (err) {
  console.log('convert error:', err.name, err.code, err.message);
}
