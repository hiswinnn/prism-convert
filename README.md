# 棱镜 Prism · 双端全能文件转换器

纯前端的文件转换工具：**手机与电脑共用同一套界面与同一套引擎**，所有转换在你自己的设备上完成，
没有服务器接收文件，首次加载后可离线使用。

- 界面：液态玻璃（指针高光跟随、棱镜边缘、启动升起动效、明暗主题、性能模式）
- 能力：AI 聊天记录、文档、表格、结构化数据、图片、PDF、音视频、压缩包、字幕
- 验收：Node 单测 **249 项全绿**；浏览器内自检 **21/21 通过**；无头浏览器端到端（真上传真转换）

---

## 1. 快速开始

```powershell
# 开发 / 本地预览（默认 4780 端口，同时打印局域网地址）
node server/dev-server.mjs

# 手机访问：电脑与手机连同一个 WiFi，手机浏览器打开打印出来的 http://192.168.x.x:4780
```

```powershell
# 构建发行版（纯静态，可直接丢到任意静态托管）
node scripts/build.mjs        # 产物在 dist/，约 23 MB（含 WASM 音视频引擎）

# 本地验证发行版（与线上同一份产物）
node server/dev-server.mjs --port 4781 --dir dist
```

```powershell
# 测试
node --test tests/*.test.mjs
```

## 2. 目录结构

```
src/
  index.html            入口（含 import map：把裸模块名映射到 /vendor/lib/*）
  main.js               启动、路由、全局手势（拖拽 / 粘贴 / 快捷键）
  version.js            版本号（与根目录 VERSION 保持一致）
  manifest.webmanifest  PWA 清单（可「添加到主屏幕」）
  sw.js                 Service Worker（外壳 stale-while-revalidate，引擎文件 cache-first）
  styles/               tokens.css（设计令牌）/ glass.css（玻璃组件）/ app.css（布局）
  ui/                   dom/glass/store/sheet/toast + views/{workbench,chat,matrix,settings,selftest}
  core/                 引擎与转换模块（浏览器与 Node 双端可用）
    engine.js           识别 → 挑转换器 → 构造 api → 执行 → 归一化结果
    registry.js         转换器与格式的唯一权威表（界面与引擎都读它）
    encoding.js         编码识别 / 解码 / 编码（GBK、Big5 反查表自建）
    detect.js           魔数识别（zip 容器会看内部结构区分 docx/xlsx/epub）
    text-heuristics.js  JSON/JSONL/CSV/HTML/SRT/ASS 等文本特征识别
    lib-loader.js       依赖懒加载（浏览器走 /vendor/lib，Node 走 node_modules）
    selftest.js         浏览器内实机自检（21 项）
    chat-export · document · table · data · image · pdf · archive · subtitle · media
server/dev-server.mjs   零依赖静态服务：/vendor/lib/* 镜像 node_modules + Range 支持
scripts/build.mjs       发行版构建（拷 src + 需要的第三方资源，生成指纹清单）
tools/                  验收工具：无头浏览器驱动、夹具生成、门禁探针、会话记录恢复
tests/                  Node 单测（含 release-gate.test.mjs 跨模块集成门禁）
```

### 为什么没有打包器

浏览器侧所有依赖都通过 `/vendor/lib/<与 node_modules 相同的相对路径>` 引用，
服务端把这个前缀直接镜像到 `node_modules`，因此库内部的相对 import（pdfjs 的 worker、cmaps、字体，
ffmpeg 的 esm 分块）天然可用；`src/index.html` 里再放一张 import map 兜住裸模块名。
好处是**同一份模块代码**能在浏览器里跑、也能被 `node --test` 直接加载，不需要两套构建。

## 3. 支持矩阵（✓=已实测）

