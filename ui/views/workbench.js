/**
 * 转换台：拖入 → 识别 → 选目标 → 调参数 → 转换 → 拿结果。
 * 桌面三栏（队列 / 舞台 / 参数），手机上折成单列 + 底部操作条。
 */
import { ENCODINGS } from '../../core/encoding.js';
import { FORMATS, canonicalExt, findCandidates, formatLabel, getConverter } from '../../core/registry.js';
import { h, icon, isMobile, shareFile, downloadBlob } from '../dom.js';
import { haptic } from '../glass.js';
import {
  addFiles, clearFiles, currentConverter, removeFile, runAll, runConvert, setConverter,
  setEncoding, setOption, setTarget, state, targetsFor, zipAllResults,
} from '../store.js';
import { openSheet } from '../sheet.js';
import { toast } from '../toast.js';

const FAMILY_ICON = {
  chat: 'chat', text: 'text', table: 'grid', document: 'file', image: 'image',
  pdf: 'file', media: 'music', archive: 'archive', subtitle: 'text', zip: 'archive', font: 'file', binary: 'file',
};

export function renderWorkbench(root) {
  root.append(hero(), footerNote());
  const zone = dropzone();
  root.append(zone);
  root.append(fileQueue());
  if (isMobile()) renderMobileActionBar();
}

/* ------------------------------- 英雄区 ------------------------------- */

function hero() {
  const wrap = h('section', { class: 'glass glass--liquid halo hero rise rise-1' });
  wrap.append(
    h('span', { class: 'sheen' }),
    h('div', { class: 'hero__eyebrow' },
      h('span', { class: 'badge badge--info' }, icon('shield'), '本机处理 · 不上传'),
      h('span', null, '纯前端 · 无服务器'),
    ),
    h('h1', { class: 'hero__title', html: '把文件拖进来，<em>就地变成你要的样子</em>' }),
    h('p', { class: 'hero__desc', html: '聊天记录、Word、表格、图片、PDF、音视频、压缩包、字幕——识别、转换、编码修复全部在你自己的设备上完成，手机与电脑同一套界面。' }),
    h('div', { class: 'hero__stats' },
      statChip('i-chat', 'AI 聊天记录 → 可读 TXT'),
      statChip('i-text', 'GBK / Big5 乱码修复'),
      statChip('i-image', 'HEIC / AVIF / WebP 互转'),
      statChip('i-music', '音视频转码（WASM ffmpeg）'),
    ),
  );
  return wrap;
}

function statChip(iconName, text) {
  return h('span', { class: 'chip' }, icon(iconName), text);
}

function footerNote() {
  return h('p', { class: 'panel__hint', style: { paddingInline: '0.3rem' } },
    '提示：文件不会离开这台设备。首次使用音视频转换时会下载一次 WASM 引擎（约 30MB），之后离线可用。');
}

/* ------------------------------- 拖放区 ------------------------------- */

function dropzone() {
  const mobile = isMobile();
  const input = h('input', {
    type: 'file', multiple: true, class: 'sr-only',
    onchange: (event) => {
      addFiles(event.target.files);
      event.target.value = '';
    },
  });

  const zone = h('div', {
    class: 'dropzone glass rise rise-2',
    role: 'button',
    tabindex: '0',
    onclick: () => input.click(),
    onkeydown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        input.click();
      }
    },
  },
    h('span', { class: 'dropzone__icon' }, icon('upload')),
    h('span', { class: 'dropzone__title' }, mobile ? '点这里选文件' : '拖进来，或点这里选文件'),
    h('span', { class: 'dropzone__sub' }, mobile
      ? '支持批量 · 也可以长按输入框粘贴文字 · 从相册或「文件」里都能选'
      : '支持批量 · 也可以直接 Ctrl/⌘+V 粘贴 · 手机端同样可用'),
    input,
  );

  let depth = 0;
  zone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    depth += 1;
    zone.dataset.drag = 'true';
  });
  zone.addEventListener('dragover', (event) => event.preventDefault());
  zone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) delete zone.dataset.drag;
  });
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    delete zone.dataset.drag;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) {
      haptic(14);
      addFiles(files);
    }
  });

  return zone;
}

