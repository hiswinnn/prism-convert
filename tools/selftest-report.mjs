import { runSelfTest } from '../src/core/selftest.js';
const r = await runSelfTest({});
console.log(`total=${r.total} passed=${r.passed} failed=${r.failed} skipped=${r.skipped ?? 0}`);
for (const c of r.cases) {
  console.log(`${c.status === 'pass' ? '✔' : c.status === 'fail' ? '✖' : '○'} [${String(c.converter).padEnd(12)}] ${c.name}${c.detail ? ' :: ' + String(c.detail).slice(0, 90) : ''}`);
}

