import { convert } from '../src/core/chat-export.js';
import { createApi } from '../tests/helpers/api-stub.mjs';
const now = Math.floor(Date.now() / 1000);
const node = (id, parent, role, text) => ({ id, parent, children: [], message: { id, author: { role }, create_time: now, content: { content_type: 'text', parts: [text] }, metadata: {} } });
const mapping = {};
mapping.s1 = node('s1', null, 'system', '你是一个写作助手');
mapping.u1 = node('u1', 's1', 'user', '最近想写个小说开头');
mapping.a1 = node('a1', 'u1', 'assistant', '可以从一个动作开始。');
mapping.s1.children = ['u1']; mapping.u1.children = ['a1'];
const fixture = [{ title: '测试', create_time: now, current_node: 'a1', mapping }];
for (const options of [{}, { includeSystem: true }]) {
  const api = createApi(JSON.stringify(fixture), options);
  const result = await convert(api.input, api);
  const text = new TextDecoder().decode(result.files[0].bytes);
  console.log('options=', JSON.stringify(options), '含系统提示 =', text.includes('你是一个写作助手'));
  console.log('   notes:', (result.notes ?? []).map(n => n.message));
  console.log('   前 120 字:', text.replace(/\n/g, '|').slice(0, 120));
}
