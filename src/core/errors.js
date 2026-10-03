/**
 * 转换错误：把「技术失败」与「用户看到的文案」分开。
 * 引擎只认这个类型并渲染错误卡片；其它异常按程序缺陷上报。
 */
export class ConversionError extends Error {
  /**
   * @param {string} code 机器可读代码，如 'BAD_JSON'
   * @param {string} message 面向用户的中文说明（可含修复建议）
   * @param {{cause?: unknown, detail?: string}} [info]
   */
  constructor(code, message, info = {}) {
    super(message);
    this.name = 'ConversionError';
    this.code = code;
    this.detail = info.detail;
    if (info.cause !== undefined) this.cause = info.cause;
  }
}

export const fail = (code, message, info) => {
  throw new ConversionError(code, message, info);
};
