/**
 * 能力矩阵：把「到底能转什么」摊开给用户看，包括实测状态。
 * 用户最怕的不是功能少，是不知道能不能用——所以这里显示自检的真实结果。
 */
import { FORMATS, capabilityMatrix, formatLabel } from '../../core/registry.js';
import { h, icon } from '../dom.js';
import { set, state } from '../store.js';

export function renderMatrix(root) {
  const converters = capabilityMatrix();
  const selfTest = loadSelfTest();
  const statusOf = (id) => selfTest?.byConverter?.[id] ?? null;

  const formats = Object.entries(FORMATS);
  const groups = new Map();
  for (const [ext, info] of formats) {
    if (!groups.has(info.group)) groups.set(info.group, []);
    groups.get(info.group).push([ext, info]);
  }

  root.append(h('section', { class: 'glass glass--liquid halo panel rise rise-1' },
    h('div', { class: 'panel__head' },
      h('span', { class: 'panel__title' }, icon('grid'), '能力矩阵'),
      h('span', { class: 'badge badge--info' }, `${converters.length} 个转换引擎`),
      h('span', { class: 'badge badge--mute' }, `${formats.length} 种格式`),
      h('span', { style: { flex: '1' } }),
      h('button', {
        class: 'btn btn--sm btn--primary',
        onclick: () => set({ view: 'selftest' }),
      }, icon('play'), '跑一次实机自检'),
    ),
    h('p', { class: 'panel__desc', style: { color: 'var(--text-2)', fontSize: '0.9rem' } },
      selfTest
        ? `上次自检：${new Date(selfTest.at).toLocaleString('zh-CN')} · 通过 ${selfTest.passed}/${selfTest.total}${selfTest.failed ? ` · 失败 ${selfTest.failed}` : ''}`
        : '还没有跑过自检。点右上角「跑一次实机自检」，它会用现场生成的真实文件把每个引擎跑一遍。'),
  ));

  root.append(h('div', { class: 'matrix' }, ...converters.map((converter) => matrixCard(converter, statusOf(converter.id)))));

  root.append(h('section', { class: 'glass panel rise' },
    h('div', { class: 'panel__head' }, h('span', { class: 'panel__title' }, icon('list'), '格式总览')),
    h('div', { class: 'panel__body' }, ...[...groups.entries()].map(([group, items]) => h('div', { class: 'optgroup' },
      h('span', { class: 'optgroup__title' }, group),
      h('div', { class: 'matrix__flows' }, ...items.map(([ext, info]) => h('span', { class: 'flow' }, `${info.label}（.${ext}）`))),
    ))),
  ));
}

function matrixCard(converter, status) {
  const badge = status === 'pass'
    ? h('span', { class: 'badge badge--ok' }, icon('check'), '实测通过')
    : status === 'fail'
      ? h('span', { class: 'badge badge--err' }, icon('alert'), '实测失败')
      : h('span', { class: 'badge badge--mute' }, '未实测');

  return h('article', { class: 'glass glass--soft matrix__card rise' },
    h('div', { class: 'panel__head' },
      h('span', { class: 'panel__title' }, icon(categoryIcon(converter.category)), converter.label),
      h('span', { style: { flex: '1' } }),
      badge,
    ),
    h('div', { class: 'matrix__flows' },
      ...converter.from.map((ext) => h('span', { class: 'flow flow--hl' }, formatLabel(ext))),
      h('span', { class: 'flow' }, icon('arrow'), '转到'),
      ...converter.to.map((ext) => h('span', { class: 'flow' }, formatLabel(ext))),
    ),
    h('span', { class: 'panel__hint' },
      `优先级 ${converter.priority} · 输入 ${converter.from.length} 种 · 输出 ${converter.to.length} 种`),
  );
}

function categoryIcon(category) {
  return {
    chat: 'chat', document: 'file', table: 'grid', text: 'text', image: 'image',
    pdf: 'file', archive: 'archive', subtitle: 'text', media: 'music',
  }[category] ?? 'file';
}

export function loadSelfTest() {
  try {
    return JSON.parse(localStorage.getItem('prism.selftest') ?? 'null');
  } catch {
    return null;
  }
}
