import { readSessionLog } from "../tools/session-log.mjs";
const f = 'C:/Users/Sunjia/.dsh/sessions/--C-Users-Sunjia-Desktop--/ce4200f3-ce05-4b32-8e34-108378da5e40/session.v4.jsonl.zstd';
const t = readSessionLog(f);
console.log('解压后 bytes =', t.length, 'lines =', t.split('\n').filter(Boolean).length);
const lines = t.split('\n').filter(Boolean);
console.log('含 file_path 的行 =', lines.filter(l => l.includes('file_path')).length);
console.log('含 engine.test.mjs 的行 =', lines.filter(l => l.includes('engine.test.mjs')).length);
const hit = lines.find(l => l.includes('engine.test.mjs') && l.length > 500);
if (hit) console.log('HIT 前 600 字:', hit.slice(0, 600));