/* ------------------------------- 文件队列 ------------------------------- */

function fileQueue() {
  const section = h('section', { class: 'panel__body' });
  if (state.files.length === 0) {
    section.append(h('div', { class: 'glass empty rise rise-3' }, icon('list'), '还没有文件。拖一个进来试试。'));
    return section;
  }

  const head = h('div', { class: 'panel__head' },
    h('span', { class: 'panel__title' }, icon('list'), `队列 · ${state.files.length} 个文件`),
    h('span', { style: { flex: '1' } }),
    h('button', { class: 'btn btn--sm btn--ghost', onclick: () => clearFiles() }, icon('trash'), '清空'),
    h('button', {
      class: 'btn btn--sm btn--primary',
      onclick: async () => {
        await runAll();
        toast('批量转换结束', 'ok');
      },
    }, icon('bolt'), '全部转换'),
    h('button', {
      class: 'btn btn--sm',
      onclick: async () => {
        const zip = await zipAllResults();
        if (!zip) return toast('还没有可下载的结果', 'warn');
        downloadBlob(zip.name, zip.bytes, zip.mime);
        toast('已打包下载', 'ok');
      },
    }, icon('package'), '打包下载'),
  );

  const list = h('div', { class: 'filelist' });
  for (const entry of state.files) list.append(fileCard(entry));
  section.append(head, list);
  return section;
}

function fileCard(entry) {
  const card = h('article', {
    class: 'glass glass--soft filecard rise',
    dataset: { fileCard: entry.id, state: entry.status },
  });

  const typeLabel = entry.analysis?.label ?? '识别中…';
  const sub = h('div', { class: 'filecard__sub' });
  if (entry.analysis) {
    sub.append(h('span', { class: 'badge badge--mute' }, typeLabel));
    sub.append(h('span', null, entry.analysis.sizeLabel));
    if (entry.analysis.isText && entry.analysis.encodingLabel) {
      sub.append(h('button', {
        class: `badge ${entry.analysis.encoding.encoding === 'utf-8' ? 'badge--info' : 'badge--warn'}`,
        style: { cursor: 'pointer', border: '1px solid currentColor' },
        title: '点开可以对比不同编码的解码效果',
        onclick: () => openEncodingSheet(entry),
      }, icon('text'), entry.analysis.encodingLabel));
    }
    if (entry.analysis.garbled) {
      sub.append(h('span', { class: 'badge badge--err' }, icon('alert'), '疑似乱码，点编码徽标试试别的'));
    }
    if (entry.chat) {
      sub.append(h('span', { class: 'badge badge--ok' }, icon('check'), `识别为 ${entry.chat.providerLabel}`));
    }
  } else {
    sub.append(h('span', null, entry.size ? `${(entry.size / 1024).toFixed(0)} KB` : ''));
  }

  const top = h('div', { class: 'filecard__top' },
    h('span', { class: 'filecard__icon' }, icon(FAMILY_ICON[entry.analysis?.family] ?? 'file')),
    h('div', { class: 'filecard__meta' },
      h('span', { class: 'filecard__name', title: entry.name }, entry.name),
      sub,
    ),
    h('button', {
      class: 'iconbtn', title: '移除', 'aria-label': '移除文件',
      onclick: () => removeFile(entry.id),
    }, icon('x')),
  );

  card.append(top);

  if (entry.analysis && entry.target !== null) {
    card.append(targetPicker(entry));
    if (entry.chat) card.append(chatEntry(entry));
    card.append(optionsBlock(entry));
    card.append(actionRow(entry));
  }

  card.append(statusArea(entry));
  return card;
}

