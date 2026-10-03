/**
 * Service Worker：让手机把棱镜「装」到主屏并离线可用。
 * 策略：
 * - 外壳（HTML/CSS/JS）用 stale-while-revalidate，保证功能更新能生效又不用等网络；
 * - /vendor/lib/* 是几十 MB 的引擎文件，用 cache-first，且只缓存 6MB 以内的；
 * - 导航请求 network-first，离线时回落到缓存的外壳。
 */
const SHELL_CACHE = 'prism-shell-v1';
const VENDOR_CACHE = 'prism-vendor-v1';
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

const MAX_CACHEABLE = 6 * 1024 * 1024;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./index.html')) ?? Response.error();
      }
    })());
    return;
  }

  if (url.pathname.includes('/vendor/lib/')) {
    event.respondWith((async () => {
      const cache = await caches.open(VENDOR_CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      const size = Number(response.headers.get('content-length') ?? 0);
      if (response.ok && size > 0 && size <= MAX_CACHEABLE) cache.put(request, response.clone());
      return response;
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(request);
    const network = fetch(request)
      .then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
      .catch(() => null);
    return hit ?? (await network) ?? Response.error();
  })());
});
