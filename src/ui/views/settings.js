/**
 * 设置：外观、默认行为、隐私、存储、引擎状态。
 * 不堆无意义的开关，每一项都真的会影响使用体验。
 */
import { ENCODINGS } from '../../core/encoding.js';
import { listLibs } from '../../core/lib-loader.js';
import { h, icon, downloadBlob } from '../dom.js';
import { applyPerf, applyTheme, currentTheme, haptic } from '../glass.js';
import { setDefault, set, state } from '../store.js';
import { toast } from '../toast.js';
import { VERSION, BUILD_INFO } from '../../version.js';

export function renderSettings(root) {
  root.append(aboutPanel());
  root.append(appearancePanel());
  root.append(defaultsPanel());
  root.append(storagePanel());
  root.append(privacyPanel());
}

function aboutPanel() {
  return h('section', { class: 'glass glass--liquid halo panel rise rise-1' },
    h('div', { class: 'panel__head' },
      h('span', { class: 'panel__title' }, icon('prism'), '棱镜 Prism'),
      h('span', { class: 'badge badge--info' }, `v${VERSION}`),
      h('span', { class: 'badge badge--ok' }, icon('shield'), '本机处理'),
    ),
    h('p', { style: { color: 'var(--text-2)', fontSize: '0.9rem' } },
      '双端全能文件转换器：手机与电脑用同一套界面与同一套引擎，所有转换在你的设备上完成。'),
    h('div', { class: 'matrix__flows' },
      h('span', { class: 'flow' }, `环境 ${BUILD_INFO.env}`),
      h('span', { class: 'flow' }, `内核 ${BUILD_INFO.cores} 核`),
      h('span', { class: 'flow' }, `内存提示 ${BUILD_INFO.memory}`),
      h('span', { class: 'flow' }, `已登记依赖 ${listLibs().length} 个`),
    ),
  );
}

function appearancePanel() {
  const themeSelect = h('select', {
    class: 'field',
    onchange: (event) => {
      applyTheme(event.target.value, true);
      haptic(8);
    },
  });
  for (const [value, label] of [['dark', '深色（光内敛，折射更深）'], ['light', '浅色（明亮通透）']]) {
    themeSelect.append(h('option', { value, selected: currentTheme() === value }, label));
  }

  const perfSelect = h('select', {
    class: 'field',
    onchange: (event) => {
      applyPerf(event.target.value);
      haptic(8);
    },
  });
  for (const [value, label] of [['full', '完整毛玻璃（好看）'], ['lite', '轻量（老手机更流畅）']]) {
    perfSelect.append(h('option', {
      value,
      selected: (document.documentElement.dataset.perf ?? 'full') === value,
    }, label));
  }

  return h('section', { class: 'glass panel rise rise-2' },
    h('div', { class: 'panel__head' }, h('span', { class: 'panel__title' }, icon('sun'), '外观')),
    h('div', { class: 'optgroup' },
      h('div', { class: 'optrow' }, h('label', { class: 'optrow__label' }, '主题'), themeSelect),
      h('div', { class: 'optrow' }, h('label', { class: 'optrow__label' }, '玻璃强度'), perfSelect),
      h('p', { class: 'panel__hint' }, '界面会跟随指针与手指移动高光；关闭完整毛玻璃可以在低端机上明显省电。'),
    ),
  );
}

function defaultsPanel() {
  const encodingSelect = h('select', {
    class: 'field',
    onchange: (event) => {
      setDefault('encoding', event.target.value);
      toast(`默认输出编码已设为 ${event.target.value.toUpperCase()}`, 'ok');
    },
  });
  for (const enc of ENCODINGS.filter((e) => e.id !== 'auto')) {
    encodingSelect.append(h('option', {
      value: enc.id, selected: state.defaults.encoding === enc.id,
    }, enc.label));
  }

  const shareToggle = h('label', { class: 'optrow optrow--inline' },
    h('span', { class: 'optrow__label' }, '手机端转换完成后优先调用系统分享'),
    h('span', { class: 'switch' },
      h('input', {
        type: 'checkbox', checked: !!state.defaults.shareAfterConvert,
        onchange: (event) => setDefault('shareAfterConvert', event.target.checked),
      }),
      h('span', { class: 'switch__track' }),
    ),
  );

  return h('section', { class: 'glass panel rise rise-2' },
    h('div', { class: 'panel__head' }, h('span', { class: 'panel__title' }, icon('settings'), '默认行为')),
    h('div', { class: 'optgroup' },
      h('div', { class: 'optrow' }, h('label', { class: 'optrow__label' }, '默认输出编码'), encodingSelect),
      shareToggle,
      h('p', { class: 'panel__hint' }, '老阅读器、老电视、部分国产软件只认 GBK，遇到乱码时优先试它。'),
      engineMirrorRow(),
    ),
  );
}