/** 目标格式：横向滚动的胶囊，手机上单手可点 */
function targetPicker(entry) {
  const targets = targetsFor(entry.analysis.ext);
  const scroll = h('div', { class: 'scroll-x' });
  for (const target of targets) {
    const active = canonicalExt(entry.target) === canonicalExt(target);
    scroll.append(h('button', {
      class: `chip chip--pick ${active ? 'chip--active' : ''}`,
      onclick: () => {
        haptic(8);
        setTarget(entry.id, target);
      },
    }, icon('arrow'), formatLabel(target)));
  }

  const candidates = findCandidates(entry.analysis.ext, entry.target ?? '');
  const rows = [h('div', { class: 'optrow' }, h('span', { class: 'optrow__label' }, h('span', null, '转成'), h('span', { class: 'optrow__value' }, FORMATS[canonicalExt(entry.target)]?.group ?? '')), scroll)];

  // 同一份数据有多种解释时（聊天记录 / 配置），让用户自己选，别猜
  if (candidates.length > 1) {
    const select = h('select', {
      class: 'field',
      onchange: (event) => setConverter(entry.id, event.target.value),
    });
    for (const candidate of candidates) {
      select.append(h('option', { value: candidate.id, selected: currentConverter(entry)?.id === candidate.id }, candidate.label));
    }
    rows.push(h('div', { class: 'optrow' }, h('span', { class: 'optrow__label' }, h('span', null, '按哪个模块解释'), h('span', { class: 'optrow__value' }, '自动降级已开启')), select));
  }
  return h('div', { class: 'optgroup' }, ...rows);
}

function chatEntry(entry) {
  return h('button', {
    class: 'btn btn--sm btn--block',
    onclick: () => {
      haptic(10);
      import('./chat.js').then((mod) => mod.openChatStudio(entry.id));
    },
  }, icon('chat'), `打开对话工坊（${entry.chat.conversations.length} 个会话）`);
}

/* ------------------------------- 选项 ------------------------------- */

function optionsBlock(entry) {
  const converter = currentConverter(entry);
  const meta = converter ? getConverter(converter.id) : null;
  const options = meta?.options ?? [];
  if (options.length === 0) return h('span');

  const body = h('div', { class: 'optgroup' });
  for (const option of options) {
    body.append(optionRow(entry, option));
  }
  return h('details', { class: 'optgroup' },
    h('summary', { style: { cursor: 'pointer', color: 'var(--text-2)', fontSize: '0.84rem' } },
      `转换参数（${converter.label}）`),
    h('div', { style: { paddingTop: '0.6rem' } }, body),
  );
}

function optionRow(entry, option) {
  const value = entry.options[option.key] ?? option.default;
  const setValue = (next) => setOption(entry.id, option.key, next);

  if (option.type === 'boolean') {
    return h('label', { class: 'optrow optrow--inline' },
      h('span', { class: 'optrow__label' }, option.label),
      h('span', { class: 'switch' },
        h('input', { type: 'checkbox', checked: value, onchange: (event) => setValue(event.target.checked) }),
        h('span', { class: 'switch__track' }),
      ),
    );
  }

  if (option.type === 'select' || option.type === 'encoding') {
    const choices = option.type === 'encoding'
      ? ENCODINGS.map((enc) => ({ value: enc.id, label: enc.label }))
      : option.choices ?? [];
    const select = h('select', {
      class: 'field',
      onchange: (event) => setValue(event.target.value),
    });
    for (const choice of choices) {
      select.append(h('option', { value: choice.value, selected: String(value) === String(choice.value) }, choice.label));
    }
    return h('div', { class: 'optrow' }, h('label', { class: 'optrow__label' }, option.label), select);
  }

  if (option.type === 'range') {
    const valueLabel = h('span', { class: 'optrow__value num' }, String(value));
    const input = h('input', {
      class: 'field', type: 'range', min: option.min ?? 0, max: option.max ?? 1, step: option.step ?? 0.1, value,
      oninput: (event) => {
        valueLabel.textContent = event.target.value;
        setValue(Number(event.target.value));
      },
    });
    return h('div', { class: 'optrow' },
      h('label', { class: 'optrow__label' }, h('span', null, option.label), valueLabel), input);
  }

  return h('div', { class: 'optrow' },
    h('label', { class: 'optrow__label' }, option.label),
    h('input', {
      class: 'field', type: 'text', value, placeholder: option.label,
      oninput: (event) => setValue(event.target.value),
    }),
  );
}

