/** 版本与构建信息：settings 页展示，发布时与根目录 VERSION 保持一致 */
export const VERSION = '1.2.0';

const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;

export const BUILD_INFO = {
  env: typeof window !== 'undefined' ? '浏览器' : 'Node',
  cores,
  memory: (typeof navigator !== 'undefined' && navigator.deviceMemory) ? `${navigator.deviceMemory} GB` : '未上报',
};
