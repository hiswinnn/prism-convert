/**
 * 发布桌面版：生成 electron-updater 需要的 latest.yml，把安装器 + 清单
 * 推到 gh-pages 的 updates/ 目录（更新源），并把安装器复制到桌面。
 *
 * 为什么走 Git Data API 而不是 git push：
 * 本机到 github.com 直连被重置，但 api.github.com 正常；这里用「取现有 tree →
 * 加/改两个文件 → 建 commit → 移动 ref」把安装器并进 gh-pages，不会覆盖其它文件。
 *
 * 用法：node scripts/publish-desktop.mjs [--exe <路径>] [--skip-push] [--dry]
 */
import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';

const PROJECT = resolve(import.meta.dirname, '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i]);
}
const REPO = 'hiswinnn/prism-convert';

// 1) 定位安装器
const version = JSON.parse(await readFile(join(PROJECT, 'desktop', 'package.json'), 'utf8')).version;
const releaseDir = join(PROJECT, 'desktop', 'release');
const exe = resolve(args.get('exe') ?? (await (async () => {
  const { readdir } = await import('node:fs/promises');
  const files = existsSync(releaseDir) ? await readdir(releaseDir) : [];
  const exe = files.find((f) => f.toLowerCase().endsWith('.exe'));
  if (!exe) throw new Error(`在 desktop/release 里没找到安装器 .exe，先跑 electron-builder --win nsis（候选：${files.join(', ') || '无'}）`);
  return join(releaseDir, exe);
})()));

const exeName = basename(exe);
const bytes = await readFile(exe);
const sha512 = createHash('sha512').update(bytes).digest('base64');
const size = bytes.length;

console.log(`安装器：${exeName}（${(size / 1024 / 1024).toFixed(1)} MB，sha512=${sha512.slice(0, 12)}…）`);

// 2) 生成 latest.yml（electron-updater 的 generic feed 格式）
const latestYml = [
  `version: ${version}`,
  'files:',
  `  - url: ${exeName}`,
  `    sha512: ${sha512}`,
  `    size: ${size}`,
  `path: ${exeName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n');

const desktopDir = join(homedir(), 'Desktop');
await copyFile(exe, join(desktopDir, exeName));
console.log(`已复制安装器到桌面：${join(desktopDir, exeName)}`);

if (args.has('dry')) {
  console.log('dry-run：跳过推送。latest.yml 内容：\n' + latestYml);
  process.exit(0);
}
if (args.has('skip-push')) {
  console.log('已跳过推送（--skip-push）。');
  process.exit(0);
}

// 3) 推送到 gh-pages/updates/（Git Data API）
const TOKEN = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }).stdout.trim();
if (!TOKEN) throw new Error('拿不到 gh token，请先 gh auth login');
const API = `https://api.github.com/repos/${REPO}`;
const headers = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'prism-publish', 'X-GitHub-Api-Version': '2022-11-28' };
async function api(path, init = {}) {
  const r = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${r.status} ${body?.message ?? text?.slice(0, 200)}`);
  return body;
}

const ref = await api('/git/ref/heads/gh-pages');
const commit = await api(`/git/commits/${ref.object.sha}`);

async function blobOf(content) {
  // 99MB 的 blob 转 base64 后请求体约 130MB，GitHub 偶发 502——重试几次
  const payload = JSON.stringify({ content: Buffer.from(content).toString('base64'), encoding: 'base64' });
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const r = await api('/git/blobs', { method: 'POST', body: payload });
      return r.sha;
    } catch (err) {
      lastErr = err;
      if (attempt < 4) {
        console.warn(`  blob 上传重试 ${attempt}/4（${err.message}）…`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
  }
  throw lastErr;
}

const [ymlSha, exeSha] = [await blobOf(latestYml), await blobOf(bytes)];
const tree = await api('/git/trees', {
  method: 'POST',
  body: JSON.stringify({
    base_tree: commit.tree.sha,
    tree: [
      { path: 'updates/latest.yml', mode: '100644', type: 'blob', sha: ymlSha },
      { path: `updates/${exeName}`, mode: '100644', type: 'blob', sha: exeSha },
    ],
  }),
});
const newCommit = await api('/git/commits', {
  method: 'POST',
  body: JSON.stringify({ message: `发布桌面版 v${version} 更新（${exeName}）`, tree: tree.sha, parents: [ref.object.sha] }),
});
await api('/git/refs/heads/gh-pages', { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha, force: false }) });

console.log(`✓ 已发布到更新源：https://hiswinnn.github.io/prism-convert/updates/latest.yml`);
console.log(`  桌面安装器：${join(desktopDir, exeName)}`);