/* ------------------------------- 动作与状态 ------------------------------- */

function actionRow(entry) {
  const converting = entry.status === 'converting';
  return h('div', { class: 'filecard__actions' },
    h('button', {
      class: 'btn btn--sm btn--primary', disabled: converting,
      onclick: () => runConvert(entry.id),
    }, icon(converting ? 'refresh' : 'bolt'), converting ? '转换中…' : (entry.result ? '重新转换' : '开始转换')),
    entry.analysis?.isText && entry.analysis.garbled
      ? h('button', { class: 'btn btn--sm btn--ghost', onclick: () => openEncodingSheet(entry) }, icon('wand'), '修复乱码')
      : h('span'),
  );
}

function statusArea(entry) {
  const area = h('div', { dataset: { statusArea: entry.id } });
  patchStatus(area, entry);
  return area;
}

function patchStatus(area, entry) {
  area.replaceChildren();
  if (entry.status === 'analyzing' || entry.status === 'converting') {
    const fill = h('div', { class: 'progress__fill', style: { width: `${Math.max(6, entry.progress * 100)}%` } });
    const blob = h('span', { class: 'progress__blob', style: { left: `${Math.max(6, entry.progress * 100)}%` } });
    area.append(
      h('div', { class: 'optrow__label' }, h('span', null, entry.progressLabel ?? '处理中'), h('span', { class: 'optrow__value num' }, `${Math.round(entry.progress * 100)}%`)),
      h('div', { class: 'progress' }, fill, blob),
    );
    return;
  }

  if (entry.status === 'error') {
    area.append(h('div', { class: 'case', dataset: { status: 'fail' } },
      h('span', { class: 'case__dot' }),
      h('div', { class: 'case__body' },
        h('span', { class: 'case__name' }, '这次没转成功'),
        h('span', { class: 'case__detail' }, `${entry.error?.message ?? '未知错误'}（${entry.error?.code ?? ''}）`),
      ),
    ));
    return;
  }

  if (!entry.result) return;

  const result = entry.result;
  const wrap = h('div', { class: 'resultlist' });
  for (const file of result.files) {
    const stats = file.text ? describeStats(file.text) : null;
    wrap.append(h('div', { class: 'glass glass--soft result' },
      h('div', { class: 'result__head' },
        h('span', { class: 'result__name' }, file.name),
        h('span', { class: 'badge badge--ok' }, icon('check'), '完成'),
        h('span', { class: 'badge badge--mute' }, file.sizeLabel),
        stats ? h('span', { class: 'badge badge--mute' }, stats) : h('span'),
        h('span', { style: { flex: '1' } }),
        h('button', {
          class: 'btn btn--sm btn--primary',
          onclick: () => {
            downloadBlob(file.name, file.bytes, file.mime);
            toast(`已下载 ${file.name}`, 'ok');
          },
        }, icon('download'), '下载'),
        isMobile()
          ? h('button', {
            class: 'btn btn--sm btn--ghost',
            onclick: async () => {
              const shared = await shareFile(file.name, file.bytes, file.mime);
              if (!shared) downloadBlob(file.name, file.bytes, file.mime);
            },
          }, icon('upload'), '分享')
          : h('span'),
        h('button', {
          class: 'btn btn--sm btn--ghost',
          onclick: async () => {
            // 复制文本结果，写作/对话记录场景里最常用
            if (!file.text) return toast('二进制文件不能复制文本', 'warn');
            await navigator.clipboard.writeText(file.text);
            toast('已复制到剪贴板', 'ok');
          },
        }, icon('text'), '复制'),
      ),
      file.text
        ? h('details', null,
          h('summary', { style: { cursor: 'pointer', color: 'var(--text-3)', fontSize: '0.8rem' } }, '查看前 1500 字预览'),
          h('pre', { class: 'preview' }, file.text.slice(0, 1500)))
        : h('span'),
    ));
  }

  if (result.notes?.length) {
    wrap.append(h('div', { class: 'caselist' }, ...result.notes.map((note) => h('div', {
      class: 'case', dataset: { status: note.level === 'warn' ? 'skip' : 'pass' },
    },
    h('span', { class: 'case__dot' }),
    h('div', { class: 'case__body' }, h('span', { class: 'case__detail' }, note.message)),
    ))));
  }

  area.append(wrap);
  area.append(h('span', { class: 'panel__hint' },
    `由「${result.converterLabel}」模块完成 · 用时 ${result.durationMs} ms · ${result.files.length} 个输出文件`));
}

