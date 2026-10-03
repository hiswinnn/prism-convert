/**
 * Service Worker：让手机把棱镜「装」到主屏、并在断网时仍可用。
 *
 * 策略（踩过的坑）：外壳**必须网络优先**。
 * 早先版本用 stale-while-revalidate 缓存 HTML/JS，结果部署新版本后，
 * 老用户浏览器里跑的还是旧代码——本地永远复现不出来，只有「改完发布、用户再打开」才暴露。
 * 所以：外壳网络优先（离线回落缓存）；只有几十 MB 的引擎文件才缓存优先。
 */
// 版本号变更会清掉所有旧缓存。改动缓存策略时记得 +1。
const SHELL_CACHE = 'prism-shell-v2';
const VENDOR_CACHE = 'prism-vendor-v2';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './styles/tokens.css',
  './styles/glass.css',
  './styles/app.css',
  './main.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 单个资源失败不能拖垮整个安装
    await Promise.all(SHELL_ASSETS.map((url) => cache.add(url).catch(() => null)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== SHELL_CACHE && key !== VENDOR_CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

/** 引擎文件很大，缓存要设上限，免得把配额吃光 */
const MAX_CACHEABLE = 6 * 1024 * 1024;

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const hit = await cache.match(request);
    if (hit) return hit;
    // 导航请求离线时给外壳，至少界面能打开
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return Response.error();
  }
}

async function cacheFirstVendor(request) {
  const cache = await caches.open(VENDOR_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  const size = Number(response.headers.get('content-length') ?? 0);
  if (response.ok && size > 0 && size <= MAX_CACHEABLE) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/vendor/lib/')) {
    event.respondWith(cacheFirstVendor(request));
    return;
  }
  event.respondWith(networkFirst(request));
});
