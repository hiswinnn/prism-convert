/**
 * 临时集成检查（不属于交付测试）：用真实引擎 convertFile 跑一遍表格/数据模块，
 * 验证模块在引擎构造的 api 下也能工作，并确认 target 传递问题的影响面。
 * 用法：node tests/_integration-probe.mjs
 */
import { convertFile } from '../src/core/engine.js';
import { encodeText } from '../src/core/util.js';

const cases = [
  { name: '员工.csv', text: '姓名,年龄\r\n张三,30\r\n', target: undefined },
  { name: 'input.json', text: JSON.stringify({ 名称: '棱镜', 标签: ['中文', 'English'] }), target: 'txt' },
  { name: 'input.json', text: JSON.stringify({ a: 1, b: [true, null, '中文'] }), target: 'xml' },
  { name: 'input.yaml', text: '名称: 棱镜\n版本: 2\n', target: 'json' },
  { name: 'input.json', text: JSON.stringify([{ a: 1 }]), target: 'csv' },
];

for (const item of cases) {
  const bytes = encodeText(item.text, 'utf-8');
  try {
    const result = await convertFile({ name: item.name, bytes }, {
      target: item.target,
      options: item.target ? {} : {},
    });
    const names = result.files.map((f) => `${f.name}(${f.size}B)`).join(', ');
    console.log(`OK   ${item.name} → ${item.target ?? '(默认)'} | ${result.converterId} | ${result.target} | ${names}`);
    if (item.name === '员工.csv' && !item.target) console.log('      默认目标产出前 60 字节：', JSON.stringify([...result.files[0].bytes.slice(0, 4)]));
  } catch (err) {
    console.log(`FAIL ${item.name} → ${item.target ?? '(默认)'} | ${err.name} ${err.code ?? ''} | ${err.message}`);
  }
}

// 显式目标：验证「引擎没把 target 塞进 options」时的真实表现
const bytes = encodeText('姓名,年龄\r\n张三,30\r\n', 'utf-8');
try {
  const result = await convertFile({ name: '员工.csv', bytes }, { target: 'json' });
  console.log(`显式 target=json 实际产出：${result.files[0].name} / 目标=${result.target}`);
  console.log('  内容前 80 字节：', JSON.stringify(new TextDecoder().decode(result.files[0].bytes.slice(0, 80))));
} catch (err) {
  console.log(`显式 target=json 失败：${err.code} ${err.message}`);
}