/**
 * 音视频引擎地址：默认走国内 npm 镜像（比海外托管快几百倍），
 * 留空则用内置的镜像顺序；填了就优先用它，方便自建反代或换镜像。
 */
function engineMirrorRow() {
  const current = (() => {
    try {
      return localStorage.getItem('prism.engineMirror') ?? '';
    } catch {
      return '';
    }
  })();
  const input = h('input', {
    class: 'field',
    type: 'text',
    value: current,
    placeholder: '留空 = 自动（国内镜像 → 本站 → 公共 CDN）',
    onchange: (event) => {
      const value = event.target.value.trim();
      try {
        if (value) localStorage.setItem('prism.engineMirror', value);
        else localStorage.removeItem('prism.engineMirror');
      } catch {
        /* 隐私模式下写不了，忽略 */
      }
      toast(value ? '已保存自定义引擎地址' : '已恢复自动选择引擎源', 'ok');
    },
  });
  return h('div', { class: 'optrow' },
    h('label', { class: 'optrow__label' },
      h('span', null, '音视频引擎地址'),
      h('span', { class: 'optrow__value' }, current ? '自定义' : '自动'),
    ),
    input,
    h('p', { class: 'panel__hint' }, '可填 @ffmpeg/core 的 tarball 地址（.tgz）或自建镜像；首次音视频转换时下载约 20MB，之后离线可用。'),
  );
}

function storagePanel() {
  const usageLabel = h('span', { class: 'statcard__sub' }, '计算中…');
  navigator.storage?.estimate?.().then(({ usage, quota }) => {
    const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    usageLabel.textContent = `已用 ${mb(usage ?? 0)} / 可用 ${mb(quota ?? 0)}`;
  }).catch(() => { usageLabel.textContent = '当前浏览器不提供存储信息'; });

  return h('section', { class: 'glass panel rise rise-3' },
    h('div', { class: 'panel__head' }, h('span', { class: 'panel__title' }, icon('package'), '存储与缓存')),
    h('div', { class: 'optgroup' },
      h('div', { class: 'optrow' }, h('span', { class: 'optrow__label' }, '浏览器存储占用'), usageLabel),
      h('div', { class: 'filecard__actions' },
        h('button', {
          class: 'btn btn--sm',
          onclick: async () => {
            const data = collectDiagnostics();
            downloadBlob(`棱镜-诊断-${new Date().toISOString().slice(0, 10)}.json`, new TextEncoder().encode(JSON.stringify(data, null, 2)), 'application/json');
            toast('诊断信息已导出（可用于排查问题）', 'ok');
          },
        }, icon('download'), '导出诊断信息'),
        h('button', {
          class: 'btn btn--sm btn--ghost',
          onclick: async () => {
            const keys = Object.keys(localStorage).filter((k) => k.startsWith('prism.'));
            keys.forEach((k) => localStorage.removeItem(k));
            toast('已清除本机偏好设置', 'ok');
            set({ view: 'settings' });
          },
        }, icon('trash'), '清除本机偏好'),
      ),
      h('p', { class: 'panel__hint' }, '诊断信息只包含浏览器能力与引擎状态，不含你的任何文件内容。'),
    ),
  );
}

function privacyPanel() {
  const rows = [
    ['文件不离开设备', '所有转换在浏览器里完成，没有服务器接收你的文件，也没有上传接口。'],
    ['不联网也能用', '首次加载后可以离线使用；只有音视频引擎（WASM）需要一次性下载。'],
    ['没有账号与追踪', '不收集使用数据，不埋点，不写 Cookie。'],
    ['你可以自己验证', '断网后打开本页照样能转换；也可以在开发者工具的「网络」面板里看有没有上传请求。'],
  ];
  return h('section', { class: 'glass panel rise rise-4' },
    h('div', { class: 'panel__head' }, h('span', { class: 'panel__title' }, icon('shield'), '隐私')),
    h('div', { class: 'caselist' }, ...rows.map(([title, desc]) => h('div', { class: 'case', dataset: { status: 'pass' } },
      h('span', { class: 'case__dot' }),
      h('div', { class: 'case__body' },
        h('span', { class: 'case__name' }, title),
        h('span', { class: 'case__detail' }, desc),
      ),
    ))),
  );
}

function collectDiagnostics() {
  return {
    at: new Date().toISOString(),
    version: VERSION,
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: navigator.platform,
    cores: navigator.hardwareConcurrency ?? null,
    deviceMemory: navigator.deviceMemory ?? null,
    theme: currentTheme(),
    perf: document.documentElement.dataset.perf,
    storage: 'estimate 见浏览器',
    capabilities: {
      offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
      createImageBitmap: typeof createImageBitmap !== 'function' ? 'missing' : 'ok',
      webAssembly: typeof WebAssembly !== 'undefined',
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      fileSystemAccess: 'showSaveFilePicker' in window,
      share: !!navigator.share,
      serviceWorker: 'serviceWorker' in navigator,
    },
    libs: listLibs(),
  };
}
