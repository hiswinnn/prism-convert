/**
 * 生成「下载到本地、双击即用」的离线分发包。
 *
 * 为什么不能直接双击 dist/index.html：
 * 应用是 ES 模块 + 动态 import，浏览器从 file:// 打开时会因 CORS 拒绝加载模块，
 * 这是浏览器安全机制，不是程序问题。所以离线包带一个「本机静态文件服务」——
 * 它只读本文件夹、不联网、不对外，关掉就停，等价于纯前端。
 *
 * 产物：<桌面>/棱镜离线版-<version>.zip
 * 内容：启动棱镜.bat + 服务/dev-server.mjs（--no-vendor-map）+ 棱镜/（= dist，vendor 已物化）
 *
 * 用法：node scripts/package-offline.mjs [--skip-build] [--out <目录>]
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT = resolve(import.meta.dirname, '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith('--')) args.set(process.argv[i].slice(2), process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i]);
}
const OUT = resolve(args.get('out') ?? join(homedir(), 'Desktop'));
const VERSION = (await readFile(join(PROJECT, 'VERSION'), 'utf8')).trim();

if (!args.has('skip-build')) {
  console.log('① 构建 dist …');
  spawnSync(process.execPath, [join(PROJECT, 'scripts', 'build.mjs')], { stdio: 'inherit' });
}

const stage = join(PROJECT, '.tmp', `offline-${Date.now()}`);
const packageName = `棱镜离线版-${VERSION}`;
const root = join(stage, packageName);

console.log('② 组装离线包目录 …');
await mkdir(join(root, '服务'), { recursive: true });
await cp(join(PROJECT, 'dist'), join(root, '棱镜'), { recursive: true });
await cp(join(PROJECT, 'server', 'dev-server.mjs'), join(root, '服务', 'dev-server.mjs'));
await cp(join(PROJECT, 'tools', 'offline', '启动棱镜.bat'), join(root, '启动棱镜.bat'));
await cp(join(PROJECT, 'tools', 'offline', 'README-离线使用.txt'), join(root, 'README-离线使用.txt'));

const zipPath = join(OUT, `${packageName}.zip`);
console.log('③ 压缩为 zip …');
const ps1 = [
  '$ErrorActionPreference="Stop"',
  `Compress-Archive -Path "${join(root, '*')}" -DestinationPath "${zipPath}" -CompressionLevel Optimal -Force`,
].join('; ');
const result = spawnSync('powershell', ['-NoProfile', '-Command', ps1], { encoding: 'utf8' });
if (result.status !== 0) throw new Error(`压缩失败：${result.stderr}`);

const { stat } = await import('node:fs/promises');
const size = (await stat(zipPath)).size;
await rm(stage, { recursive: true, force: true });

console.log(`\n✓ 离线包已生成：${zipPath}`);
console.log(`  大小：${(size / 1024 / 1024).toFixed(1)} MB`);
console.log(`  解压后双击「启动棱镜.bat」即可离线使用（含音视频引擎）。`);
