/**
 * 轻提示：一次最多留 3 条，2.8 秒自动淡出。
 * 不用 alert/confirm——那是发行版产品里最刺眼的东西。
 */
import { h, icon } from './dom.js';

const MAX = 3;

export function toast(message, level = 'info', timeout = 2800) {
  const stack = document.getElementById('toasts');
  if (!stack) return () => {};
  const icons = { info: 'info', ok: 'check', warn: 'alert', err: 'alert' };
  const el = h('div', { class: `glass toast toast--${level === 'info' ? 'ok' : level}` },
    icon(icons[level] ?? 'info'),
    h('span', { style: { flex: '1' } }, message),
  );
  stack.append(el);
  while (stack.children.length > MAX) stack.firstElementChild.remove();
  const timer = setTimeout(() => el.remove(), timeout);
  el.addEventListener('click', () => {
    clearTimeout(timer);
    el.remove();
  });
  return () => {
    clearTimeout(timer);
    el.remove();
  };
}
