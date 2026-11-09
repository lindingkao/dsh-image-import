# dsh-image-import

给 DeepSeek Harness 的输入框加更多图片格式：**BMP / TIFF / TGA / PCX / Netpbm / ICO / AVIF / SVG / HEIC / JPEG 2000 / PSD** 等，拖放、粘贴、点按钮选文件三条路都能用。

## 它解决的问题

Harness 的附件通道只认四种格式。浏览器侧的白名单在 `dsh-client-ui-conversation` 里是硬编码的：

```js
function imageMediaType(value) {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif') return value
  throw new UnsupportedImageMediaTypeError(value)
}
```

所以拖进一个 `.tif` 只会得到一条「不支持的图片格式」提示；而且浏览器端没有文件选择器，只能粘贴或拖放。

这个插件不改宿主代码，而是在它前面加一道闸：**在 DOM 捕获阶段拦下白名单外的图片，自己解成像素、重编成 PNG/JPEG，再合成一次拖放事件交回原生通道**。对 Harness 来说，收到的始终是它本来就认识的文件。

## 支持的格式

| 格式 | 解码方式 |
| --- | --- |
| TIFF（未压缩 / LZW / PackBits / Deflate，1–16 位，灰度 / 调色板 / RGB / RGBA，含 Predictor 2） | 插件自带解码器 |
| TGA（未压缩 / RLE，8/15/16/24/32 位，调色板与灰度） | 插件自带解码器 |
| PCX（8 位 1/3/4 平面、1 位多平面） | 插件自带解码器 |
| Netpbm（P1–P6，ASCII 与二进制） | 插件自带解码器 |
| BMP / ICO / AVIF / SVG / JPEG 2000 | 浏览器 `createImageBitmap` / `<img>` |
| HEIC / HEIF / PSD / RAW | 取决于当前浏览器是否内置解码器；解不了会明确提示 |

输出统一是 PNG；无 alpha 且体积超过 4 MB 时自动改用 JPEG（质量 0.92）。单边超过 4096 px 会等比缩小，避免撞上宿主的像素上限。

## 安装

从 GitHub 安装（推荐）：

```bash
dsh plugin --profile <profile> add github:lindingkao/dsh-image-import
```

从本地目录安装（开发用）：

```bash
dsh plugin --profile <profile> add /path/to/dsh-image-import
```

也可以在 Harness 的插件管理器里从本目录安装（`install_bundle`，目标指向本目录）。

插件只改了浏览器侧，所以装完后刷新页面生效。

## 用法

1. **拖放**：把图片直接拖进输入框。
2. **粘贴**：在支持粘贴文件的系统里 `Ctrl+V`。
3. **点按钮**：输入框左下角工具条里多出来的图片按钮，可以一次选多张。

转换完成后底部会提示「已转换 N 张图片为 PNG」。

## 原理与实现要点

- **捕获阶段拦截**：`dsh-client-ui-attachment` 的 drop 监听器挂在 `document` 的冒泡阶段，插件挂在捕获阶段，一定是先手。
- **重派而非注入**：`new DataTransfer()` 装入转码后的 `File`，`new DragEvent('drop', { dataTransfer })` 派给 `[data-composer-card]`。不走内部 API，因为 composer 的 `addImages` 只注入到 `conversation.composer.bar` 这一层，子座位拿不到。
- **防自触发**：重派的事件带 `__dshImageImportRerouted` 标记，监听器看到就放行，不会二次转换。
- **零构建依赖**：`client.js` 由 `tools/build.mjs` 把 `src/codec.js` 与 `src/bridge.js` 去掉模块语法后内联生成——Harness 的 web bundle 是普通脚本，不能出现 `import`/`export`。

## 开发

```powershell
npm run build     # src/ → client.js
npm test          # 解码器回归 + 桥接端到端
npm run fixtures  # 用 Pillow 重新生成测试样本（需要 python + pillow）
```

`test/codec.test.mjs` 逐像素比对 Pillow 解出的 RGBA；`test/bridge.test.mjs` 用一套极简假 DOM 跑「拦截 → 转码 → 重派」的完整控制流，包括防死循环与混合批次透传。

## 已知限制

- 插件工作在浏览器里，所以能用哪些格式最终受浏览器解码能力约束；TIFF/TGA/PCX/Netpbm 由插件自己解，不依赖浏览器。
- 一次最多转换 8 张。
- 转换是有损的边界：输出是 PNG（无损）或 JPEG（有损）。若原图是 CMYK TIFF，颜色会按插件内的 RGB 近似处理。

## 许可

MIT
