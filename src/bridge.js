/**
 * 浏览器侧的图片导入桥。
 *
 * DSH 的附件通道只认 png / jpeg / webp / gif：`imageMediaType()` 对别的 MIME 直接
 * 抛 `UnsupportedImageMediaTypeError`，粘贴和拖放又都没有文件选择器。所以这里的
 * 打法不是改 intake，而是在它前面加一道闸：
 *
 *   捕获阶段的 paste / drop
 *     → 挑出浏览器白名单之外、但确实是图片的文件
 *     → 自己解成像素，重编成 PNG/JPEG
 *     → 用 DataTransfer 合成一个 drop 事件派回 composer
 *     → DSH 原生 handler 收到的是它本来就认识的 PNG/JPEG
 *
 * 解码优先级：本项目自带的 TIFF/TGA/PCX/Netpbm 解码器 → createImageBitmap
 * （BMP/ICO/AVIF/SVG 等浏览器自己能解的）→ <img> + canvas 兜底。
 */

import { decodeImageBuffer, sniffFormat } from './codec.js'

/** DSH 附件通道原样接受的媒体类型。 */
const NATIVE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 扩展名 → 本项目解码器的格式名。 */
const EXTENSION_FORMATS = {
  tif: 'tiff',
  tiff: 'tiff',
  tga: 'tga',
  targa: 'tga',
  pcx: 'pcx',
  ppm: 'netpbm',
  pgm: 'netpbm',
  pbm: 'netpbm',
  pnm: 'netpbm',
}

/** 没有可靠 MIME 时靠扩展名判断「这可能是张图」。 */
const IMAGE_EXTENSIONS = new Set([
  'bmp', 'dib', 'tif', 'tiff', 'tga', 'targa', 'pcx', 'ppm', 'pgm', 'pbm', 'pnm',
  'ico', 'cur', 'icns', 'avif', 'svg', 'svgz', 'heic', 'heif', 'jfif', 'jp2',
  'j2k', 'psd', 'raw', 'cr2', 'nef', 'arw', 'dng', 'apng', 'jxl',
])

/** 这些格式基本不带 alpha，转码时优先 JPEG 以免体积失控。 */
const OPAQUE_EXTENSIONS = new Set(['bmp', 'dib', 'jfif', 'jp2', 'j2k', 'psd'])

/** 单边上限：超过就等比缩小，避免撞上宿主的像素上限。 */
const MAX_EDGE = 4096

/** 单次最多处理几张，超出的交给用户重来。 */
const MAX_FILES = 8

/** PNG 超过这个体积且没有 alpha 时，改用 JPEG。 */
const PNG_BUDGET = 4 * 1024 * 1024

/** 合成事件的标记：我们自己的重派事件不再被拦截。 */
const BRIDGE_FLAG = '__dshImageImportRerouted'

const STYLE_ID = 'dsh-image-import-style'
const TRIGGER_ATTR = 'data-dsh-image-import-trigger'
const INPUT_ATTR = 'data-dsh-image-import-input'

const STYLE_TEXT = `
.dsh-image-import-trigger {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--dsh-color-text-secondary, #6b7280);
  cursor: pointer;
  display: inline-flex;
  height: 28px;
  justify-content: center;
  padding: 0;
  width: 28px;
}
.dsh-image-import-trigger:hover {
  background: var(--dsh-color-fill-secondary, rgba(127, 127, 127, 0.14));
  color: var(--dsh-color-text-primary, #111827);
}
.dsh-image-import-trigger svg { height: 16px; width: 16px; }
.dsh-image-import-toast {
  background: var(--dsh-color-bg-elevated, #1f2430);
  border-radius: 8px;
  bottom: 96px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
  color: var(--dsh-color-text-primary, #f4f4f5);
  font-size: 12px;
  left: 50%;
  max-width: 420px;
  opacity: 0;
  padding: 8px 14px;
  pointer-events: none;
  position: fixed;
  transform: translate(-50%, 6px);
  transition: opacity 160ms ease, transform 160ms ease;
  z-index: 2147483000;
}
.dsh-image-import-toast[data-shown="true"] { opacity: 1; transform: translate(-50%, 0); }
`

