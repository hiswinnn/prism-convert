/**
 * 棱镜 Prism 桌面版 · Electron 主进程
 *
 * 设计：转换逻辑仍是 100% 纯前端（dist/ 里的 HTML/CSS/JS 原样搬进来），
 * Electron 只做三件事——提供窗口、把 dist/ 挂成一个本地自定义协议（prism://）、
 * 以及开机检查版本更新。因此 web 版与桌面版共享同一份引擎代码。
 */
// 最顶部的引导日志：不依赖 electron，用于判断「main.js 到底有没有被执行」
try {
  require('fs').appendFileSync(
    require('path').join(require('os').tmpdir(), 'prism-boot.log'),
    `[${new Date().toISOString()}] main.js entered, argv=${JSON.stringify(process.argv.slice(1))}, cwd=${process.cwd()}\n`,
  );
} catch { /* 引导日志失败也不影响 */ }

let app;
let BrowserWindow;
let protocol;
let dialog;
let shell;
try {
  ({ app, BrowserWindow, protocol, dialog, shell } = require('electron'));
} catch (err) {
  try { require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'prism-boot.log'), `[REQUIRE-ELECTRON-FAILED] ${err?.stack ?? err}\n`); } catch {}
  throw err;
}
const path = require('path');
const fs = require('fs');

// 启动诊断：GUI 程序崩溃不打印到控制台，这里落一个日志文件，出问题能一眼看到
const LOG = path.join(require('os').tmpdir(), 'prism-desktop.log');
function bootlog(...args) {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`);
  } catch { /* 日志写不了也不影响启动 */ }
}
process.on('uncaughtException', (err) => {
  bootlog('UNCAUGHT', err?.stack ?? err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  bootlog('UNHANDLED_REJECTION', reason?.stack ?? reason);
});
bootlog('main loaded, packaged=', app?.isPackaged, 'electron=', process.versions?.electron, 'node=', process.versions?.node, 'type=' + (require('electron') === app ? 'builtin' : '??'));

// 注意：不要在这里直接 `const { autoUpdater } = require('electron-updater')`。
// electron-updater 的 autoUpdater 是个惰性 getter，被解构访问的瞬间就会 new AppUpdater，
// 而它要读 app.getVersion()——在 app ready 之前、或 electron 版本 API 对不上时，
// 这里会直接抛 "Cannot read properties of undefined (reading 'getVersion')" 把应用搞崩。
// 所以更新器放到 app.whenReady() 之后才懒加载。
let autoUpdater = null;
function getAutoUpdater() {
  if (!autoUpdater) autoUpdater = require('electron-updater').autoUpdater;
  return autoUpdater;
}

// 打包后 dist 放在 extraResources（resources/dist）；开发时指向仓库里的 dist
const DIST = app.isPackaged
  ? path.join(process.resourcesPath, 'dist')
  : path.join(__dirname, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.gz': 'application/gzip',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function mimeOf(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// 必须在 app ready 之前声明，prism:// 才能被当作「标准 + 安全」源，
// 这样 ES 模块、动态 import、fetch 都能在自定义协议上工作（file:// 是不行的）。
protocol.registerSchemesAsPrivileged([
  { scheme: 'prism', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// 调试开关在代码里追加，而不是依赖命令行 flag（打包后的 exe 对命令行 flag 的透传并不可靠）
if (process.env.PRISM_DEBUG === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.PRISM_DEBUG_PORT ?? '9444');
}

function serveDist(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel = `${rel}index.html`;
  const filePath = path.normalize(path.join(DIST, rel));
  if (!filePath.startsWith(path.normalize(DIST))) return new Response('forbidden', { status: 403 });
  try {
    const data = fs.readFileSync(filePath);
    return new Response(data, { headers: { 'content-type': mimeOf(filePath), 'cache-control': 'no-cache' } });
  } catch {
    return new Response('404', { status: 404 });
  }
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 620,
    title: '棱镜 Prism',
    backgroundColor: '#04050b',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // 外链一律交给系统默认浏览器，不新开 Electron 窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.loadURL('prism://app/index.html');
  return mainWindow;
}

function setupAutoUpdate() {
  const send = (channel, payload) => mainWindow?.webContents.send(channel, payload);
  let updater;
  try {
    updater = getAutoUpdater();
  } catch (err) {
    // 更新能力是加分项，绝不能让「更新器初始化失败」把整个应用带崩
    console.error('[updater] init failed:', err);
    return;
  }
  const { autoUpdater } = require('electron-updater');

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => send('update:status', 'checking'));
  autoUpdater.on('update-available', (info) => send('update:status', { state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => send('update:status', 'uptodate'));
  autoUpdater.on('download-progress', (p) => send('update:progress', Math.round(p.percent)));
  autoUpdater.on('update-downloaded', (info) => {
    send('update:status', { state: 'downloaded', version: info.version });
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'info',
      title: '发现新版本',
      message: `棱镜 Prism ${info.version} 已下载完成`,
      detail: '重启即可完成更新（会短暂退出再打开）。',
      buttons: ['立即重启更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (err) => send('update:error', String(err?.message ?? err)));

  setTimeout(() => {
    // 开发模式默认禁用更新检查；本地联调时用环境变量强制
    if (!app.isPackaged && process.env.PRISM_FORCE_UPDATE !== '1') return;
    autoUpdater.checkForUpdates().catch(() => {});
  }, 4000);
}

app.whenReady().then(() => {
  bootlog('app ready, registering protocol');
  protocol.handle('prism', serveDist);
  createWindow();
  setupAutoUpdate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((err) => bootlog('app.whenReady FAILED', err?.stack ?? err));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 桌面版没有「多标签」概念，Ctrl+W 不应关掉整个应用——交给前端处理
app.on('web-contents-created', (_event, contents) => {
  contents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') contents.toggleDevTools();
  });
});
