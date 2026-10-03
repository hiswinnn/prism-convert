import { analyzeFile } from '../src/core/engine.js';
import { encodeText, decodeBytes, detectEncoding, looksGarbled } from '../src/core/encoding.js';
import { detectType } from '../src/core/detect.js';
import { loadLib } from '../src/core/lib-loader.js';

const show = (l, v) => console.log(l, '=>', typeof v === 'string' ? JSON.stringify(v) : v);

const tw = '繁體中文測試：這是一段用來驗證編碼識別的句子，請確認繁體中文是否正確顯示。';
const big5 = encodeText(tw, 'big5');
const det = detectEncoding(big5);
show('big5 ->', det.encoding);
const asGb = decodeBytes(big5, 'gb18030');
show('as gb18030', asGb);
show('as gb18030 equals original?', asGb === tw);
show('looksGarbled(as gb18030)', looksGarbled(asGb));
const a = await analyzeFile({ name: '繁體.txt', bytes: big5 });
show('analyze preview', a.preview);
show('analyze encoding', { enc: a.encoding.encoding, conf: a.encoding.confidence, garbled: a.garbled });
show('candidates', a.encoding.candidates.map((c) => `${c.encoding}=${c.score.toFixed(3)}`));

const ja = 'これは日本語のテスト文章です。文字化けしないか確認します。';
const sjis = encodeText(ja, 'shift_jis');
show('sjis detect', detectEncoding(sjis).encoding);

const ko = '이것은 한국어 테스트 문장입니다. 인코딩을 확인합니다.';
const euckr = encodeText(ko, 'euc-kr');
show('euckr detect', detectEncoding(euckr).encoding);

// docx/xlsx 误判为 zip：直接看 detectType 细节
const docxLib = await loadLib('docx');
const { Document, Packer, Paragraph, TextRun } = docxLib;
const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('中文正文')] })] }] });
const docxBytes = new Uint8Array(await Packer.toBuffer(doc));
show('docx first4', Array.from(docxBytes.slice(0, 4)));
show('detectType(docx)', await detectType(docxBytes, '报告.docx'));
const { unzipSync } = await loadLib('fflate');
show('docx entries', Object.keys(unzipSync(docxBytes)).slice(0, 8));

const XLSX = await loadLib('xlsx');
const ws = XLSX.utils.aoa_to_sheet([['姓名'], ['张三']]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
const xlsxBytes = new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
show('xlsx first4', Array.from(xlsxBytes.slice(0, 4)));
show('detectType(xlsx)', await detectType(xlsxBytes, '人员.xlsx'));
show('xlsx entries', Object.keys(unzipSync(xlsxBytes)).slice(0, 8));

// epub 判定也走 inspectZip，同样被 MAGIC 抢先
show('epub-like first4', Array.from(await (async () => (await import('../src/core/zip.js')).zipBytes([{ name: 'mimetype', bytes: encodeText('application/epub+zip') }]))().slice(0, 4)));
