/**
 * 通过 GitHub REST API 推送文件（不依赖 git 协议）。
 *
 * 为什么需要它：本机到 github.com:443 的连接会被重置/超时（国内网络常见），
 * 但 api.github.com 正常。git push 走的是 github.com，所以整条链路不可用。
 * Git Data API 完全跑在 api.github.com 上：创建 blob → 建 tree → 建 commit → 移动 ref。
 *
 * 用法：
 *   node scripts/push-via-api.mjs --repo hiswinnn/prism-convert --branch gh-pages --dir dist
 *   node scripts/push-via-api.mjs --repo hiswinnn/prism-convert --branch main --tracked
 *
 * --dir <路径>   上传该目录下的全部文件
 * --tracked      上传 git 已跟踪的文件（用于源码分支，自动遵守 .gitignore）
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i]);
}
const REPO = String(args.get('repo'));
const BRANCH = String(args.get('branch') ?? 'main');
const ROOT = resolve(args.get('dir') ?? '.');
const USE_TRACKED = args.has('tracked');
if (!REPO) {
  console.error('必须给 --repo owner/name');
  process.exit(2);
}

const TOKEN = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', shell: process.platform === 'win32' })
  .stdout.trim();
if (!TOKEN) {
  console.error('拿不到 gh token，请先 gh auth login');
  process.exit(2);
}

const API = `https://api.github.com/repos/${REPO}`;
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'prism-deploy',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${body?.message ?? text?.slice(0, 200)}`);
  }
  return body;
}

/** 收集文件清单（相对路径 + 绝对路径） */
async function listFiles() {
  if (USE_TRACKED) {
    const listed = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
    if (listed.status !== 0) throw new Error('git ls-files 失败，确认当前目录是 git 仓库');
    return listed.stdout.split('\0').filter(Boolean).map((rel) => ({ rel, abs: join(ROOT, rel) }));
  }
  const out = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.push({ rel: relative(ROOT, abs).split(sep).join('/'), abs });
    }
  };
  await walk(ROOT);
  return out;
}

const files = await listFiles();
const totalBytes = (await Promise.all(files.map(async (f) => (await stat(f.abs)).size))).reduce((a, b) => a + b, 0);
console.log(`准备上传 ${files.length} 个文件（${(totalBytes / 1024 / 1024).toFixed(1)} MB）到 ${REPO}#${BRANCH}`);

/* 1. 逐个创建 blob（小文件并发，大文件单独走，避免内存峰值与请求体超限） */
let done = 0;
let bytesUploaded = 0;
const treeEntries = [];
const CONCURRENCY = 6;
const queue = [...files];

async function uploadOne(file) {
  const content = await readFile(file.abs);
  bytesUploaded += content.length;
  const blob = await api('/git/blobs', {
    method: 'POST',
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  });
  treeEntries.push({ path: file.rel, mode: '100644', type: 'blob', sha: blob.sha });
  done += 1;
  if (done % 25 === 0 || content.length > 5 * 1024 * 1024) {
    console.log(`  ${done}/${files.length}  (${(bytesUploaded / 1024 / 1024).toFixed(1)} MB)`);
  }
}

async function worker() {
  for (;;) {
    const file = queue.shift();
    if (!file) return;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await uploadOne(file);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        console.warn(`  重试 ${attempt}/3 ${file.rel}：${err.message}`);
        await new Promise((r) => setTimeout(r, 1200 * attempt));
      }
    }
    if (lastError) throw lastError;
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`blob 完成：${treeEntries.length} 个`);

/* 2. 建 tree */
const tree = await api('/git/trees', {
  method: 'POST',
  body: JSON.stringify({ tree: treeEntries }),
});

/* 3. 取父提交（分支不存在就创建） */
let parent = null;
try {
  const ref = await api(`/git/ref/heads/${BRANCH}`);
  parent = ref.object.sha;
} catch {
  console.log(`分支 ${BRANCH} 不存在，将新建`);
}

const commit = await api('/git/commits', {
  method: 'POST',
  body: JSON.stringify({
    message: `部署棱镜 Prism ${new Date().toISOString().slice(0, 16).replace('T', ' ')}（${treeEntries.length} 个文件）`,
    tree: tree.sha,
    parents: parent ? [parent] : [],
  }),
});

/* 4. 移动/创建 ref */
if (parent) {
  await api(`/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: true }) });
} else {
  await api('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }) });
}

console.log(`✓ 已推送 ${commit.sha.slice(0, 10)} → ${BRANCH}`);
