/**
 * 从 DSH 会话记录里抢救被误删的文件。
 *
 * 背景：某个子会话用通配删除清空了 tests/ 根目录下的 *.test.mjs，无 git、回收站也为空。
 * 但子会话每次 write/edit 的工具调用参数（含整份文件内容）都记录在
 * %DSH_HOME%/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd 里，
 * 因此「取最后一次 write 作为基线，再按顺序套用其后的 edit」就能原样重放出来。
 *
 * 记录结构（踩坑记录）：
 * - 文件是「一帧一个事件」追加的多帧 zstd，Node 自带的解压只认第一帧，得用 session-log.mjs 切帧；
 * - 工具调用在 `{type:'tool/call', data:{name, arguments}}`，且 arguments 是 **JSON 字符串**，不是对象。
 *
 * 用法：node tools/recover-from-sessions.mjs [--dry] [--all]
 *   默认只还原「当前缺失或 0 字节」的文件，绝不覆盖已有内容。
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { readSessionLog } from './session-log.mjs';

const DSH_HOME = process.env.DSH_HOME ?? 'C:\\Users\\Sunjia\\.dsh';
const SESSIONS = join(DSH_HOME, 'sessions', '--C-Users-Sunjia-Desktop--');
const PROJECT = resolve('E:\\Projects\\PrismConvert');
const DRY = process.argv.includes('--dry');

if (!existsSync(SESSIONS)) {
  console.error(`找不到会话目录：${SESSIONS}`);
  process.exit(2);
}

/** path → [{content}|{old,next,replaceAll}]，按记录顺序 */
const history = new Map();

function record(path, op) {
  const key = resolve(path);
  if (!history.has(key)) history.set(key, []);
  history.get(key).push(op);
}

for (const entry of readdirSync(SESSIONS, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const log = join(SESSIONS, entry.name, 'session.v4.jsonl.zstd');
  if (!existsSync(log)) continue;

  let text = '';
  try {
    text = readSessionLog(log);
  } catch (err) {
    console.warn(`⚠ ${entry.name} 解压失败：${err.message}`);
    continue;
  }

  let ops = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('"tool/call"')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const { name, arguments: rawArgs } = event.data ?? {};
    if (name !== 'write' && name !== 'edit') continue;
    let args;
    try {
      args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
    } catch {
      continue;
    }
    const path = args?.file_path ?? args?.path;
    if (typeof path !== 'string' || path === '-') continue;
    if (name === 'write' && typeof args.content === 'string') {
      record(path, { content: args.content });
      ops += 1;
    } else if (name === 'edit' && typeof args.old_string === 'string') {
      record(path, { old: args.old_string, next: args.new_string ?? '', replaceAll: args.replace_all === true });
      ops += 1;
    }
  }
  if (ops) console.log(`${entry.name}: 记录到 ${ops} 次写入操作`);
}

/** 重放某个文件的历史 */
function replay(ops) {
  let content = null;
  let pendingEdits = 0;
  let missed = 0;
  for (const op of ops) {
    if (op.content !== undefined) {
      content = op.content;
      pendingEdits = 0;
      continue;
    }
    if (content === null) continue;
    if (!content.includes(op.old)) {
      missed += 1;
      continue;
    }
    content = op.replaceAll ? content.split(op.old).join(op.next) : content.replace(op.old, op.next);
    pendingEdits += 1;
  }
  return { content, pendingEdits, missed };
}

// 路径可能是绝对的（E:\Projects\...\tests\x.test.mjs），也可能是相对的（tests\x.test.mjs），两种都要认
// 注意：history 是 Map，要用 [...keys()] 取值——Object.keys(Map) 永远是空数组
const isTestFile = (p) => /(^|[\\/])tests[\\/][^\\/]+\.mjs$/.test(p);
const defaultTargets = [...history.keys()].filter(isTestFile);
console.log(`\n记录里共有 ${defaultTargets.length} 个 tests/ 下的 mjs 文件历史\n`);

let restored = 0;
let present = 0;
let unrecoverable = 0;

for (const path of defaultTargets) {
  const name = basename(path);
  const target = join(PROJECT, 'tests', name);
  const alreadyThere = existsSync(target) && statSync(target).size > 0;
  const { content, missed } = replay(history.get(path));

  if (content === null) {
    console.log(`  ✖ ${name}：只有 edit、没有完整 write，无法重放`);
    unrecoverable += 1;
    continue;
  }

  // 语法自检：node --check 不接受 stdin，必须落成临时文件再检查
  const probe = join(PROJECT, '.recovery', `${name}.probe.mjs`);
  mkdirSync(join(PROJECT, '.recovery'), { recursive: true });
  writeFileSync(probe, content, 'utf8');
  const syntax = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' });
  const ok = syntax.status === 0;
  const bytes = Buffer.byteLength(content, 'utf8');

  if (alreadyThere) {
    console.log(`  ○ ${name}: 已存在，跳过（记录里 ${(bytes / 1024).toFixed(1)} KB，语法${ok ? '通过' : '不通过'}）`);
    present += 1;
    continue;
  }

  console.log(`  ${ok ? '✔' : '⚠'} ${name}: ${(bytes / 1024).toFixed(1)} KB，语法${ok ? '通过' : '不通过'}${missed ? `，${missed} 处 edit 未套用` : ''}${DRY ? '（dry-run）' : ' → 已还原'}`);
  if (!DRY) {
    writeFileSync(target, content, 'utf8');
    restored += 1;
  }
}

console.log(`\n还原 ${restored} 个，已存在 ${present} 个，无法还原 ${unrecoverable} 个。`);
