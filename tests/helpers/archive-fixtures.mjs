/**
 * 二进制 fixture 生成器：现场造 ZIP / TAR，不提交二进制文件（契约第 4 节要求）。
 *
 * 为什么不用 fflate.zipSync 造全部用例：它总是把非 ASCII 文件名按 UTF-8 写入并置 bit 11，
 * 而「老 Windows 工具写 GBK 名字且不置 bit 11」正是我们要测的坑；
 * 声明大小被伪造（zip 炸弹）的样本也只能自己拼字节。
 */
import { gbkEncode, utf8Encode } from './module-api-stub.mjs';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return utf8Encode(value);
  throw new TypeError('fixture 数据只接受 Uint8Array 或 string');
}

function writeU16(view, offset, value) {
  view[offset] = value & 0xff;
  view[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(view, offset, value) {
  view[offset] = value & 0xff;
  view[offset + 1] = (value >>> 8) & 0xff;
  view[offset + 2] = (value >>> 16) & 0xff;
  view[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * 生成一个「stored（不压缩）」的 ZIP。
 * @param {Array<{name?:string, nameBytes?:Uint8Array, data:Uint8Array|string,
 *   flags?:number, declaredSize?:number}>} entries
 */
export function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = entry.nameBytes ?? utf8Encode(entry.name ?? 'unnamed');
    const data = toBytes(entry.data);
    const flags = entry.flags ?? 0;
    const declared = entry.declaredSize ?? data.length;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 4, 20);
    writeU16(local, 6, flags);
    writeU16(local, 8, 0); // 0 = stored
    writeU16(local, 10, 0);
    writeU16(local, 12, 0x21); // 1980-01-01
    writeU32(local, 14, crc);
    writeU32(local, 18, data.length);
    writeU32(local, 22, declared);
    writeU16(local, 26, nameBytes.length);
    writeU16(local, 28, 0);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    writeU32(central, 0, 0x02014b50);
    writeU16(central, 4, 20);
    writeU16(central, 6, 20);
    writeU16(central, 8, flags);
    writeU16(central, 10, 0);
    writeU16(central, 12, 0);
    writeU16(central, 14, 0x21);
    writeU32(central, 16, crc);
    writeU32(central, 20, data.length);
    writeU32(central, 24, declared);
    writeU16(central, 28, nameBytes.length);
    writeU32(central, 42, offset);
    central.set(nameBytes, 46);

    localChunks.push(local, data);
    centralChunks.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = new Uint8Array(22);
  writeU32(eocd, 0, 0x06054b50);
  writeU16(eocd, 8, entries.length);
  writeU16(eocd, 10, entries.length);
  writeU32(eocd, 12, centralSize);
  writeU32(eocd, 16, offset);

  return concat([...localChunks, ...centralChunks, eocd]);
}

/** GBK 文件名 + 不置 bit 11：模拟老 Windows 压缩工具 */
export function buildGbkNameZip(fileName, data) {
  return buildZip([{ nameBytes: gbkEncode(fileName), data, flags: 0 }]);
}

function writeOctal(block, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0');
  for (let i = 0; i < length - 1; i += 1) block[offset + i] = text.charCodeAt(i);
  block[offset + length - 1] = 0;
}

/** 生成 ustar 格式的 TAR（名字超过 100 字节时自动拆到 prefix 字段） */
export function buildTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const nameBytes = entry.nameBytes ?? utf8Encode(entry.name ?? 'unnamed');
    const data = toBytes(entry.data);
    const header = new Uint8Array(512);

    let name = nameBytes;
    let prefix = new Uint8Array(0);
    if (nameBytes.length > 100) {
      const cut = nameBytes.lastIndexOf(0x2f);
      if (cut <= 0 || cut > 155) throw new Error('fixture 名字太长，超出 ustar 表达能力');
      prefix = nameBytes.subarray(0, cut);
      name = nameBytes.subarray(cut + 1);
    }
    header.set(name.subarray(0, 100), 0);
    header.set(prefix.subarray(0, 155), 345);

    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.length);
    writeOctal(header, 136, 12, entry.mtime ?? 1700000000);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    for (let i = 148; i < 156; i += 1) header[i] = 0x20;
    header.set(utf8Encode('ustar'), 257);
    header[263] = 0x30;
    header[264] = 0x30;

    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeOctal(header, 148, 7, checksum);
    header[154] = 0;
    header[155] = 0x20;

    chunks.push(header);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data, 0);
    chunks.push(padded);
  }
  chunks.push(new Uint8Array(1024)); // 结束块
  return concat(chunks);
}
