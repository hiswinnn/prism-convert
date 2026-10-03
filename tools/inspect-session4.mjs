import { readSessionLog } from "../tools/session-log.mjs";
const f = 'C:/Users/Sunjia/.dsh/sessions/--C-Users-Sunjia-Desktop--/ce4200f3-ce05-4b32-8e34-108378da5e40/session.v4.jsonl.zstd';
const lines = readSessionLog(f).split('\n').filter(Boolean);
const shapes = new Map();
for (const l of lines) {
  try { const o = JSON.parse(l); shapes.set(o.type, (shapes.get(o.type) ?? 0) + 1); } catch { shapes.set('(bad json)', (shapes.get('(bad json)') ?? 0) + 1); }
}
console.log('行类型统计:', [...shapes.entries()]);
const w = lines.filter(l => l.includes('"name":"write"') || l.includes('"tool":"write"') || l.includes('file_path'));
console.log('候选行数 =', w.length);
for (const l of w.slice(0, 3)) {
  try {
    const o = JSON.parse(l);
    console.log('--- type=', o.type, 'keys=', Object.keys(o.data ?? o).slice(0, 12));
    console.log(JSON.stringify(o).slice(0, 900));
  } catch { console.log('BAD', l.slice(0, 200)); }
}