/**
 * 取小写扩展名（不含点）。
 * @param {string} name - 文件名。
 * @returns {string} 扩展名，没有则空串。
 */
function extensionOf(name) {
  const text = typeof name === 'string' ? name : ''
  const dot = text.lastIndexOf('.')
  return dot < 0 ? '' : text.slice(dot + 1).toLowerCase()
}

/**
 * 判断一个文件是不是「浏览器解不了、但我们应该接」的图片。
 * @param {File} file - 来自 drop / paste 的文件。
 * @returns {boolean} 需要转码则为 true。
 */
function needsConversion(file) {
  const type = (file.type || '').toLowerCase()
  if (NATIVE_MEDIA_TYPES.has(type)) return false
  if (type.startsWith('image/')) return true
  // Windows 上很多位图（.bmp/.tif/.tga）的 type 是空串。
  return IMAGE_EXTENSIONS.has(extensionOf(file.name))
}

/**
 * 从 paste 事件里收集文件。
 * @param {ClipboardEvent} event - 粘贴事件。
 * @returns {File[]} 文件列表。
 */
function filesFromClipboard(event) {
  const data = event.clipboardData
  if (!data) return []
  /** @type {File[]} */
  const fromItems = []
  if (data.items) {
    for (const item of data.items) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) fromItems.push(file)
    }
  }
  if (fromItems.length > 0) return fromItems
  return data.files ? Array.from(data.files) : []
}

/**
 * 把 File 读成字节。
 * @param {File} file - 文件。
 * @returns {Promise<Uint8Array>} 文件字节。
 */
async function readBytes(file) {
  return new Uint8Array(await file.arrayBuffer())
}

/**
 * 选解码器：先按魔数嗅探，再退回扩展名。
 * @param {Uint8Array} bytes - 文件字节。
 * @param {string} name - 文件名。
 * @returns {'tiff'|'tga'|'pcx'|'netpbm'|null} 本项目解码器能处理的格式。
 */
function pickFormat(bytes, name) {
  const sniffed = sniffFormat(bytes)
  if (sniffed !== null) return sniffed
  const byExtension = EXTENSION_FORMATS[extensionOf(name)]
  return byExtension === undefined ? null : byExtension
}

/**
 * 建一个画布并铺上 RGBA 像素。
 * @param {number} width - 宽。
 * @param {number} height - 高。
 * @param {Uint8ClampedArray} data - RGBA 像素。
 * @returns {HTMLCanvasElement} 画布。
 */
function canvasFromPixels(width, height, data) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('canvas 2d context unavailable')
  const image = context.createImageData(width, height)
  image.data.set(data)
  context.putImageData(image, 0, 0)
  return canvas
}

/**
 * 建一个画布并画上一个可绘制对象。
 * @param {number} width - 宽。
 * @param {number} height - 高。
 * @param {CanvasImageSource} source - 位图或图片元素。
 * @returns {HTMLCanvasElement} 画布。
 */
function canvasFromSource(width, height, source) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('canvas 2d context unavailable')
  context.drawImage(source, 0, 0)
  return canvas
}

/**
 * 用 <img> 解码一段字节（SVG 等只认标签的格式靠这条路）。
 * @param {Blob} blob - 图片数据。
 * @returns {Promise<HTMLImageElement>} 已解码的图片。
 */
function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image element could not decode the file'))
    }
    image.src = url
  })
}

/**
 * 把一段字节栅格化成画布。
 * @param {Uint8Array} bytes - 文件字节。
 * @param {File} file - 原始文件（提供 MIME 与名字）。
 * @returns {Promise<{canvas: HTMLCanvasElement, alpha: boolean}>} 画布与 alpha 信息。
 */
