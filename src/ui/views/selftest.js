/**
 * 实机自检页：用现场生成的真实文件把每个引擎跑一遍。
 * 这是「实操不报错」最直接的证据——用户自己就能点一次看结果。
 */
import { h, icon } from '../dom.js';
import { set, state } from '../store.js';
import { toast } from '../toast.js';

const runState = {
  running: false,
  cases: [],
  summary: null,
  error: null,
  current: '',
};

export function renderSelfTest(root) {
  const actions = h('div', { class: 'filecard__actions' },
    h('button', {
      class: 'btn btn--primary',
      disabled: runState.running,
      onclick: () => run(),
    }, icon(runState.running ? 'refresh' : 'play'), runState.running ? '正在自检…' : '开始自检'),
    h('button', {
      class: 'btn btn--ghost',
      disabled: runState.running,
      onclick: () => {
        runState.cases = [];
        runState.summary = null;
        set({});
      },
    }, icon('trash'), '清空结果'),
  );

  root.append(h('section', { class: 'glass glass--liquid halo panel rise rise-1' },
    h('div', { class: 'panel__head' },
      h('span', { class: 'panel__title' }, icon('cpu'), '实机自检'),
      runState.summary
        ? h('span', { class: `badge ${runState.summary.failed ? 'badge--err' : 'badge--ok'}` },
          `${runState.summary.passed}/${runState.summary.total} 通过`)
        : h('span', { class: 'badge badge--mute' }, '未运行'),
      h('span', { style: { flex: '1' } }),
      h('button', { class: 'btn btn--sm btn--ghost', onclick: () => set({ view: 'matrix' }) }, icon('grid'), '看能力矩阵'),
    ),
    h('p', { style: { color: 'var(--text-2)', fontSize: '0.9rem' } },
      '自检会在你的设备上现场生成测试文件（中文 TXT、聊天记录 JSON、BMP 像素、CSV、SRT 等），然后走完整转换链路，逐项断言结果里有没有正确的中文、文件是否是合法格式。全程不联网、不上传。'),
    actions,
  ));

  if (runState.error) {
    root.append(h('div', { class: 'glass panel rise' },
      h('span', { class: 'badge badge--err' }, icon('alert'), '自检模块加载失败'),
      h('p', { class: 'panel__hint' }, runState.error),
    ));
  }

  if (runState.cases.length) {
    root.append(h('section', { class: 'glass panel rise rise-2' },
      h('div', { class: 'panel__head' }, h('span', { class: 'panel__title' }, icon('list'), '逐项结果')),
      h('div', { class: 'caselist' }, ...runState.cases.map(caseRow)),
    ));
  }
}

function caseRow(item) {
  return h('div', { class: 'case', dataset: { status: item.status } },
    h('span', { class: 'case__dot' }),
    h('div', { class: 'case__body' },
      h('span', { class: 'case__name' }, `${item.name}${item.durationMs ? ` · ${item.durationMs} ms` : ''}`),
      item.detail ? h('span', { class: 'case__detail' }, item.detail) : h('span'),
      item.sample ? h('span', { class: 'case__detail', style: { opacity: 0.7 } }, `样例：${item.sample.slice(0, 120)}`) : h('span'),
    ),
    h('span', { class: `badge ${item.status === 'pass' ? 'badge--ok' : item.status === 'fail' ? 'badge--err' : 'badge--warn'}` },
      item.status === 'pass' ? '通过' : item.status === 'fail' ? '失败' : '跳过'),
  );
}

async function run() {
  runState.running = true;
  runState.cases = [];
  runState.error = null;
  runState.summary = null;
  set({});

  try {
    const module = await import('../../core/selftest.js');
    const result = await module.runSelfTest({
      onProgress: (info) => {
        if (info?.case) {
          runState.cases = [...runState.cases.filter((c) => c.id !== info.case.id), info.case];
        } else if (info?.message) {
          runState.current = info.message;
        }
        set({});
      },
    });

    runState.cases = result.cases ?? [];
    runState.summary = { passed: result.passed ?? 0, failed: result.failed ?? 0, total: result.total ?? runState.cases.length };
    persist(result);
    toast(runState.summary.failed === 0
      ? `自检通过：${runState.summary.passed}/${runState.summary.total}`
      : `自检有 ${runState.summary.failed} 项失败，详情见列表`, runState.summary.failed === 0 ? 'ok' : 'err', 5200);
  } catch (err) {
    runState.error = err?.message ?? String(err);
    toast('自检模块不可用（可能还在构建中）', 'err');
  } finally {
    runState.running = false;
    set({});
  }
}

/** 结果落盘，能力矩阵页直接引用，避免用户跑两次 */
function persist(result) {
  const byConverter = {};
  for (const item of result.cases ?? []) {
    if (!item.converter) continue;
    const current = byConverter[item.converter];
    if (item.status === 'fail') byConverter[item.converter] = 'fail';
    else if (item.status === 'pass' && current !== 'fail') byConverter[item.converter] = 'pass';
  }
  try {
    localStorage.setItem('prism.selftest', JSON.stringify({
      at: Date.now(),
      passed: result.passed ?? 0,
      failed: result.failed ?? 0,
      total: result.total ?? 0,
      byConverter,
      cases: (result.cases ?? []).map(({ id, name, status, detail }) => ({ id, name, status, detail })),
    }));
  } catch {
    /* 存储被禁用时不影响自检本身 */
  }
}
