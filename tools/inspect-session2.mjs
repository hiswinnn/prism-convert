import { readFileSync, createReadStream } from 'node:fs';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';
import { Readable } from 'node:stream';

const f = 'C:/Users/Sunjia/.dsh/sessions/--C-Users-Sunjia-Desktop--/ce4200f3-ce05-4b32-8e34-108378da5e40/session.v4.jsonl.zstd';
const buf = readFileSync(f);
console.log('file bytes =', buf.length);
let magic = 0;
for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === 0x28 && buf[i+1] === 0xB5 && buf[i+2] === 0x2F && buf[i+3] === 0xFD) magic++;
console.log('zstd 魔数出现次数 =', magic);
console.log('前 24 字节 =', buf.subarray(0, 24).toString('hex'));
console.log('4 字节小端前缀 =', buf.readUInt32LE(0));

async function streamAll() {
  const chunks = [];
  await new Promise((res, rej) => {
    Readable.from([buf]).pipe(createZstdDecompress())
      .on('data', (c) => chunks.push(c))
      .on('end', res).on('error', rej);
  });
  const out = Buffer.concat(chunks).toString('utf8');
  console.log('流式解压后 bytes =', out.length, 'lines =', out.split('\n').filter(Boolean).length);
  console.log('含 engine.test.mjs 的行 =', out.split('\n').filter((l) => l.includes('engine.test.mjs')).length);
  return out;
}
const out = await streamAll();
const hit = out.split('\n').find((l) => l.includes('engine.test.mjs'));
if (hit) console.log('HIT 片段:', hit.slice(0, 300));
