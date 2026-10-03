/**
 * 压缩/解压的统一入口：全项目只在这里碰 fflate，方便以后换成别的实现或多线程方案。
 */
import { loadLib } from './lib-loader.js';
import { toBytes } from './util.js';

/**
 * @param {Array<{name:string, bytes:Uint8Array}>} entries
 * @returns {Promise<Uint8Array>}
 */
export async function zipBytes(entries) {
  const { zipSync } = await loadLib('fflate');
  const payload = {};
  for (const entry of entries) payload[entry.name] = toBytes(entry.bytes);
  return zipSync(payload, { level: 6 });
}

/**
 * @param {Uint8Array} bytes
 * @param {(name:string, size:number)=>boolean} [filter]
 * @returns {Promise<Array<{name:string, bytes:Uint8Array}>>}
 */
export async function unzipBytes(bytes, filter) {
  const { unzipSync } = await loadLib('fflate');
  const data = toBytes(bytes);
  const files = unzipSync(data, filter ? { filter: (file) => filter(file.name, file.size ?? 0) } : undefined);
  return Object.entries(files)
    .filter(([name]) => !name.endsWith('/'))
    .map(([name, content]) => ({ name, bytes: content }));
}

export async function gunzip(bytes) {
  const { gunzipSync } = await loadLib('fflate');
  return gunzipSync(toBytes(bytes));
}

export async function gzip(bytes) {
  const { gzipSync } = await loadLib('fflate');
  return gzipSync(toBytes(bytes), { level: 6 });
}
