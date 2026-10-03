/**
 * 预加载：只向渲染层暴露「更新进度 / 安装并退出」这一小块能力，
 * 其它一律不给（转换逻辑是纯前端，不需要 Node）。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prismDesktop', {
  onUpdateStatus(callback) {
    ipcRenderer.on('update:status', (_event, payload) => callback(payload));
  },
  onUpdateProgress(callback) {
    ipcRenderer.on('update:progress', (_event, percent) => callback(percent));
  },
  onUpdateError(callback) {
    ipcRenderer.on('update:error', (_event, message) => callback(message));
  },
});
