/**
 * dsh-image-import — 浏览器侧桥接的端到端测试（Node + 假 DOM）
 *
 * 覆盖三件在真实 GUI 里最容易坏的事：
 *   1. 白名单外的图片在 document 捕获阶段被拦下，不落到 DSH 原生 intake 手里；
 *   2. 转码后重派的是 PNG/JPEG，文件名派生正确，且不会自触发成死循环；
 *   3. 本来就是 PNG 的文件完全不被插手。
 *
 * 用法：node test/bridge.test.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { installFakeDom } from './dom-stub.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

const dom = installFakeDom()
// bridge 在 import 时就绑定了全局 document，所以必须在装好桩之后才能加载。
const { installImageBridge } = await import('../src/bridge.js')

const failures = []
let passed = 0

/**
 * 断言。
 * @param {boolean} condition - 期望为真。
 * @param {string} message - 失败说明。
 */
function check(condition, message) {
  if (condition) {
    passed += 1
  } else {
    failures.push(message)
  }
}

/**
 * 读一个 fixture 并包成浏览器里的 File。
 * @param {string} name - 文件名。
 * @param {string} type - MIME。
 * @returns {File} 文件对象。
 */
function fixtureFile(name, type) {
  const bytes = readFileSync(join(FIXTURES, name))
  return new File([new Uint8Array(bytes)], name, { type })
}

/**
 * 等异步转码跑完（bridge 里是 fire-and-forget 的 async IIFE）。
 * @param {() => boolean} done - 完成条件。
 * @param {number} [timeout] - 最长等待毫秒。
 * @returns {Promise<boolean>} 是否在超时前满足条件。
 */
async function waitFor(done, timeout = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (done()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return done()
}

/** 造一个 drop 事件。 */
function dropEvent(files) {
  const data = new DataTransfer()
  for (const file of files) data.items.add(file)
  return new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })
}

// ---------------------------------------------------------------- 用例 1：TIFF
{
  const dispose = installImageBridge()
  dom.dispatched.length = 0
  globalThis.__fakeContexts = []

  const file = fixtureFile('tiff-rgb-lzw.tif', 'image/tiff')
  const event = dropEvent([file])
  dom.document.dispatchEvent(event)

  check(event.defaultPrevented, 'TIFF 拖放应当在捕获阶段被 preventDefault')
  check(event.propagationStopped, 'TIFF 拖放应当被 stopPropagation，不能落到原生 intake')

  const done = await waitFor(() => dom.dispatched.length > 0)
  check(done, 'TIFF 拖放应当在超时前重派出一个 drop 事件')

  const rerouted = dom.dispatched[0]
  check(rerouted?.type === 'drop', '重派的事件类型应为 drop')
  check(rerouted?.__dshImageImportRerouted === true, '重派事件必须带防自触发标记')

  const outgoing = rerouted?.dataTransfer?.files ?? []
  check(outgoing.length === 1, `重派应当只带 1 个文件，实际 ${outgoing.length}`)
  check(outgoing[0]?.type === 'image/png', `重派文件应为 image/png，实际 ${outgoing[0]?.type}`)
  check(outgoing[0]?.name === 'tiff-rgb-lzw.png', `文件名应派生为 .png，实际 ${outgoing[0]?.name}`)
  check(rerouted?.dataTransfer?.types?.includes('Files') === true, 'DataTransfer.types 必须含 Files')

  const context = globalThis.__fakeContexts.at(-1)
  const painted = context?.lastImage
  check(painted?.width === 37 && painted?.height === 23, `画布尺寸应为 37x23，实际 ${painted?.width}x${painted?.height}`)
  const pixels = painted?.data ?? new Uint8ClampedArray(4)
  check(pixels[0] === 255 && pixels[1] === 0 && pixels[2] === 0, `左上角应为红色，实际 ${pixels[0]},${pixels[1]},${pixels[2]}`)
  check(pixels[3] === 255, '左上角应不透明')

  // 重派事件再次经过监听器时必须被跳过，不能引发第二轮转换。
  const before = dom.dispatched.length
  dom.document.dispatchEvent(rerouted)
  await new Promise((resolve) => setTimeout(resolve, 60))
  check(dom.dispatched.length === before, '重派事件不得再次被拦截（防死循环）')

  dispose()
}

// ------------------------------------------------------- 用例 2：原生 PNG 不插手
{
  const dispose = installImageBridge()
  dom.dispatched.length = 0

  const file = fixtureFile('rgba.png', 'image/png')
  const event = dropEvent([file])
  dom.document.dispatchEvent(event)

  check(!event.defaultPrevented, 'PNG 拖放不应被拦截')
  await new Promise((resolve) => setTimeout(resolve, 60))
  check(dom.dispatched.length === 0, 'PNG 不需要重派')

  dispose()
}

// --------------------------------------------- 用例 3：批处理里混合保留原生文件
{
  const dispose = installImageBridge()
  dom.dispatched.length = 0
  globalThis.__fakeContexts = []

  const tiff = fixtureFile('tiff-gray-lzw.tif', 'image/tiff')
  const png = fixtureFile('rgba.png', 'image/png')
  const event = dropEvent([tiff, png])
  dom.document.dispatchEvent(event)

  check(event.defaultPrevented, '混合批次应当被拦下')

  const done = await waitFor(() => dom.dispatched.length > 0)
  check(done, '混合批次应当在超时前重派')

  const outgoing = dom.dispatched[0]?.dataTransfer?.files ?? []
  check(outgoing.length === 2, `重派应带 2 个文件，实际 ${outgoing.length}`)
  check(outgoing.some((file) => file.type === 'image/png' && file.name === 'rgba.png'), '原本的 PNG 应原样透传')
  check(outgoing.some((file) => file.type === 'image/png' && file.name === 'tiff-gray-lzw.png'), 'TIFF 应被转成 PNG')

  dispose()
}

// ------------------------------------------------------ 用例 4：卸载后不再拦截
{
  const dispose = installImageBridge()
  dispose()
  dom.dispatched.length = 0

  const event = dropEvent([fixtureFile('tiff-rgb-raw.tif', 'image/tiff')])
  dom.document.dispatchEvent(event)
  await new Promise((resolve) => setTimeout(resolve, 60))

  check(!event.defaultPrevented, '卸载后不应再拦截拖放')
  check(dom.dispatched.length === 0, '卸载后不应再有重派')
}

// ------------------------------------------------------------ 用例 5：按钮注入
{
  const dispose = installImageBridge()
  const trigger = dom.document.querySelector('button[data-dsh-image-import-trigger]')
  check(trigger !== null, '应当在 composer 工具条里注入导入按钮')
  check(dom.document.querySelector('input[data-dsh-image-import-input]') !== null, '应当存在隐藏的 file input')
  check(
    (dom.document.querySelector('input[data-dsh-image-import-input]')?.accept || '').includes('.tif'),
    'file input 的 accept 应包含 .tif',
  )
  dispose()
}

dom.teardown()

console.log(`\n通过 ${passed} 项`)
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('全部通过')
}
