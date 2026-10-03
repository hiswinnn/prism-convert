/**
 * 开发/预览服务器：零依赖静态服务 + 目录镜像。
 *
 * 两个要点：
 * 1) /vendor/lib/* 直接镜像 node_modules，因此库内部的相对 import 不需要打包器也能工作；
 * 2) 支持 Range 请求——ffmpeg-core.wasm 有 30MB，手机弱网下断点续传是刚需。
 *
 * 用法：node server/dev-server.mjs [--port 4780] [--host 0.0.0.0] [--dir src]
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token.startsWith('--')) args.set(token.slice(2), process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i]);
}

const ROOT = resolve(args.get('dir') ?? 'src');
const NODE_MODULES = resolve('node_modules');
const PORT = Number(args.get('port') ?? process.env.PORT ?? 4780);
const HOST = String(args.get('host') ?? '0.0.0.0');
// 离线分发包（dist 里已把 vendor 物化进 dist/vendor/lib）不需要再映射到 node_modules，
// 否则 resolvePath 会把已存在的本地文件又指到不存在的 node_modules 上，反而 404。
const VENDOR_MAP = args.has('no-vendor-map') ? false : true;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
};

function resolvePath(urlPath) {
  // 全部按 POSIX 处理：Windows 上 normalize() 会把 '/' 变成 '\'，
  // 于是 'vendor/lib/...' 的前缀判断永远不成立（这个坑让所有 /vendor 请求 404）。
  const decoded = decodeURIComponent(urlPath.split('?')[0]).replace(/\\/g, '/');
  const segments = decoded.split('/').filter((segment) => segment && segment !== '.');
  if (segments.includes('..')) return null;
  const clean = segments.join('/');

  if (clean.startsWith('vendor/lib/') && VENDOR_MAP) {
    const target = resolve(NODE_MODULES, clean.slice('vendor/lib/'.length));
    return target.startsWith(NODE_MODULES) ? target : null;
  }
  const target = resolve(ROOT, clean === '' ? 'index.html' : clean);
  return target === ROOT || target.startsWith(ROOT + sep) ? target : null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-cache', ...headers });
  res.end(body);
}

async function serveFile(req, res, filePath) {
  const stat = statSync(filePath);
  if (stat.isDirectory()) return serveFile(req, res, join(filePath, 'index.html'));
  const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range;
  // wasm / 二进制大文件走流式 + Range；小文件直接读，省一次系统调用
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [startRaw, endRaw] = range.replace('bytes=', '').split('-');
    const start = startRaw === '' ? Math.max(0, stat.size - Number(endRaw)) : Number(startRaw);
    const end = startRaw === '' || endRaw === '' ? stat.size - 1 : Math.min(Number(endRaw), stat.size - 1);
    if (start >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': mime,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': filePath.startsWith(NODE_MODULES) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    return createReadStream(filePath, { start, end }).pipe(res);
  }
  const headers = {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': filePath.startsWith(NODE_MODULES) ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  res.writeHead(200, headers);
  return createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  const urlPath = req.url?.split('?')[0] ?? '/';
  if (urlPath === '/favicon.ico') return send(res, 204, '');
  const filePath = resolvePath(urlPath);
  if (!filePath) return send(res, 403, 'forbidden');
  if (!existsSync(filePath)) {
    // 单页应用：未知路径回落到 index.html，方便直接分享深链接
    if (!extname(urlPath)) {
      const fallback = join(ROOT, 'index.html');
      if (existsSync(fallback)) return send(res, 200, await readFile(fallback), { 'Content-Type': MIME['.html'] });
    }
    return send(res, 404, `404 ${urlPath}`);
  }
  try {
    await serveFile(req, res, filePath);
  } catch (err) {
    send(res, 500, `500 ${err?.message ?? err}`);
  }
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log(`Prism 开发服务器已启动（root=${ROOT}）`);
  console.log(`  本机：http://127.0.0.1:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  局域网（手机同一 WiFi 直接打开）：http://${ip}:${PORT}`);
});
