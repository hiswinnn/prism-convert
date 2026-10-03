# Prism 棱镜 · QA 实测记录

记录人：QA（会话 ce4200f3-ce05-4b32-8e34-108378da5e40）
复现命令：`node --test tests/engine.test.mjs tests/selftest.test.mjs`（工作目录 `E:\Projects\PrismConvert`）
格式：`- [模块] 输入 → 现象 → 期望`

## 未修复（截至最后一次运行）

- [engine] 空文件 → `convertFile({target:'txt'})` → `NO_CONVERTER：暂不支持 BIN 文件 这类文件`，文案没说明「文件是空的」，`formatLabel('bin')` 还把未识别类型显示成「BIN 文件」→ 期望空文件给出专门提示（如 `EMPTY_FILE：文件是空的，没有可转换的内容`）。属体验问题，引擎有中文错误、不会崩，因此未作为失败用例。

## 已修复（QA 复现过缺陷、随后由模块作者修好，已回归通过）

- [pdf] PDF → TXT → 曾报 `CONVERT_FAILED：未登记的库：pdfjs-dist/legacy/build/pdf.mjs`（pdf.js 取了 lib-loader 没登记的库名）→ 现已能抽出文字（`PrismConvert Hello World 12345`）。
- [registry/engine] `txt` → `txt`（GBK txt 转 UTF-8 / UTF-8 txt 转 GBK）→ 曾由 PDF 模块抢单并抛硬错误 `PDF_MODE_UNSUPPORTED：无法自动判断怎么把 .txt 转成 .txt`（`findCandidates` 把 from/to 独立求交，PDF 模块 from/to 都含 txt），document 模块永远轮不到 → 现已正确落在 document。
- [detect] 真实 docx/xlsx（`docx`/`xlsx` 库生成）→ 曾被识别成 `zip`（MAGIC 表的 `PK\x03\x04` 先于 `inspectZip()` 命中，docx/xlsx/pptx/epub 分支不可达）→ 现已识别为 docx/xlsx，DOCX→MD、XLSX→CSV 可用。
- [engine] `convertFile({target:'yaml'})` → 曾静默产出 `config.txt`（`buildApi` 没把目标格式下发给模块，各模块退回自己的默认目标）；6/6 最小作业都产出错误格式且不报错 → 现已正确下发。
- [engine] 所有单文件产出 → 曾一律带 `-1` 后缀（`api.fileName()` 已把名字写进 `takenNames`，`convertFile` 又用同一集合做一次 `uniqueFileName`）→ 现已正常。
- [encoding] Big5 / Shift_JIS / EUC-KR 文本 → 曾一律识别为 `gb18030` 且置信度 1.0（`scoreCandidate` 的分数被 clamp 到 1.0，全部候选并列，按数组顺序取到 gb18030），预览是乱码 `羉砰いゅ代刚…` → 现已正确识别为 big5。
- [image] BMP → PNG → 曾产出缺 8 字节签名、块长度与 IHDR 用小端书写的伪 PNG（`0d 00 00 00 49 48 44 52 07 00 00 00…`）→ 现已产出标准 PNG（签名 + 大端 IHDR）。
- [document] DOCX → MD → 曾报 `DOCX_CORRUPT`（同期该文件正处于编辑中）→ 现已能正确抽出中文标题与段落。
- [subtitle] SRT → VTT → 曾原样返回 SRT 文本（目标格式没下发）→ 现已输出 WebVTT 与点号毫秒时间轴。
- [archive] ZIP 解压 → 曾产出 `中文文件名-1-1.txt`（模块自身去重 + 引擎重复登记叠加）→ 现已正常。

## 当前回归状态（最后运行：`node --test tests/engine.test.mjs tests/selftest.test.mjs`）

- engine.test.mjs：20 个测试全通过（含 5 个诊断用例）
- selftest.test.mjs：3 个测试全通过；`runSelfTest()` → 通过 19 / 失败 0 / 跳过 2（浏览器专属项在 Node 下按设计跳过）

## 尚无法在 Node 验证的部分

- 图片 canvas 编码路径（BMP→JPEG/WebP/AVIF）：Node 下 image.js 明确抛 `IMAGE_ENCODER_CANVAS_REQUIRED`，属预期；网页自检中该项标 skip。
- 音视频真实转码（media 模块）：需要浏览器 + ffmpeg wasm；Node 下未做真实验证，自检中仅探测「@ffmpeg/ffmpeg 能否加载」。
- UI 层（src/ui/**）与 dev-server 静态资源映射未验证。
