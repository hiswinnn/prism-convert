# Prism 棱镜 · 转换器模块契约（v1）

所有转换模块放在 `src/core/`，**必须同时能在浏览器与 Node（测试）中运行**。
本文件是接口的唯一权威定义，实现前先读完。

## 1. 模块文件模板

```js
// src/core/<module>.js
/** @typedef {import('./types.js').Api} Api */

export const meta = {
  id: 'chat-export',            // kebab-case，全局唯一
  category: 'chat',             // chat|document|table|image|pdf|archive|media|subtitle|text|misc
  label: 'AI 聊天记录',
  from: ['json', 'jsonl'],      // 可接受的输入扩展名（'.' 省略，小写）
  to: ['txt', 'md', 'html'],    // 可产出的输出扩展名
  priority: 90,                 // 多模块都能处理同一输入时，数字大者优先
  /** 用户在界面上可调的选项；引擎负责渲染与传值 */
  options: [
    { key: 'timestamps', type: 'boolean', label: '保留时间', default: true },
    { key: 'layout', type: 'select', label: '排版', default: 'chat',
      choices: [{ value: 'chat', label: '对话体' }, { value: 'plain', label: '纯文本' }] },
    { key: 'encoding', type: 'encoding', label: '输出编码', default: 'utf-8' }, // 复用引擎编码列表
  ],
};

/** @param {import('./types.js').Input} input @param {Api} api */
export async function convert(input, api) {
  const text = api.text();                 // 输入文本（已按自动识别编码解码）
  api.progress(0.3, '解析会话');
  ...
  return {
    files: [{ name: '会话记录.txt', bytes: api.encode(out, 'utf-8'), mime: 'text/plain' }],
    preview: out.slice(0, 2000),           // 可选：结果预览纯文本
    notes: [{ level: 'warn', message: '…' }],
  };
}
```

## 2. 硬性规则

1. **禁止顶层 `import` 第三方库**。库一律在 `convert()` 内用 `await api.lib('xlsx')` 取，
   否则注册表预加载时会拖入全部依赖（几十 MB）。
2. 禁止直接访问 DOM / `window` / `document`（除图像类模块必须用的 `createImageBitmap`/`canvas`，
   这类模块请把 Canvas 依赖集中在一个函数里，并在 Node 测试里用 `api.env === 'node'` 跳过）。
3. 输入字节不可变；输出必须是新的 `Uint8Array`（`api.encode()` 已保证）。
4. 不吞异常：解析失败抛 `ConversionError(code, 用户可读消息)`（`src/core/errors.js`），
   引擎会把它渲染成结果卡片上的错误态。不要 `throw new Error('转换失败')` 这种无信息错误。
5. 所有输出文件名必须经过 `api.fileName('名字.txt')` 消毒（去非法字符/长度限制）。
6. 注释只写「为什么」与「坑」，不解释代码表面。
7. 选项值可能是 undefined：一律 `api.opt('timestamps', true)` 取值。

## 3. Api 参考

| 成员 | 说明 |
| --- | --- |
| `api.input` | `{ name, ext, mime, size, bytes }` |
| `api.opt(key, fallback)` | 读选项，带默认值 |
| `api.bytes()` | 输入 `Uint8Array` |
| `api.text(encoding?)` | 解码输入为字符串；缺省用自动识别结果 |
| `api.detected` | `{ encoding, confidence, candidates }` 自动识别详情 |
| `api.encode(text, encoding?)` | 文本 → `Uint8Array`（支持 utf-8/utf-8-bom/utf-16le/gbk/gb18030/big5/shift_jis/euc-kr/windows-1252） |
| `api.decode(bytes, encoding?)` | 字节 → 文本 |
| `api.lib(name)` | 懒加载第三方库（浏览器走 `/vendor`，Node 走 node_modules） |
| `api.progress(ratio, label?)` | 0~1 进度上报 |
| `api.note(level, message)` | 追加提示（level: info/warn） |
| `api.fileName(name)` | 文件名消毒 |
| `api.env` | `'browser'` 或 `'node'` |
| `api.zip(entries)` | `[{name, bytes}]` → zip 字节（返回 Uint8Array） |
| `api.unzip(bytes)` | zip → `[{name, bytes}]` |

返回值：`{ files:[{name, bytes, mime}], preview?, notes? }`，`files` 至少一个。

## 4. 测试要求

每个模块配 `tests/<module>.test.mjs`，用 `node --test`：正常路径、边界（空文件/超小/超大）、
错误路径（坏数据必须抛 ConversionError）。fixture 在 `tests/fixtures/` 里现场生成（不要提交二进制大文件）。
测中文场景时**必须**验证 `api.text()` 结果里出现预期中文子串，而不是只断言不报错。
