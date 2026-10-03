import { detectEncoding, decodeBytes, encodeText } from '../src/core/encoding.js';

const cases = [
  ['GBK', encodeText('这是一段中文测试文本，用来验证编码识别是否可靠。今天天气很好，我们一起去公园散步吧。', 'gbk')],
  ['Big5', encodeText('這是一段中文測試文本，用來驗證編碼識別是否可靠。今天天氣很好，我們一起去公園散步吧。', 'big5')],
  ['UTF-8', encodeText('这是 UTF-8 的中文文本，包含常用字：的一是不了在人有我他。', 'utf-8')],
  ['UTF-16LE', encodeText('这是 UTF-16LE 的中文文本，用于测试字节序探测。', 'utf-16le')],
  ['Shift_JIS', encodeText('これは日本語のテストです。今日はいい天気ですね。', 'shift_jis')],
  ['纯ASCII', encodeText('plain ascii text, no multibyte at all\nsecond line', 'utf-8')],
];

for (const [name, bytes] of cases) {
  const result = detectEncoding(bytes);
  const decoded = decodeBytes(bytes, result.encoding);
  const samples = result.candidates.slice(0, 5).map((c) => `${c.encoding}:${c.score.toFixed(2)}`).join(' ');
  console.log(`${name.padEnd(10)} -> ${String(result.encoding).padEnd(9)} conf=${result.confidence.toFixed(3)} ${samples}`);
  console.log(`   解码: ${decoded.slice(0, 44)}`);
}