| 类别 | 输入 → 输出 |
| --- | --- |
| AI 聊天记录 | ChatGPT / Claude / DeepSeek / 豆包·通义·文心·Kimi / Gemini Takeout / 通用 `[{role,content}]` / JSONL / QQ·微信文本 → TXT · Markdown · HTML · JSONL · CSV |
| 文档 | docx · txt · md · html · rtf · epub · odt → txt · md · html · docx · epub |
| 表格 | xlsx · xls · ods · csv · tsv · json → csv · tsv · xlsx · ods · json · md · html |
| 结构化数据 | json · jsonl · yaml · xml · ini · csv → json · jsonl · yaml · xml · ini · txt（树形/扁平/表格三种样式） |
| 图片 | png · jpg · webp · gif · bmp · ico · avif · heic · svg · pnm → png · jpg · webp · bmp · ico |
| PDF | pdf → txt · md · html · png · jpg；图片/文字 → pdf；合并 · 拆页 · 旋转 |
| 音视频 | mp3 · wav · ogg · flac · m4a · aac · opus · mp4 · webm · mkv · mov · avi · gif → 互转 · 提取音频 · 截帧 · 裁剪 · 压缩 |
| 压缩包 | zip · gz · tar · tgz → 解压（保留目录结构）· 清单 · 重新打包 |
| 字幕 | srt · vtt · ass · ssa → 互转 · 纯文本 · CSV（支持整体平移、GBK 输出） |

## 4. 编码不乱码是怎么做到的

1. **识别**：BOM → UTF-8 严格校验 → 无 BOM UTF-16 字节序探测 → 多候选加权评分。
   评分 = 替换字符比例、控制字符比例、高频汉字占比、CJK 占比四项归一后加权
   （只做「基础分 + 加分」再截断会让所有候选并列满分——这是踩过的坑，见 `encoding.js` 注释）。
2. **纠正**：GBK / Big5 字节常常互相「看起来像合法汉字」，识别不可能 100% 正确，
   所以界面提供**试解码对比抽屉**：把各编码的真实解码结果并排显示，点一下就用它。
3. **输出**：GBK / GB18030 / Big5 / Shift_JIS / EUC-KR 的反查表由 `TextDecoder` 一次性反向生成
   （不手工维护码表）；无法表示的字符会替换为 `?` 并在结果里明确告知数量，绝不静默丢字。

## 5. 验收证据

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| Node 单测（11 个模块 + 引擎 + 门禁） | `node --test tests/*.test.mjs` | **249 通过 / 0 失败** |
| 浏览器内自检（含 Canvas 编码、ffmpeg 真转码） | 页面「能力 → 跑一次实机自检」 | **21/21 通过** |
| 端到端（无头 Edge + CDP，真上传真下载） | `node tools/check.mjs tools/steps/dist-verify.json` | 8 种文件全部转换成功 |
| 浏览器专属路径直连引擎 | `node tools/check.mjs tools/steps/browser-probe.json` | wav→mp3、wav→flac、pdf→txt、pdf→png、bmp→jpg、bmp→webp 全通过 |

`tests/release-gate.test.mjs` 是**跨模块集成门禁**，把只有站在引擎高度才看得见的缺陷固化成断言：
注册表与模块 meta 必须一致、目标格式必须真的下发、输出名不能被去重两次、
`api.zip()` 必须同步返回字节、ffmpeg 命令必须以输出文件结尾、压缩包目录结构不能被压平、
二进制容器不能被当成文本猜编码、原地转必须落到对的模块。

## 6. 部署到固定网址

线上地址：**https://hiswinnn.github.io/prism-convert/**（源码仓库 `hiswinnn/prism-convert`）

```powershell
# 构建 + 推送到 gh-pages 并开启 Pages（需要 gh 已登录）
node scripts/deploy.mjs --repo hiswinnn/prism-convert

# 本机到 github.com 被重置时（国内常见），用 REST API 推送（走 api.github.com，实测可用）
node scripts/push-via-api.mjs --repo hiswinnn/prism-convert --branch gh-pages --dir dist
node scripts/push-via-api.mjs --repo hiswinnn/prism-convert --branch main --dir . --tracked
```

部署时踩到、且已经写进门禁测试的两个坑：

