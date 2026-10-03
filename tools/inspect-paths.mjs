import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readSessionLog } from "../tools/session-log.mjs";
const SESSIONS = "C:/Users/Sunjia/.dsh/sessions/--C-Users-Sunjia-Desktop--";
const paths = new Map();
for (const e of readdirSync(SESSIONS, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  const log = join(SESSIONS, e.name, "session.v4.jsonl.zstd");
  if (!existsSync(log)) continue;
  const t = readSessionLog(log);
  for (const line of t.split("\n")) {
    if (!line.includes('"tool/call"')) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const d = ev.data ?? {};
    if (d.name !== "write" && d.name !== "edit") continue;
    let a; try { a = typeof d.arguments === "string" ? JSON.parse(d.arguments) : d.arguments; } catch { continue; }
    const p = a?.file_path ?? a?.path ?? "(none)";
    paths.set(String(p), (paths.get(String(p)) ?? 0) + 1);
  }
}
const all = [...paths.keys()];
console.log("记录的路径总数 =", all.length);
console.log("含 test 的路径：");
for (const p of all.filter(x => /test/i.test(x))) console.log("   ", JSON.stringify(p), paths.get(p));
console.log("前 12 个路径：");
for (const p of all.slice(0, 12)) console.log("   ", JSON.stringify(p));
