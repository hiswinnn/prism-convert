/**
 * 玻璃的「活性」：指针高光、点击波纹、触感反馈、明暗与性能模式。
 * 全部集中在这里，是为了让视图代码只管内容、不管材质。
 */

const THEME_KEY = 'prism.theme';
const PERF_KEY = 'prism.perf';

/* ---------------- 指针高光：光跟着手指/鼠标走 ---------------- */

let lightFrame = 0;
let lightTarget = null;
let lightX = 0;
let lightY = 0;

function flushLight() {
  lightFrame = 0;
  if (!lightTarget) return;
  const rect = lightTarget.getBoundingClientRect();
  const x = ((lightX - rect.left) / Math.max(1, rect.width)) * 100;
  const y = ((lightY - rect.top) / Math.max(1, rect.height)) * 100;
  lightTarget.style.setProperty('--mx', `${x.toFixed(2)}%`);
  lightTarget.style.setProperty('--my', `${y.toFixed(2)}%`);
}

function scheduleLight(clientX, clientY) {
  lightX = clientX;
  lightY = clientY;
  if (lightFrame) return;
  lightFrame = requestAnimationFrame(flushLight);
}

/** 事件委托：只在指针真正位于 .glass 上时更新，避免遍历整棵树 */
export function attachPointerLight(root = document) {
  const move = (event) => {
    const point = event.touches?.[0] ?? event;
    if (point.clientX === undefined) return;
    const el = document.elementFromPoint(point.clientX, point.clientY)?.closest('.glass');
    if (el !== lightTarget) {
      lightTarget?.style.removeProperty('--mx');
      lightTarget?.style.removeProperty('--my');
      lightTarget = el;
    }
    if (lightTarget) scheduleLight(point.clientX, point.clientY);
  };
  root.addEventListener('pointermove', move, { passive: true });
  root.addEventListener('touchmove', move, { passive: true });
}

/* ---------------- 点击波纹 ---------------- */

export function attachRipple(root = document) {
  root.addEventListener('pointerdown', (event) => {
    const target = event.target.closest?.('.btn, .iconbtn, .nav__item, .tabbar__item, .chip--pick');
    if (!target || target.disabled) return;
    const rect = target.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2.2;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${event.clientX - rect.left}px`;
    ripple.style.top = `${event.clientY - rect.top}px`;
    if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
    target.append(ripple);
    setTimeout(() => ripple.remove(), 640);
    haptic(6);
  }, { passive: true });
}

/* ---------------- 触感 ---------------- */

export function haptic(ms = 8) {
  if (navigator.vibrate && matchMedia('(pointer: coarse)').matches) {
    try { navigator.vibrate(ms); } catch { /* 部分浏览器禁用，忽略 */ }
  }
}

/* ---------------- 主题 ---------------- */

export function initTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  const prefersLight = matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(stored ?? (prefersLight ? 'light' : 'dark'), false);
  return () => document.documentElement.dataset.theme;
}

export function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#eef1f8' : '#04050b');
  if (persist) localStorage.setItem(THEME_KEY, theme);
  document.dispatchEvent(new CustomEvent('prism:theme', { detail: { theme } }));
}

export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  // 有 View Transitions 的浏览器里，玻璃折射的变化是一次圆形的光扩散
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.startViewTransition(() => applyTheme(next));
  } else {
    applyTheme(next);
  }
  haptic(10);
  return next;
}

export function currentTheme() {
  return document.documentElement.dataset.theme ?? 'dark';
}

/* ---------------- 性能模式 ---------------- */

export function initPerf() {
  const stored = localStorage.getItem(PERF_KEY);
  if (stored) return applyPerf(stored);
  // 低端机自动降级：核心数少或内存小就不铺满毛玻璃
  const weak = (navigator.hardwareConcurrency ?? 8) <= 4 || (navigator.deviceMemory ?? 8) <= 3;
  return applyPerf(weak ? 'lite' : 'full');
}

export function applyPerf(mode) {
  document.documentElement.dataset.perf = mode;
  localStorage.setItem(PERF_KEY, mode);
  document.dispatchEvent(new CustomEvent('prism:perf', { detail: { mode } }));
  return mode;
}

export function togglePerf() {
  const next = document.documentElement.dataset.perf === 'lite' ? 'full' : 'lite';
  applyPerf(next);
  haptic(10);
  return next;
}

/* ---------------- 启动动画重放 ---------------- */

export function replayRise(scope = document) {
  scope.querySelectorAll('.rise').forEach((el, index) => {
    el.style.animation = 'none';
    // 强制重排，让动画从头播（比 requestAnimationFrame 更稳）
    void el.offsetHeight;
    el.style.animation = '';
    el.style.animationDelay = `${Math.min(index * 55, 420)}ms`;
  });
}

/* ---------------- Service Worker（离线可用 + 首屏缓存） ---------------- */

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // 离线能力属于加分项，注册失败不影响主流程
  });
}