1. **vendor 资源不能用根绝对路径**：`/vendor/lib/...` 在本机（站点即在根）能跑，
   但部署到 `https://<user>.github.io/<repo>/` 会指向域名根目录而全部 404。
   现在统一由 `lib-loader.js` 的 `vendorUrl()`（基于 `import.meta.url`）解析。
2. **Service Worker 外壳必须网络优先**：早期用 stale-while-revalidate 缓存 HTML/JS，
   发布新版本后老用户仍在跑旧代码，只有「改完发布、用户再打开」才暴露。现在改网络优先、离线回落缓存。

### 音视频引擎为什么要走镜像

实测本机到各源的下载速度（同一个 30.7MB wasm）：

| 来源 | 速度 | 30MB 耗时 |
| --- | --- | --- |
| GitHub Pages（本站） | 0.03 MB/s | ≈ 17 分钟 |
| jsdelivr | 0.16 MB/s | ≈ 3 分钟 |
| unpkg | 0.36 MB/s | ≈ 85 秒 |
| **registry.npmmirror.com（tarball）** | **15.3 MB/s** | **≈ 2 秒** |

所以引擎默认从 npm 镜像的 tarball 拉取（一次请求同时得到 core.js 与 wasm，浏览器内用 fflate + 自写
tar 解析就地解开），本站 gzip 版（30.7MB → 9.8MB）与公共 CDN 依次兜底；
设置页可以填自定义镜像地址。引擎版本常量 `FFMPEG_CORE_VERSION` 与安装的依赖保持一致。

## 7. 已知限制（如实说明）

- **中文 → PDF**：纯前端没有可嵌入的中文字体，检测到中文会明确报错并建议「导出 HTML 后用浏览器打印为 PDF」。
- **AVIF 编码**：Chromium 全系不带编码器（只有 Safari 16.4+ 能编），不支持时明确报错，不静默降级成 PNG。
- **HEIC**：非 Safari 内核走 `libheif-js` 解码，个别机型照片可能失败，会提示「改用 iPhone 分享为 JPEG」。
- **TIFF** 不支持；多帧 GIF 拆帧需要浏览器 `ImageDecoder`（Chrome/Edge）。
- **超大文件**：全程内存处理，聊天记录 JSON >30MB 会截断并提示；压缩包解压前用声明大小拦截 >300MB。
- **音视频**首次使用需下载约 30MB WASM 引擎（之后走缓存），iOS 低电量模式可能限制后台解码。

## 8. 运维笔记（踩过的坑，写给未来的维护者）

1. **不要在 PowerShell 里整文件改写源码**：本机 `Get-Content | Set-Content` 会按 ANSI(CP936) 处理无 BOM 的
   UTF-8 文件，中文会被「二次编码」写坏，还会静默吞字节与换行。改源码只用编辑器工具（write/edit），查看看 `read`/`grep`。
2. **不要在共享目录用通配删除**：`Remove-Item tests\*` 这类命令曾一次删掉 10 个测试文件（含别人的）。
   如果真发生了：会话记录 `%DSH_HOME%/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd` 里存着每次
   `write`/`edit` 的完整参数，`node tools/recover-from-sessions.mjs` 可以按「write 基线 + 顺序重放 edit」把文件还原。
   注意该日志是多帧 zstd，Node 自带解压只认第一帧（`tools/session-log.mjs` 里做了切帧）。
3. **`npm install --no-save` 会剪掉上次装的包**：本仓库没有 `package.json`（会被 DSH 的写保护拦住），
   所以所有依赖必须**一次命令装完**，否则先前装好的会被移除。
4. **ffmpeg core 必须用 ESM 构建**：`@ffmpeg/ffmpeg` 0.12 的 worker 是 module worker，用 `import(coreURL)` 加载 core；
   给它 UMD 版会报 `failed to import ffmpeg-core.js`。
5. **Cloudflare Pages 单文件上限 25MB**，而 `ffmpeg-core.wasm` 是 30.74MB —— 部署时要么换 GitHub Pages，
   要么把 core 换成 CDN 或切成两片。

