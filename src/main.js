/**
 * 应用入口：导航、路由、全局手势（拖拽 / 粘贴 / 快捷键）、材质初始化。
 */
import { h, icon } from './ui/dom.js';
import { attachPointerLight, attachRipple, initPerf, initTheme, registerServiceWorker, togglePerf, toggleTheme, haptic } from './ui/glass.js';
import { addFiles, runAll, set, state, subscribe } from './ui/store.js';
import { toast } from './ui/toast.js';
import { renderWorkbench, patchWorkbenchProgress } from './ui/views/workbench.js';
import { renderChat } from './ui/views/chat.js';
import { renderMatrix } from './ui/views/matrix.js';
import { renderSettings } from './ui/views/settings.js';
import { renderSelfTest } from './ui/views/selftest.js';

const VIEWS = [
  { id: 'work', label: '转换台', icon: 'prism', render: renderWorkbench },
  { id: 'chat', label: '对话工坊', icon: 'chat', render: renderChat },
  { id: 'matrix', label: '能力', icon: 'grid', render: renderMatrix },
  { id: 'settings', label: '设置', icon: 'settings', render: renderSettings },
  { id: 'selftest', label: '自检', icon: 'cpu', render: renderSelfTest, hidden: true },
];

const viewRoot = document.getElementById('view');
const nav = document.getElementById('nav');
const tabbar = document.getElementById('tabbar');
const statusDot = document.getElementById('engine-status');

function buildChrome() {
  nav.replaceChildren(...VIEWS.filter((v) => !v.hidden).map((view) => h('button', {
    class: 'nav__item',
    dataset: { navTo: view.id },
    onclick: () => goto(view.id),
  }, icon(view.icon), view.label)));

  tabbar.replaceChildren(...VIEWS.filter((v) => !v.hidden && v.id !== 'chat').slice(0, 4).map((view) => h('button', {
    class: 'tabbar__item',
    dataset: { navTo: view.id },
    onclick: () => goto(view.id),
  }, icon(view.icon), h('span', null, view.label))));
}

function goto(viewId) {
  if (state.view === viewId) return;
  haptic(8);
  set({ view: viewId });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function paintActive() {
  document.querySelectorAll('[data-nav-to]').forEach((el) => {
    el.setAttribute('aria-current', String(el.dataset.navTo === state.view));
  });
  statusDot.classList.toggle('status-dot--busy', state.busy);
  statusDot.textContent = state.busy ? '转换中…' : '引擎待命';
}

export function render() {
  const view = VIEWS.find((v) => v.id === state.view) ?? VIEWS[0];
  viewRoot.replaceChildren();
  viewRoot.removeAttribute('class');
  view.render(viewRoot);
  paintActive();
  if (state.view !== 'work') {
    const bar = document.getElementById('mobile-actionbar');
    if (bar) bar.hidden = true;
  }
}

/* ---------------------------- 全局输入 ---------------------------- */

function wireGlobalInput() {
  // 整页可拖放：拖到任何地方都能加文件，不用瞄准
  let dragDepth = 0;
  document.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('dragleave', (event) => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.style.outline = '';
  });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) addFiles(files);
  });

  // 手机/电脑上「复制一段内容直接粘进来」是很自然的动作
  document.addEventListener('paste', (event) => {
    if (event.target.closest?.('input, textarea, select')) return;
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length) {
      addFiles(files);
      return;
    }
    const text = event.clipboardData?.getData('text/plain');
    if (text && text.trim().length > 0) {
      const looksJson = /^[\s\uFEFF]*[[{]/.test(text);
      const name = looksJson ? `粘贴内容-${Date.now()}.json` : `粘贴内容-${Date.now()}.txt`;
      addFiles([new File([text], name, { type: looksJson ? 'application/json' : 'text/plain' })]);
      toast('已把粘贴内容当作文件加入队列', 'ok');
    }
  });

  document.addEventListener('keydown', (event) => {
    const typing = event.target.closest?.('input, textarea, select, [contenteditable]');
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.onchange = () => addFiles(input.files);
      input.click();
      return;
    }
    if (mod && event.key === 'Enter') {
      event.preventDefault();
      runAll().then(() => toast('批量转换结束', 'ok'));
      return;
    }
    if (mod && event.key.toLowerCase() === 'z' && !typing) {
      // 撤销上一次加入队列的文件，误拖时救命
      const last = state.files.at(-1);
      if (last) {
        state.files.pop();
        set({});
        toast(`已移除 ${last.name}`, 'info');
      }
    }
  });

  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const theme = toggleTheme();
    const btn = document.getElementById('theme-toggle');
    btn?.replaceChildren(icon(theme === 'light' ? 'sun' : 'moon'));
  });

  document.getElementById('perf-toggle')?.addEventListener('click', () => {
    const mode = togglePerf();
    toast(mode === 'lite' ? '已切到轻量模式（省电、更流畅）' : '已恢复完整毛玻璃', 'info');
  });
}

/* ---------------------------- 启动 ---------------------------- */

function boot() {
  initTheme();
  initPerf();
  attachPointerLight(document);
  attachRipple(document);
  buildChrome();
  wireGlobalInput();
  document.getElementById('theme-toggle')?.replaceChildren(icon(
    document.documentElement.dataset.theme === 'light' ? 'sun' : 'moon',
  ));

  subscribe((detail) => {
    // 进度这类高频事件只补丁卡片，避免整树重建导致输入框失焦
    if (detail?.reason === 'progress' && detail.id) {
      patchWorkbenchProgress(detail.id);
      paintActive();
      return;
    }
    render();
  });

  render();
  registerServiceWorker();

  // 深链接：?view=chat|matrix|settings|selftest，方便分享与自动化验收
  const params = new URLSearchParams(location.search);
  const wanted = params.get('view');
  if (wanted && VIEWS.some((v) => v.id === wanted)) {
    set({ view: wanted });
    if (wanted === 'selftest' && params.get('autorun') === '1') {
      // 等待一帧，让自检页先挂载
      setTimeout(() => document.querySelector('.btn--primary')?.click(), 400);
    }
  }

  // 首次访问给一次轻提示，避免用户面对空页面发愣
  if (!localStorage.getItem('prism.welcomed')) {
    localStorage.setItem('prism.welcomed', '1');
    setTimeout(() => toast('拖一个文件进来，或直接 Ctrl/⌘+V 粘贴内容', 'info', 4200), 900);
  }

  wireDesktopUpdater();
}

/** 桌面版（Electron）才有 window.prismDesktop：把「版本更新」进度用轻提示展示出来 */
function wireDesktopUpdater() {
  const bridge = window.prismDesktop;
  if (!bridge) return;
  let progressToast = null;
  let lastShown = -1;
  bridge.onUpdateStatus?.((status) => {
    if (status === 'checking' || status === 'uptodate') return;
    if (status?.state === 'available') {
      toast(`发现新版本 ${status.version}，正在后台下载…`, 'info', 6000);
    } else if (status?.state === 'downloaded') {
      toast(`新版本 ${status.version} 已下载完成，稍等片刻即可重启安装`, 'ok', 8000);
    }
  });
  bridge.onUpdateProgress?.((percent) => {
    const bucket = Math.floor(percent / 10) * 10;
    if (bucket === lastShown) return;
    lastShown = bucket;
    progressToast?.();
    progressToast = toast(`正在下载更新 ${percent}%`, 'info', 120000);
  });
  bridge.onUpdateError?.((message) => toast(`更新检查失败：${message}`, 'err', 6000));
}

boot();
