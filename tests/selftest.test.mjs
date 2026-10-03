/**
 * 自检模块的 Node 端验证：真实跑一遍 runSelfTest()，断言「没有真实失败」。
 *
 * 注意：模块文件缺失会让对应用例变成 skip（不是 fail），因此 failed === 0 只在
 * 「所有已就绪模块都转换正确」时成立。失败用例会在报错信息里逐条列出，方便定位。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { listSelfTestCases, runSelfTest } from '../src/core/selftest.js';

const STATUSES = new Set(['pass', 'fail', 'skip']);

function renderTable(summary) {
  const lines = summary.cases.map((item) => {
    const mark = item.status === 'pass' ? '✔' : item.status === 'fail' ? '✖' : '○';
    return `${mark} [${item.status}] ${item.id}（${item.converter}）${item.durationMs}ms\n    ${item.detail}`;
  });
  return lines.join('\n');
}

test('runSelfTest：结构完整、失败为 0', async (t) => {
  const seen = { cases: [], messages: [] };
  const summary = await runSelfTest({
    onProgress: (payload) => {
      if (typeof payload === 'string') seen.messages.push(payload);
      else if (payload?.case) seen.cases.push(payload.case);
      else if (payload?.message) seen.messages.push(payload.message);
    },
  });

  console.log(`\n=== 自检结果（env=${summary.env}，耗时 ${summary.durationMs}ms） ===`);
  console.log(`通过 ${summary.passed} / 失败 ${summary.failed} / 跳过 ${summary.skipped} / 共 ${summary.total}`);
  console.log(renderTable(summary));

  const skipped = summary.cases.filter((item) => item.status === 'skip');
  if (skipped.length) {
    console.log('\n--- 跳过清单（含原因） ---');
    for (const item of skipped) console.log(`○ ${item.id}（${item.converter}）：${item.detail}`);
  }

  // 结构契约：界面「能力矩阵」页按 converter 归因，字段一个都不能少
  assert.ok(summary.total >= 20, `用例数偏少：${summary.total}`);
  for (const item of summary.cases) {
    assert.ok(item.id && typeof item.id === 'string', `用例缺少 id：${JSON.stringify(item)}`);
    assert.ok(item.name && typeof item.name === 'string', `${item.id} 缺少 name`);
    assert.ok(STATUSES.has(item.status), `${item.id} 状态非法：${item.status}`);
    assert.ok(item.converter && typeof item.converter === 'string', `${item.id} 缺少 converter 字段`);
    assert.ok(typeof item.detail === 'string' && item.detail.length > 0, `${item.id} 缺少可读 detail`);
    assert.equal(typeof item.durationMs, 'number', `${item.id} 缺少 durationMs`);
    assert.ok(item.durationMs >= 0, `${item.id} durationMs 为负`);
  }
  assert.equal(summary.passed + summary.failed + summary.skipped, summary.total, '状态计数不自洽');

  // onProgress 两种形状都要能收到
  assert.equal(seen.cases.length, summary.total, `onProgress({case}) 次数应为 ${summary.total}，实际 ${seen.cases.length}`);
  assert.ok(seen.messages.length >= summary.total, 'onProgress({message}) 未收到阶段性进度');
  assert.deepEqual(seen.cases.at(-1), summary.cases.at(-1), 'onProgress 回传的 case 应与最终结果一致');

  const failures = summary.cases.filter((item) => item.status === 'fail');
  assert.equal(
    summary.failed,
    0,
    `【真实缺陷】以下 ${failures.length} 项自检失败（非脚手架问题）：\n${failures
      .map((item) => `  ✖ ${item.id}（${item.converter}）：${item.detail}`)
      .join('\n')}`,
  );
  t.diagnostic(`通过 ${summary.passed} / 跳过 ${summary.skipped} / 失败 0`);
});

test('runSelfTest：only 过滤后其余用例标 skip', async () => {
  const summary = await runSelfTest({ only: 'encoding-gbk' });
  const picked = summary.cases.filter((item) => item.id === 'encoding-gbk');
  assert.equal(picked.length, 1, 'only 指定的用例没有执行');
  assert.notEqual(picked[0].status, 'skip', `only 指定的用例被跳过了：${picked[0].detail}`);
  assert.equal(summary.total, summary.cases.length);
  assert.equal(
    summary.cases.filter((item) => item.status === 'skip').length,
    summary.total - 1,
    'only 过滤后其余用例应全部标 skip',
  );
});

test('listSelfTestCases：用例清单与 converter 归因一致', () => {
  const cases = listSelfTestCases();
  assert.ok(cases.length >= 20, `用例数偏少：${cases.length}`);
  const ids = new Set(cases.map((item) => item.id));
  assert.equal(ids.size, cases.length, '用例 id 有重复');
  for (const item of cases) {
    assert.ok(item.converter, `${item.id} 缺少 converter`);
    assert.equal(typeof item.browserOnly, 'boolean', `${item.id} browserOnly 应为布尔值`);
  }
  const browserOnly = cases.filter((item) => item.browserOnly).map((item) => item.id);
  assert.ok(browserOnly.length >= 2, `浏览器专属用例应至少 2 个，实际：${browserOnly.join('、')}`);
});