function describeStats(text) {
  const chars = text.length;
  const lines = text.split(/\r\n|\r|\n/).length;
  return `${chars.toLocaleString('zh-CN')} 字 · ${lines} 行`;
}

/* ------------------------------- 编码对比抽屉 ------------------------------- */

export function openEncodingSheet(entry) {
  const candidates = entry.analysis?.encoding?.candidates ?? [];
  const current = entry.analysis?.encoding?.encoding;
  const body = h('div', { class: 'panel__body' });

  body.append(h('p', { class: 'panel__hint' },
    '同一堆字节按不同编码解出来是不一样的。下面是各编码的真实解码结果，看着对的那个点一下就用它。'));

  if (candidates.length === 0) {
    body.append(h('p', { class: 'panel__hint' }, '这个文件已经被确定识别，无需对比。'));
  }
  for (const candidate of candidates) {
    body.append(h('button', {
      class: `glass glass--soft result ${candidate.encoding === current ? 'chip--active' : ''}`,
      style: { textAlign: 'left', cursor: 'pointer' },
      onclick: () => {
        setEncoding(entry.id, candidate.encoding);
        close();
        toast(`已按 ${candidate.encoding.toUpperCase()} 重新读取`, 'ok');
      },
    },
    h('div', { class: 'result__head' },
      h('span', { class: 'result__name' }, formatLabel(candidate.encoding)),
      h('span', { class: `badge ${candidate.encoding === current ? 'badge--ok' : 'badge--mute'}` },
        candidate.encoding === current ? '当前' : `相似度 ${Math.round(candidate.score * 100)}%`),
    ),
    h('pre', { class: 'preview' }, candidate.sample || '（无法用该编码解码）'),
    ));
  }

  body.append(h('div', { class: 'optrow' },
    h('label', { class: 'optrow__label' }, '手动指定输入编码'),
    (() => {
      const select = h('select', { class: 'field', onchange: (event) => { setEncoding(entry.id, event.target.value); close(); } });
      for (const enc of ENCODINGS.filter((e) => e.id !== 'auto')) {
        select.append(h('option', { value: enc.id, selected: enc.id === current }, enc.label));
      }
      return select;
    })()));

  let close = () => {};
  close = openSheet({ title: '编码对比修复', icon: 'wand', body });
}

/* ------------------------------- 手机底部操作条 ------------------------------- */

function renderMobileActionBar() {
  const bar = document.getElementById('mobile-actionbar');
  if (!bar) return;
  bar.hidden = false;
  bar.replaceChildren(
    h('button', {
      class: 'btn btn--primary', style: { flex: '1' },
      onclick: async () => {
        await runAll();
        toast('批量转换结束', 'ok');
      },
    }, icon('bolt'), '全部转换'),
    h('button', {
      class: 'btn',
      onclick: async () => {
        const zip = await zipAllResults();
        if (!zip) return toast('还没有结果', 'warn');
        downloadBlob(zip.name, zip.bytes, zip.mime);
      },
    }, icon('package')),
  );
}

/** 进度这种高频更新只补丁对应卡片，不整树重渲染 */
export function patchWorkbenchProgress(id) {
  const entry = state.files.find((f) => f.id === id);
  const card = document.querySelector(`[data-file-card="${id}"]`);
  if (!entry || !card) return;
  card.dataset.state = entry.status;
  const area = card.querySelector(`[data-status-area="${id}"]`);
  if (area) patchStatus(area, entry);
}
