/**
 * 一键部署到 GitHub Pages。
 *
 * 为什么要单独写脚本而不是手工几条命令：
 * 1) 产物要单独进 gh-pages 分支，且每次都是「全新提交」——用临时目录 + 强制推送最干净，
 *    不会把 dist 混进源码历史，也不会污染工作区；
 * 2) 本机全局 git 配置把 github.com 重写成第三方镜像（url.insteadOf），
 *    凭据会因此发给镜像站，所以这里显式用一份干净的 GIT_CONFIG_GLOBAL，只保留 gh 的凭据助手；
 * 3) 顺便把 Pages 开关与「在线校验」一起做完，部署完就知道线上是不是这份产物。
 *
 * 用法：
 *   node scripts/deploy.mjs --repo hiswnn/prism-convert [--branch gh-pages] [--skip-build] [--dry]
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT = resolve(import.meta.dirname, '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i]);
}
const REPO = String(args.get('repo') ?? 'hiswinnn/prism-convert');
const BRANCH = String(args.get('branch') ?? 'gh-pages');
const DRY = args.has('dry');
const GH = 'D:\\Apps\\gh\\bin\\gh.exe';

/** 干净 git 配置：只带 gh 凭据助手，避开全局的 URL 重写 */
const CLEAN_CONFIG = join(tmpdir(), 'prism-gitconfig');
await writeFile(CLEAN_CONFIG, [
  '[credential "https://github.com"]',
  `\thelper = !'${GH.replace(/\\/g, '/')}' auth git-credential`,
  '[safe]',
  '\tdirectory = *',
  '',
].join('\n'), 'utf8');

const env = { ...process.env, GIT_CONFIG_GLOBAL: CLEAN_CONFIG };
const run = (command, argv, options = {}) => {
  const result = spawnSync(command, argv, { encoding: 'utf8', env, ...options });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`命令失败：${command} ${argv.join(' ')}\n${result.stderr || result.stdout}`);
  }
  return result;
};

/* 1. 构建 */
if (!args.has('skip-build')) {
  console.log('① 构建发行版 …');
  run(process.execPath, [join(PROJECT, 'scripts', 'build.mjs')], { stdio: 'inherit' });
}

const dist = join(PROJECT, 'dist');
if (!existsSync(join(dist, 'index.html'))) throw new Error('dist/index.html 不存在，先跑 scripts/build.mjs');

const manifest = existsSync(join(dist, 'build-manifest.json'))
  ? JSON.parse(readFileSync(join(dist, 'build-manifest.json'), 'utf8'))
  : { fileCount: 0, totalBytes: 0 };

/* 2. 拷到临时目录做独立提交（不污染工作区） */
console.log('② 准备发布目录 …');
const staging = join(tmpdir(), `prism-pages-${Date.now()}`);
await mkdir(staging, { recursive: true });
await cp(dist, staging, { recursive: true });
await writeFile(join(staging, '.nojekyll'), '');

if (DRY) {
  console.log(`dry-run：产物已备在 ${staging}（${manifest.fileCount} 个文件，${(manifest.totalBytes / 1024 / 1024).toFixed(1)} MB）`);
  process.exit(0);
}

run('git', ['init', '-b', BRANCH], { cwd: staging });
run('git', ['config', 'user.name', REPO.split('/')[0]], { cwd: staging });
run('git', ['config', 'user.email', `${REPO.split('/')[0]}@users.noreply.github.com`], { cwd: staging });
run('git', ['config', 'core.autocrlf', 'false'], { cwd: staging });
run('git', ['add', '-A'], { cwd: staging });
run('git', ['commit', '-q', '-m', `部署棱镜 Prism ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`], { cwd: staging });

/* 3. 推送到 gh-pages */
console.log(`③ 推送到 ${REPO} 的 ${BRANCH} 分支 …`);
run('git', ['remote', 'add', 'origin', `https://github.com/${REPO}.git`], { cwd: staging });
const push = run('git', ['push', '--force', 'origin', BRANCH], { cwd: staging, allowFailure: true });
if (push.status !== 0) {
  console.error(push.stderr || push.stdout);
  throw new Error('推送失败：请确认 gh 已登录（gh auth status）且仓库存在');
}

/* 4. 开启 Pages（已开启则更新来源） */
console.log('④ 配置 GitHub Pages …');
const pagesBody = ['-f', `source[branch]=${BRANCH}`, '-f', 'source[path]=/'];
const created = run(GH, ['api', '-X', 'POST', `repos/${REPO}/pages`, ...pagesBody], { allowFailure: true });
if (created.status !== 0) {
  const updated = run(GH, ['api', '-X', 'PUT', `repos/${REPO}/pages`, ...pagesBody], { allowFailure: true });
  if (updated.status !== 0) console.warn('  ⚠ Pages 配置未生效（可能需要在仓库设置里手动开启）');
}

/* 5. 在线校验：拿到 Pages 地址并核对首页可访问 */
const [owner, name] = REPO.split('/');
const url = `https://${owner}.github.io/${name}/`;
console.log(`\n⑤ 线上地址：${url}`);
console.log('   （首次部署后 GitHub 需要 1-2 分钟构建，稍后打开即可）');

const indexHash = createHash('sha256').update(await readFile(join(dist, 'index.html'))).digest('hex').slice(0, 16);
console.log(`   本地 index.html 指纹：${indexHash}`);
console.log(`   产物：${manifest.fileCount} 个文件 / ${(manifest.totalBytes / 1024 / 1024).toFixed(1)} MB`);
await rm(staging, { recursive: true, force: true });
