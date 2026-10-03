/**
 * 无头浏览器验收工具（零依赖，走 CDP）。
 *
 * 本机只装了 Edge，没有 Chrome；Playwright/Puppeteer 又太重，
 * 所以直接用 Node 内置的 WebSocket 接 Chrome DevTools Protocol：
 * 能真上传文件、真点按钮、真截图、真收集 console 报错——验收要的是证据，不是「应该没问题」。
 *
 * 用法：
 *   node tools/check.mjs <steps.json> [--out 目录] [--browser msedge.exe 路径] [--keep]
 *
 * steps.json 是一个数组，每步：
 *   {"type":"goto","url":"http://127.0.0.1:4780"}
 *   {"type":"wait","ms":1200}              // 或 "forSelector":".filecard"
 *   {"type":"eval","expr":"..."}           // 或 "file":"scripts/x.js"，返回值进结果
 *   {"type":"click","selector":".btn--primary"}
 *   {"type":"upload","selector":"input[type=file]","files":["fixtures/a.png"]}
 *   {"type":"screenshot","path":"shots/home.png","fullPage":true,"width":1440,"height":1000}
 * 脚本模板：expr/file 里可用 `window`、`document`，也可以 `await`（会被包进 async 函数）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const stepsPath = args.find((a) => !a.startsWith('--'));
const getFlag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1]?.startsWith('--') ? true : args[index + 1]) : fallback;
};

const steps = JSON.parse(readFileSync(stepsPath, 'utf8'));
const outDir = resolve(getFlag('out', '.tmp/check'));
mkdirSync(outDir, { recursive: true });

const DEFAULT_BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const browserPath = getFlag('browser') ?? DEFAULT_BROWSERS.find((p) => existsSync(p));
if (!browserPath) {
  console.error('找不到 Chromium 内核浏览器，请用 --browser 指定路径');
  process.exit(2);
}

const PORT = Number(getFlag('port', 9333));
const profileDir = mkdtempSync(join(tmpdir(), 'prism-cdp-'));

const child = spawn(browserPath, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-features=Translate,MediaRouter',
  '--hide-scrollbars',
  '--mute-audio',
  '--window-size=1440,1000',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      // 还没起来
    }
    await sleep(150);
  }
  throw new Error('浏览器调试端口未就绪');
}

/* ------------------------------ 极简 CDP 客户端 ------------------------------ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`)) : resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const handler of this.handlers.get(msg.method) ?? []) handler(msg.params);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 120000);
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
}

/* ------------------------------ 主流程 ------------------------------ */

const logs = [];
const results = [];
let exitCode = 0;

try {
  await waitForDevTools();
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
    logs.push({ level: type, text: args.map((a) => a.value ?? a.description ?? a.type).join(' ') });
  });
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    logs.push({
      level: 'exception',
      text: exceptionDetails.exception?.description ?? exceptionDetails.text,
    });
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error' || entry.level === 'warning') logs.push({ level: entry.level, text: `${entry.text} ${entry.url ?? ''}` });
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('DOM.enable');

  let nodeIdSeq = 0;
  const nodeIds = new Map();

  async function findNode(selector) {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`找不到元素：${selector}`);
    return nodeId;
  }

  for (const step of steps) {
    const record = { type: step.type };
    try {
      switch (step.type) {
        case 'goto': {
          await cdp.send('Page.navigate', { url: step.url });
          await sleep(step.settle ?? 700);
          record.url = step.url;
          break;
        }
        case 'wait': {
          if (step.forSelector) {
            const deadline = Date.now() + (step.timeout ?? 15000);
            for (;;) {
              const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
              const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: step.forSelector });
              if (nodeId) break;
              if (Date.now() > deadline) throw new Error(`等待超时：${step.forSelector}`);
              await sleep(200);
            }
          } else {
            await sleep(step.ms ?? 500);
          }
          break;
        }
        case 'eval': {
          const expression = step.file ? readFileSync(resolve(step.file), 'utf8') : step.expr;
          const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
            expression: `(async () => { ${expression} })()`,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          });
          if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
          record.value = result.value;
          break;
        }
        case 'click': {
          const nodeId = await findNode(step.selector);
          const { model } = await cdp.send('DOM.getBoxModel', { nodeId });
          const [x, y] = [
            (model.content[0] + model.content[2]) / 2,
            (model.content[1] + model.content[5]) / 2,
          ];
          for (const type of ['mousePressed', 'mouseReleased']) {
            await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
          }
          await sleep(step.settle ?? 250);
          break;
        }
        case 'upload': {
          const nodeId = await findNode(step.selector);
          // 唯一能真正走通 <input type=file> 的方式：让浏览器直接把文件挂上去
          await cdp.send('DOM.setFileInputFiles', {
            nodeId,
            files: step.files.map((f) => resolve(f)),
          });
          await sleep(step.settle ?? 400);
          break;
        }
        case 'screenshot': {
          const path = resolve(step.path);
          mkdirSync(dirname(path), { recursive: true });
          const params = { format: 'png', captureBeyondViewport: !!step.fullPage };
          if (step.width || step.height) {
            await cdp.send('Emulation.setDeviceMetricsOverride', {
              width: step.width ?? 1440,
              height: step.height ?? 1000,
              deviceScaleFactor: step.scale ?? 1,
              mobile: !!step.mobile,
            });
            await sleep(350);
          }
          const { data } = await cdp.send('Page.captureScreenshot', params);
          writeFileSync(path, Buffer.from(data, 'base64'));
          record.path = path;
          break;
        }
        case 'setMobile': {
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: step.width ?? 390, height: step.height ?? 844, deviceScaleFactor: 2, mobile: true,
          });
          await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
          await sleep(400);
          break;
        }
        case 'setDesktop': {
          await cdp.send('Emulation.clearDeviceMetricsOverride');
          await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: step.width ?? 1440, height: step.height ?? 1000, deviceScaleFactor: 1, mobile: false,
          });
          await sleep(400);
          break;
        }
        default:
          record.skipped = `未知步骤 ${step.type}`;
      }
    } catch (err) {
      record.error = err?.message ?? String(err);
      exitCode = 1;
    }
    results.push(record);
  }

  const errors = logs.filter((l) => l.level === 'error' || l.level === 'exception' || l.level === 'warning');
  console.log(JSON.stringify({
    ok: exitCode === 0 && errors.length === 0,
    steps: results,
    errors,
    console: logs.slice(0, 60),
  }, null, 2));
} catch (err) {
  console.error(JSON.stringify({ ok: false, fatal: err?.message ?? String(err) }, null, 2));
  exitCode = 1;
} finally {
  child.kill();
  await sleep(300);
  if (!getFlag('keep')) {
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败无所谓 */ }
  }
}

process.exit(exitCode);