async function rasterize(bytes, file) {
  const format = pickFormat(bytes, file.name)
  if (format !== null) {
    const decoded = await decodeImageBuffer(bytes, format)
    return { canvas: canvasFromPixels(decoded.width, decoded.height, decoded.data), alpha: hasAlpha(decoded.data) }
  }
  const blob = new Blob([bytes], { type: file.type || 'application/octet-stream' })
  try {
    const bitmap = await createImageBitmap(blob)
    const canvas = canvasFromSource(bitmap.width, bitmap.height, bitmap)
    if (typeof bitmap.close === 'function') bitmap.close()
    return { canvas, alpha: true }
  } catch {
    const image = await loadImageElement(blob)
    return {
      canvas: canvasFromSource(image.naturalWidth || image.width, image.naturalHeight || image.height, image),
      alpha: true,
    }
  }
}

/**
 * 采样判断像素里有没有真正的透明。
 * @param {Uint8ClampedArray} data - RGBA 像素。
 * @returns {boolean} 存在 alpha < 255 的像素则为 true。
 */
function hasAlpha(data) {
  const pixels = data.length / 4
  const step = Math.max(1, Math.floor(pixels / 4096))
  for (let index = 0; index < pixels; index += step) {
    if (data[index * 4 + 3] < 255) return true
  }
  return false
}

/**
 * 等比缩小到单边上限之内。
 * @param {HTMLCanvasElement} canvas - 原画布。
 * @param {number} limit - 单边上限。
 * @returns {HTMLCanvasElement} 原画布或缩小后的新画布。
 */
function limitEdge(canvas, limit) {
  const longest = Math.max(canvas.width, canvas.height)
  if (longest <= limit) return canvas
  const scale = limit / longest
  const target = canvasFromSource(canvas.width * scale, canvas.height * scale, canvas)
  const context = target.getContext('2d')
  if (context) context.imageSmoothingQuality = 'high'
  return target
}

/**
 * 画布 → Blob。
 * @param {HTMLCanvasElement} canvas - 画布。
 * @param {string} type - MIME。
 * @param {number} [quality] - 有损质量。
 * @returns {Promise<Blob>} 编码结果。
 */
function encodeCanvas(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error(`could not encode ${type}`))
    }, type, quality)
  })
}

/**
 * 把画布重编成 DSH 认的图片，并包成新的 File。
 * @param {HTMLCanvasElement} canvas - 画布。
 * @param {boolean} alpha - 是否需要保留透明。
 * @param {string} name - 原名，用于派生新文件名。
 * @returns {Promise<{file: File, scaled: boolean}>} 转换结果。
 */
async function repack(canvas, alpha, name) {
  const limited = limitEdge(canvas, MAX_EDGE)
  const scaled = limited !== canvas
  let type = 'image/png'
  let blob = await encodeCanvas(limited, type, 1)
  if (!alpha && blob.size > PNG_BUDGET) {
    type = 'image/jpeg'
    blob = await encodeCanvas(limited, type, 0.92)
  }
  const base = (typeof name === 'string' && name.length > 0 ? name : 'image').replace(/\.[^./\\]*$/, '')
  const suffix = type === 'image/png' ? 'png' : 'jpg'
  return {
    file: new File([blob], `${base || 'image'}.${suffix}`, { type, lastModified: Date.now() }),
    scaled,
  }
}

/**
 * 转一张图。
 * @param {File} file - 原始文件。
 * @returns {Promise<{file: File, scaled: boolean}>} 转换后的 File。
 */
async function convertOne(file) {
  const bytes = await readBytes(file)
  const { canvas, alpha } = await rasterize(bytes, file)
  const opaque = OPAQUE_EXTENSIONS.has(extensionOf(file.name)) ? false : alpha
  return await repack(canvas, opaque, file.name)
}

const toasts = []

/**
 * 在页面底部弹一条自建提示（不依赖宿主的 toast API）。
 * @param {string} message - 文案。
 * @param {number} [duration] - 停留毫秒。
 */
function notify(message, duration = 2600) {
  const node = document.createElement('div')
  node.className = 'dsh-image-import-toast'
  node.textContent = message
  ;(document.body || document.documentElement).appendChild(node)
  // 强制一次布局，让过渡动画真的跑起来。
  void node.offsetWidth
  node.dataset.shown = 'true'
  toasts.push(node)
  setTimeout(() => {
    node.dataset.shown = 'false'
    setTimeout(() => node.remove(), 240)
    const index = toasts.indexOf(node)
    if (index >= 0) toasts.splice(index, 1)
  }, duration)
}

