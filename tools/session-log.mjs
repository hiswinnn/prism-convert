/**
 * 读 DSH 会话记录（多帧追加的 zstd）。
 *
 * 坑：文件是「一帧一个事件」连续追加的，Node 的 zstdDecompressSync/createZstdDecompress
 * 都只解第一帧就收工（611KB 只解出 281 字节）。所以这里自己按魔数切帧、逐帧解压，
 * 切片失败时把边界往后挪到下一个魔数再试（压缩数据里也可能偶然出现魔数）。
 */
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function findFrameOffsets(buffer) {
  const offsets = [];
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1] && buffer[i + 2] === MAGIC[2] && buffer[i + 3] === MAGIC[3]) {
      offsets.push(i);
    }
  }
  return offsets;
}

/** @returns {string} 解压后的完整文本（多帧拼接） */
export function readSessionLog(file) {
  const buffer = readFileSync(file);
  const offsets = findFrameOffsets(buffer);
  if (offsets.length === 0) return '';

  const parts = [];
  for (let i = 0; i < offsets.length; i += 1) {
    let end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length;
    let decoded = null;
    // 边界可能落在压缩数据内部（魔数是偶然出现的），往后找下一个可用边界
    for (let attempt = 0; attempt < 4 && decoded === null; attempt += 1) {
      try {
        decoded = zstdDecompressSync(buffer.subarray(offsets[i], end)).toString('utf8');
      } catch {
        const next = offsets[i + 1 + attempt + 1];
        if (next === undefined) break;
        end = next;
      }
    }
    if (decoded !== null) parts.push(decoded);
  }
  return parts.join('');
}
