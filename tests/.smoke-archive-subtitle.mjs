// 临时端到端冒烟（跑完即删）：验证 archive / subtitle 能在真实引擎里跑通
import { convertFile, analyzeFile } from '../src/core/engine.js';
import { zipSync } from 'fflate';

const utf8 = (t) => new TextEncoder().encode(t);

const srt = { name: '字幕.srt', bytes: utf8('1\r\n00:00:01,000 --> 00:00:04,000\r\n你好，字幕\r\n') };
const r = await convertFile(srt, { target: 'vtt' });
console.log('SRT->VTT', r.converterId, r.target, r.files.map((f) => f.name), r.files[0].text?.includes('你好，字幕'));

const zip = zipSync({ 'docs/说明.txt': utf8('压缩包内容') });
const zf = { name: '包.zip', bytes: zip };
const z = await convertFile(zf, { target: 'txt', options: { action: 'list' } });
console.log('ZIP list', z.converterId, z.target, z.files.map((f) => f.name), z.files[0].text?.includes('说明.txt'));

const z2 = await convertFile(zf, { target: 'zip', options: { action: 'extract' } });
console.log('ZIP extract', z2.files.map((f) => `${f.name}:${f.size}`));

const gz = { name: '坏.gz', bytes: new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]) };
try {
  await convertFile(gz, { target: 'txt' });
} catch (e) {
  console.log('坏 gz ->', e.code, String(e.message).slice(0, 30));
}

console.log('analyse srt ->', (await analyzeFile(srt)).ext);