/**
 * 合成一次 drop 派回 composer，让 DSH 原生附件通道接手。
 * @param {File[]} files - 已经是 PNG/JPEG 的文件。
 * @returns {boolean} 是否成功派发。
 */
function rerouteAsDrop(files) {
  if (files.length === 0) return false
  const card = document.querySelector('[data-composer-card]')
  if (!card) return false
  const data = new DataTransfer()
  for (const file of files) data.items.add(file)
  const event = new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    composed: true,
    dataTransfer: data,
  })
  event[BRIDGE_FLAG] = true
  card.dispatchEvent(event)
  return true
}

/**
 * 共用的异步流程：转码 → 派回。
 * @param {File[]} incoming - 事件里拿到的文件。
 * @param {Event} event - 原始事件（需要时同步阻止默认行为）。
 * @param {string} source - 用于提示的来源描述。
 */
function handleIncoming(incoming, event, source) {
  const convertible = incoming.filter(needsConversion)
  if (convertible.length === 0) return

  const passthrough = incoming.filter((file) => !needsConversion(file))
  if (incoming.length > MAX_FILES) {
    notify(`一次最多转换 ${MAX_FILES} 张图片`)
    return
  }

  // 必须在事件回调的同步执行期内拦下，否则 DSH 会先拿原始文件报「不支持的格式」。
  event.preventDefault()
  event.stopPropagation()
  if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()

  void (async () => {
    /** @type {File[]} */
    const converted = []
    /** @type {string[]} */
    const failures = []
    let scaled = false
    for (const file of convertible) {
      try {
        const result = await convertOne(file)
        converted.push(result.file)
        if (result.scaled) scaled = true
      } catch (error) {
        failures.push(`${file.name || 'image'}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failures.length > 0) notify(`无法解码 ${failures[0]}`)
    const outgoing = [...passthrough, ...converted]
    if (outgoing.length === 0) return
    if (!rerouteAsDrop(outgoing)) {
      notify('没有找到输入框，图片转换后无处安放')
      return
    }
    if (converted.length > 0) {
      const detail = scaled ? `（已缩到 ${MAX_EDGE}px 内）` : ''
      notify(`已转换 ${converted.length} 张图片为 ${converted[0].type === 'image/png' ? 'PNG' : 'JPEG'}${detail}`)
    }
    if (source === 'paste') console.debug('[dsh-image-import] rerouted pasted images')
  })()
}

/**
 * 注入样式表（幂等）。
 * @returns {() => void} 移除函数。
 */
function ensureStyles() {
  const existing = document.querySelector(`style[data-dsh-image-import="${STYLE_ID}"]`)
  if (existing) return () => {}
  const style = document.createElement('style')
  style.dataset.dshImageImport = STYLE_ID
  style.textContent = STYLE_TEXT
  ;(document.head || document.documentElement).appendChild(style)
  return () => style.remove()
}

const ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2"/><circle cx="5.75" cy="5.75" r="1.1"/><path d="M2.4 11.3 5.9 8l2.4 2.1 1.9-1.6 3.4 2.8"/></svg>'

/**
 * 建好隐藏的 file input。
 * @returns {HTMLInputElement} input 元素。
 */
function ensureInput() {
  const existing = document.querySelector(`input[${INPUT_ATTR}]`)
  if (existing) return /** @type {HTMLInputElement} */ (existing)
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = [
    '.bmp', '.dib', '.tif', '.tiff', '.tga', '.icns', '.ico', '.cur', '.pcx',
    '.ppm', '.pgm', '.pbm', '.pnm', '.avif', '.svg', '.svgz', '.heic', '.heif',
    '.jfif', '.jp2', '.psd', 'image/*',
  ].join(',')
  input.setAttribute(INPUT_ATTR, '')
  input.style.display = 'none'
  input.addEventListener('change', () => {
    const files = input.files ? Array.from(input.files) : []
    input.value = ''
    if (files.length === 0) return
    void (async () => {
      /** @type {File[]} */
      const converted = []
      /** @type {string[]} */
      const failures = []
      let scaled = false
      for (const file of files.slice(0, MAX_FILES)) {
        try {
          const result = await convertOne(file)
          converted.push(result.file)
          if (result.scaled) scaled = true
        } catch (error) {
          failures.push(`${file.name || 'image'}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (failures.length > 0) notify(`无法解码 ${failures[0]}`)
      if (converted.length === 0) return
      if (rerouteAsDrop(converted)) {
        notify(`已导入 ${converted.length} 张图片${scaled ? `（已缩到 ${MAX_EDGE}px 内）` : ''}`)
      } else {
        notify('没有找到输入框，图片无法加入消息')
      }
    })()
  })
  ;(document.body || document.documentElement).appendChild(input)
  return input
}

/**
 * 在 composer 的工具条里放一个「导入图片」按钮。
 * @returns {boolean} 是否找到了落点。
 */
function ensureTrigger() {
  if (document.querySelector(`button[${TRIGGER_ATTR}]`)) return true
  const card = document.querySelector('[data-composer-card]')
  if (!card) return false
  // 以命令菜单的加号按钮为锚点：它在工具条里的位置最稳定。
  const anchor = card.querySelector('button[aria-haspopup="listbox"]')
  const row = anchor ? anchor.parentElement : card.querySelector('div')
  if (!row) return false
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'dsh-image-import-trigger'
  button.setAttribute(TRIGGER_ATTR, '')
  button.title = '导入图片（BMP / TIFF / TGA / PCX / PNM / SVG / AVIF…）'
  button.setAttribute('aria-label', button.title)
  button.innerHTML = ICON
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    ensureInput().click()
  })
  if (anchor && anchor.nextSibling) row.insertBefore(button, anchor.nextSibling)
  else row.appendChild(button)
  return true
}

