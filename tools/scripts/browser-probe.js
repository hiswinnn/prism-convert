/**
 * 浏览器内直连引擎的探测脚本（由 tools/check.mjs 的 eval 步骤执行）。
 * 目的是拿到 ConversionError 的完整 detail（界面只显示一行消息，ffmpeg 的日志尾巴看不到）。
 */
const { convertFile } = await import('/core/engine.js');
const { loadLib } = await import('/core/lib-loader.js');

const results = [];

function makeWav(seconds = 1, sampleRate = 16000) {
  const samples = seconds * sampleRate;
  const data = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
    data[i * 2] = value & 0xff;
    data[i * 2 + 1] = (value >> 8) & 0xff;
  }
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const put = (offset, text) => { for (let i = 0; i < text.length; i += 1) header[offset + i] = text.charCodeAt(i); };
  put(0, 'RIFF'); view.setUint32(4, 36 + data.length, true); put(8, 'WAVE'); put(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, 'data'); view.setUint32(40, data.length, true);
  const out = new Uint8Array(44 + data.length);
  out.set(header); out.set(data, 44);
  return out;
}

async function makePdf() {
  const { PDFDocument, StandardFonts, rgb } = await loadLib('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const text of ['BROWSER PDF PAGE ONE', 'BROWSER PDF PAGE TWO']) {
    const page = doc.addPage([420, 300]);
    page.drawText(text, { x: 40, y: 180, size: 24, font, color: rgb(0.1, 0.2, 0.6) });
  }
  return new Uint8Array(await doc.save());
}

async function probe(label, name, bytes, target, options = {}) {
  const started = Date.now();
  try {
    const result = await convertFile({ name, bytes }, { target, options });
    results.push({
      label,
      ok: true,
      ms: Date.now() - started,
      converter: result.converterId,
      files: result.files.map((f) => ({ name: f.name, size: f.size, mime: f.mime, head: Array.from(f.bytes.slice(0, 8)) })),
      notes: result.notes.map((n) => `${n.level}: ${n.message}`).slice(0, 4),
    });
  } catch (err) {
    results.push({
      label,
      ok: false,
      ms: Date.now() - started,
      code: err?.code,
      message: err?.message,
      detail: typeof err?.detail === 'string' ? err.detail.slice(-1200) : err?.detail,
    });
  }
}

// 1) 音频：WAV → MP3（ffmpeg 真实转码）
await probe('wav→mp3', '音调.wav', makeWav(), 'mp3');
// 2) 音频：WAV → WAV（排除编码器因素，只验证 ffmpeg 能否跑起来）
await probe('wav→flac', '音调.wav', makeWav(), 'flac');

// 3) PDF：生成后取文字 / 渲染成图片
let pdfBytes = null;
try {
  pdfBytes = await makePdf();
} catch (err) {
  results.push({ label: 'makePdf', ok: false, message: err?.message });
}
if (pdfBytes) {
  await probe('pdf→txt', '样张.pdf', pdfBytes, 'txt');
  await probe('pdf→png(render)', '样张.pdf', pdfBytes, 'png', { pdfMode: 'render', renderScale: 2 });
}

// 4) 图片：BMP → JPG（Canvas 编码路径）
const bmp = (() => {
  const width = 16; const height = 8;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixels = new Uint8Array(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = y * rowSize + x * 3;
      pixels[o] = Math.round((x / (width - 1)) * 255);
      pixels[o + 1] = Math.round((y / (height - 1)) * 255);
      pixels[o + 2] = 200;
    }
  }
  const header = new Uint8Array(54);
  const view = new DataView(header.buffer);
  header[0] = 0x42; header[1] = 0x4d;
  view.setUint32(2, 54 + pixels.length, true); view.setUint32(10, 54, true); view.setUint32(14, 40, true);
  view.setInt32(18, width, true); view.setInt32(22, height, true);
  view.setUint16(26, 1, true); view.setUint16(28, 24, true); view.setUint32(34, pixels.length, true);
  const out = new Uint8Array(54 + pixels.length);
  out.set(header); out.set(pixels, 54);
  return out;
})();
await probe('bmp→jpg', '色块.bmp', bmp, 'jpg');
await probe('bmp→webp', '色块.bmp', bmp, 'webp');

return {
  capabilities: {
    offscreen: typeof OffscreenCanvas,
    createImageBitmap: typeof createImageBitmap,
    imageDecoder: typeof ImageDecoder,
    webAssembly: typeof WebAssembly,
    crossOriginIsolated: self.crossOriginIsolated,
  },
  results,
};
