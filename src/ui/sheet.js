/**
 * 抽屉：手机上是底部上滑面板，桌面上是右下角浮层玻璃。
 * 键盘 / Esc 可关，焦点回到触发点，避免「点开就找不到回去的路」。
 */
import { h, icon } from './dom.js';

/**
 * @param {{title:string, icon?:string, body:HTMLElement, footer?:HTMLElement, onClose?:Function}} config
 * @returns {() => void} 关闭函数
 */
export function openSheet({ title, icon: iconName = 'info', body, footer, onClose }) {
  const root = document.getElementById('sheet-root');
  const previouslyFocused = document.activeElement;

  const close = () => {
    backdrop.remove();
    sheet.remove();
    document.removeEventListener('keydown', onKey);
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus?.();
    onClose?.();
  };

  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  const backdrop = h('div', { class: 'sheet-backdrop', onclick: close });
  const sheet = h('div', { class: 'glass glass--liquid sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('span', { class: 'sheet__grip' }),
    h('div', { class: 'panel__head', style: { padding: '6px 18px 10px' } },
      h('span', { class: 'panel__title' }, icon(iconName), title),
      h('span', { style: { flex: '1' } }),
      h('button', { class: 'iconbtn', 'aria-label': '关闭', onclick: close }, icon('x')),
    ),
    h('div', { style: { padding: '0 18px 18px', overflow: 'auto', display: 'grid', gap: '10px' } }, body),
    footer ? h('div', { style: { padding: '0 18px 18px' } }, footer) : h('span'),
  );

  root.append(backdrop, sheet);
  // 让屏幕阅读器与键盘用户立刻进入面板
  (sheet.querySelector('button, select, input, [tabindex]') ?? sheet).focus?.();
  return close;
}
