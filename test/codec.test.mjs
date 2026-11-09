/**
 * dsh-image-import — 解码器回归测试
 *
 * 对 `test/fixtures/` 里 Pillow 生成的每个样本跑一次解码，逐像素比对
 * Pillow 自己解出的 RGBA。样本由 `python test/make_fixtures.py` 生成。
 *
 * 用法：node test/codec.test.mjs
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeImageBuffer, decodeTga, sniffFormat } from '../src/codec.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

/** 扩展名 → 解码器格式名；没有条目的格式由浏览器自己解，本测试不覆盖。 */
const ROUTES = {
  tif: 'tiff',
  tiff: 'tiff',
  tga: 'tga',
  pcx: 'pcx',
  ppm: 'netpbm',
  pgm: 'netpbm',
  pbm: 'netpbm',
}

let passed = 0
const failures = []

/**
 * 比对两张 RGBA 位图。
 * @param {Uint8ClampedArray} actual - 解码器输出。
 * @param {Uint8ClampedArray} expected - Pillow 输出。
 * @param {number} width - 宽。
 * @param {number} height - 高。
 * @returns {string|null} 首个差异的描述；完全一致时 null。
 */
function compare(actual, expected, width, height) {
  if (actual.length !== expected.length) {
    return `length ${actual.length} != ${expected.length}`
  }
  let mismatched = 0
  let first = null
  for (let i = 0; i < expected.length; i += 4) {
    const same = actual[i] === expected[i]
      && actual[i + 1] === expected[i + 1]
      && actual[i + 2] === expected[i + 2]
      && actual[i + 3] === expected[i + 3]
    if (same) continue
    mismatched += 1
    if (first === null) {
      const index = i / 4
      const x = index % width
      const y = Math.floor(index / width)
      first = `(${x},${y}) got ${actual[i]},${actual[i + 1]},${actual[i + 2]},${actual[i + 3]}`
        + ` want ${expected[i]},${expected[i + 1]},${expected[i + 2]},${expected[i + 3]}`
    }
  }
  if (mismatched === 0) return null
  const total = width * height
  return `${mismatched}/${total} px differ, first at ${first}`
}

/**
 * 跑一个样本。
 * @param {string} name - 样本文件名。
 */
async function runCase(name) {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const format = ROUTES[extension]
  if (format === undefined) {
    console.log(`  skip ${name} (browser-native format)`)
    return
  }
  const meta = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))
  const bytes = new Uint8Array(readFileSync(join(FIXTURES, name)))
  const expected = new Uint8Array(readFileSync(join(FIXTURES, `${name}.rgba`)))

  if (meta.format !== extension && format !== 'netpbm') {
    console.log(`  note ${name}: metadata format ${meta.format}`)
  }

  const sniffed = sniffFormat(bytes)
  if (format !== 'tga' && sniffed !== format) {
    failures.push(`${name}: sniffFormat ${String(sniffed)} != ${format}`)
    return
  }

  let decoded
  try {
    decoded = await decodeImageBuffer(bytes, format)
  } catch (error) {
    failures.push(`${name}: threw ${error.message}`)
    return
  }
  if (decoded.width !== meta.width || decoded.height !== meta.height) {
    failures.push(`${name}: size ${decoded.width}x${decoded.height} != ${meta.width}x${meta.height}`)
    return
  }
  const diff = compare(decoded.data, expected, meta.width, meta.height)
  if (diff === null) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name}: ${diff}`)
  }
}

const names = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -'.json'.length))
  .sort()

console.log(`解码器回归：${names.length} 个样本\n`)
for (const name of names) await runCase(name)

// 额外的不变量：TGA 没有魔数，嗅探必须保持沉默而不是误判成别的容器。
if (sniffFormat(new Uint8Array(readFileSync(join(FIXTURES, 'truecolor24.tga')))) !== null) {
  failures.push('sniffFormat: a TGA file must not be sniffed as another container')
}
if (sniffFormat(new Uint8Array([0x49, 0x49, 0x2a, 0x00])) !== 'tiff') {
  failures.push('sniffFormat: classic little-endian TIFF header not detected')
}
if (sniffFormat(new Uint8Array([0x4d, 0x4d, 0x00, 0x2a])) !== 'tiff') {
  failures.push('sniffFormat: big-endian TIFF header not detected')
}
if (typeof decodeTga !== 'function') failures.push('decodeTga export missing')

console.log(`\n通过 ${passed} / ${names.length - 2}`)
if (failures.length > 0) {
  console.error(`\n失败 ${failures.length} 项：`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('全部通过')
}