/**
 * 安装整座桥。
 * @returns {() => void} 卸载函数。
 */
export function installImageBridge() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  const state = /** @type {{installed?: boolean}} */ (window).__dshImageImport
  if (state && state.installed) return () => {}
  ;(window).__dshImageImport = { installed: true }

  const dropListener = (event) => {
    if (event[BRIDGE_FLAG]) return
    const data = event.dataTransfer
    if (!data) return
    const files = Array.from(data.files || [])
    if (files.length === 0) return
    handleIncoming(files, event, 'drop')
  }

  const pasteListener = (event) => {
    if (event[BRIDGE_FLAG]) return
    const files = filesFromClipboard(event)
    if (files.length === 0) return
    handleIncoming(files, event, 'paste')
  }

  // 捕获阶段：必须早于 dsh-client-ui-attachment 挂在 document 冒泡阶段的 drop 监听器。
  document.addEventListener('drop', dropListener, true)
  document.addEventListener('paste', pasteListener, true)

  let removeStyles = () => {}
  let observer = null
  let disposed = false

  // 插件可能在 body 出现之前就被 apply，这时候还没地方插按钮和观察器。
  const startUi = () => {
    if (disposed) return
    removeStyles = ensureStyles()
    ensureInput()
    ensureTrigger()
    const root = document.body || document.documentElement
    if (!root || typeof MutationObserver !== 'function') return
    // composer 是随会话切换重建的，所以按钮要持续补。
    observer = new MutationObserver(() => {
      ensureTrigger()
    })
    observer.observe(root, { childList: true, subtree: true })
  }

  if (document.body) startUi()
  else document.addEventListener('DOMContentLoaded', startUi, false)

  return () => {
    disposed = true
    document.removeEventListener('drop', dropListener, true)
    document.removeEventListener('paste', pasteListener, true)
    document.removeEventListener('DOMContentLoaded', startUi, false)
    if (observer) observer.disconnect()
    removeStyles()
    document.querySelector(`button[${TRIGGER_ATTR}]`)?.remove()
    document.querySelector(`input[${INPUT_ATTR}]`)?.remove()
    for (const node of toasts) node.remove()
    ;(window).__dshImageImport = { installed: false }
  }
}
