/**
 * dsh-image-import — 纯解码器（浏览器与 Node 共用）
 *
 * 这里只有「字节 → RGBA」的纯计算：渲染格式判定、各容器格式的解析与像素
 * 展开。不碰 DOM、不碰 canvas、不做颜色管理，因此可以在 Node 里用真实样本
 * 直接测试（见 `test/codec.test.mjs`）。
 *
 * 每个解码器入口都返回 `{ width, height, data }`，其中 `data` 是紧密排列的
 * RGBA（`Uint8ClampedArray`，长度 `width * height * 4`，未预乘 alpha）。
 *
 * 支持范围（对应浏览器自己解不了的格式）：
 *   - TIFF：基线 strips、无压缩 / LZW / PackBits / Deflate，1/2/4/8/16 位，
 *     灰度（含 WhiteIsZero）、调色板、RGB、RGBA，Predictor 2
 *   - TGA：1/2/3 + 9/10/11（RLE），8/15/16/24/32 位，调色板与灰度
 *   - PCX：8 位 1/3/4 平面与 1 位 N 平面，RLE 编码，256 色尾部调色板
 *   - Netpbm：P1–P6（ASCII 与二进制，8/16 位）
 */

/** 每秒都需要的空数组，避免在热点循环里反复分配。 */
const EMPTY = new Uint8Array(0)

/**
 * 把 `Uint8Array` 视图规整成可安全按字节读取的视图。
 * @param {ArrayBuffer|Uint8Array} input - 原始字节。
 * @returns {Uint8Array} 字节视图。
 */
export function asBytes(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  throw new TypeError('decode: expected ArrayBuffer or ArrayBufferView')
}

/**
 * 按内容嗅探容器格式（TGA 没有魔数，只能靠扩展名，故不在此列）。
 * @param {Uint8Array} bytes - 字节视图。
 * @returns {'tiff'|'netpbm'|'pcx'|null} 嗅探结果。
 */
export function sniffFormat(bytes) {
  if (bytes.length >= 4) {
    const b0 = bytes[0]
    const b1 = bytes[1]
    if ((b0 === 0x49 && b1 === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00)
      || (b0 === 0x4d && b1 === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)) return 'tiff'
  }
  if (bytes.length >= 3 && bytes[0] === 0x50 && bytes[1] >= 0x31 && bytes[1] <= 0x36) return 'netpbm'
  if (bytes.length >= 4 && bytes[0] === 0x0a && bytes[2] === 0x01) return 'pcx'
  return null
}

//#region Netpbm

/**
 * 从 ASCII/二进制头部读一个十进制记号（跳过空白与 `#` 注释）。
 * @param {Uint8Array} bytes - 字节视图。
 * @param {{pos:number}} cursor - 读取游标，函数会原地推进。
 * @returns {number} 读到的数值；到头时返回 -1。
 */
function readPnmToken(bytes, cursor) {
  let pos = cursor.pos
  for (;;) {
    while (pos < bytes.length) {
      const c = bytes[pos]
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos += 1
      else break
    }
    if (pos >= bytes.length) { cursor.pos = pos; return -1 }
    if (bytes[pos] === 0x23) {
      while (pos < bytes.length && bytes[pos] !== 0x0a) pos += 1
      continue
    }
    break
  }
  let value = 0
  let digits = 0
  while (pos < bytes.length) {
    const c = bytes[pos]
    if (c < 0x30 || c > 0x39) break
    value = value * 10 + (c - 0x30)
    digits += 1
    pos += 1
  }
  cursor.pos = pos
  return digits === 0 ? -1 : value
}

/**
 * 解 Netpbm（P1–P6）。
 * @param {Uint8Array} bytes - 字节视图。
 * @returns {{width:number,height:number,data:Uint8ClampedArray}} 解码结果。
 */
export function decodeNetpbm(bytes) {
  const magic = String.fromCharCode(bytes[0], bytes[1])
  const spec = Number(magic[1])
  if (!(spec >= 1 && spec <= 6)) throw new Error('netpbm: bad magic')
  const cursor = { pos: 2 }
  const width = readPnmToken(bytes, cursor)
  const height = readPnmToken(bytes, cursor)
  if (!(width > 0 && height > 0)) throw new Error('netpbm: bad dimensions')
  const ascii = spec <= 3
  const maxval = spec === 1 || spec === 4 ? 1 : readPnmToken(bytes, cursor)
  if (!(maxval > 0)) throw new Error('netpbm: bad maxval')
  const scale = maxval === 255 ? 1 : 255 / maxval
  const data = new Uint8ClampedArray(width * height * 4)
  const channels = spec === 3 || spec === 6 ? 3 : 1

  /** 写入一个像素。 */
  const put = (index, r, g, b, a) => {
    const at = index * 4
    data[at] = r
    data[at + 1] = g
    data[at + 2] = b
    data[at + 3] = a
  }

  if (ascii) {
    for (let i = 0; i < width * height; i += 1) {
      if (channels === 3) {
        const r = readPnmToken(bytes, cursor)
        const g = readPnmToken(bytes, cursor)
        const b = readPnmToken(bytes, cursor)
        if (b < 0) throw new Error('netpbm: truncated ascii body')
        put(i, r * scale, g * scale, b * scale, 255)
      } else if (spec === 1) {
        const v = readPnmToken(bytes, cursor)
        if (v < 0) throw new Error('netpbm: truncated ascii body')
        const level = v === 0 ? 255 : 0
        put(i, level, level, level, 255)
      } else {
        const v = readPnmToken(bytes, cursor)
        if (v < 0) throw new Error('netpbm: truncated ascii body')
        put(i, v * scale, v * scale, v * scale, 255)
      }
    }
    return { width, height, data }
  }

  // 二进制体：头部之后恰好一个空白字符，随后是紧密字节。
  let body = cursor.pos
  while (body < bytes.length && (bytes[body] === 0x20 || bytes[body] === 0x09 || bytes[body] === 0x0a || bytes[body] === 0x0d)) body += 1
  const wide = maxval > 255

  if (spec === 4) {
    const rowBytes = (width + 7) >> 3
    if (bytes.length - body < rowBytes * height) throw new Error('netpbm: truncated bitmap')
    for (let y = 0; y < height; y += 1) {
      const rowStart = body + y * rowBytes
      for (let x = 0; x < width; x += 1) {
        const bit = (bytes[rowStart + (x >> 3)] >> (7 - (x & 7))) & 1
        const level = bit === 1 ? 0 : 255
        put(y * width + x, level, level, level, 255)
      }
    }
    return { width, height, data }
  }

  const sampleSize = wide ? 2 : 1
  const needed = width * height * channels * sampleSize
  if (bytes.length - body < needed) throw new Error('netpbm: truncated body')
  const readSample = (at) => (wide ? (bytes[at] << 8) | bytes[at + 1] : bytes[at])
  let at = body
  for (let i = 0; i < width * height; i += 1) {
    if (channels === 3) {
      const r = readSample(at); at += sampleSize
      const g = readSample(at); at += sampleSize
      const b = readSample(at); at += sampleSize
      put(i, r * scale, g * scale, b * scale, 255)
    } else {
      const v = readSample(at); at += sampleSize
      put(i, v * scale, v * scale, v * scale, 255)
    }
  }
  return { width, height, data }
}

//#endregion

//#region PCX

/**
 * PCX 的 RLE 还原：`>= 0xC0` 的字节是「重复次数 | 0x40」，下一字节是值。
 * @param {Uint8Array} src - 压缩数据。
 * @param {number} expected - 期望解出的字节数。
 * @returns {Uint8Array} 解压后的字节。
 */
function pcxRle(src, expected) {
  const out = new Uint8Array(expected)
  let i = 0
  let o = 0
  while (i < src.length && o < expected) {
    const value = src[i]
    i += 1
    if ((value & 0xc0) === 0xc0) {
      const run = value & 0x3f
      if (i >= src.length) break
      const repeated = src[i]
      i += 1
      for (let n = 0; n < run && o < expected; n += 1) out[o++] = repeated
    } else {
      out[o++] = value
    }
  }
  return out
}

/**
 * 解 PCX（只覆盖 8 位平面与 1 位多平面两种常见排布）。
 * @param {Uint8Array} bytes - 字节视图。
 * @returns {{width:number,height:number,data:Uint8ClampedArray}} 解码结果。
 */
export function decodePcx(bytes) {
  if (bytes[0] !== 0x0a) throw new Error('pcx: bad manufacturer')
  const encoding = bytes[2]
  const bitsPerPixel = bytes[3]
  const xmin = bytes[4] | (bytes[5] << 8)
  const ymin = bytes[6] | (bytes[7] << 8)
  const xmax = bytes[8] | (bytes[9] << 8)
  const ymax = bytes[10] | (bytes[11] << 8)
  const width = xmax - xmin + 1
  const height = ymax - ymin + 1
  if (!(width > 0 && height > 0)) throw new Error('pcx: bad dimensions')
  const planes = bytes[65]
  const bytesPerLine = bytes[66] | (bytes[67] << 8)
  if (!(planes > 0 && bytesPerLine > 0)) throw new Error('pcx: bad header')
  const rowBytes = bytesPerLine * planes
  const packed = bytes.subarray(128)
  const raw = encoding === 1 ? pcxRle(packed, rowBytes * height) : packed.subarray(0, rowBytes * height)
  const data = new Uint8ClampedArray(width * height * 4)

  if (bitsPerPixel === 8) {
    if (planes === 3) {
      for (let y = 0; y < height; y += 1) {
        const base = y * rowBytes
        for (let x = 0; x < width; x += 1) {
          const at = (y * width + x) * 4
          data[at] = raw[base + x]
          data[at + 1] = raw[base + bytesPerLine + x]
          data[at + 2] = raw[base + bytesPerLine * 2 + x]
          data[at + 3] = 255
        }
      }
      return { width, height, data }
    }
    if (planes === 4) {
      for (let y = 0; y < height; y += 1) {
        const base = y * rowBytes
        for (let x = 0; x < width; x += 1) {
          const at = (y * width + x) * 4
          data[at] = raw[base + x]
          data[at + 1] = raw[base + bytesPerLine + x]
          data[at + 2] = raw[base + bytesPerLine * 2 + x]
          data[at + 3] = raw[base + bytesPerLine * 3 + x]
        }
      }
      return { width, height, data }
    }
    if (planes === 1) {
      // 单平面 8 位：调色板在文件尾部 `0x0C` 之后的 768 字节。
      let tail = bytes.length - 769
      if (tail < 0 || bytes[tail] !== 0x0c) throw new Error('pcx: missing 256-colour palette')
      const palette = bytes.subarray(tail + 1, tail + 769)
      for (let y = 0; y < height; y += 1) {
        const base = y * rowBytes
        for (let x = 0; x < width; x += 1) {
          const index = raw[base + x]
          const at = (y * width + x) * 4
          data[at] = palette[index * 3]
          data[at + 1] = palette[index * 3 + 1]
          data[at + 2] = palette[index * 3 + 2]
          data[at + 3] = 255
        }
      }
      return { width, height, data }
    }
    throw new Error('pcx: unsupported 8-bit plane count')
  }

  if (bitsPerPixel === 1) {
    // 1 位 × N 平面：每平面一位，合成索引后查 16 色头调色板。
    const palette = bytes.subarray(16, 64)
    for (let y = 0; y < height; y += 1) {
      const base = y * rowBytes
      for (let x = 0; x < width; x += 1) {
        let index = 0
        for (let plane = 0; plane < planes && plane < 4; plane += 1) {
          const byte = raw[base + plane * bytesPerLine + (x >> 3)]
          const bit = (byte >> (7 - (x & 7))) & 1
          index |= bit << plane
        }
        const at = (y * width + x) * 4
        data[at] = palette[index * 3]
        data[at + 1] = palette[index * 3 + 1]
        data[at + 2] = palette[index * 3 + 2]
        data[at + 3] = 255
      }
    }
    return { width, height, data }
  }

  throw new Error('pcx: unsupported bit depth')
}

//#endregion

//#region TGA

/**
 * 解 TGA（含 RLE 变体）。
 * @param {Uint8Array} bytes - 字节视图。
 * @returns {{width:number,height:number,data:Uint8ClampedArray}} 解码结果。
 */
export function decodeTga(bytes) {
  if (bytes.length < 18) throw new Error('tga: header too short')
  const idLength = bytes[0]
  const colorMapType = bytes[1]
  const imageType = bytes[2]
  const colorMapLength = bytes[5] | (bytes[6] << 8)
  const colorMapDepth = bytes[7]
  const width = bytes[12] | (bytes[13] << 8)
  const height = bytes[14] | (bytes[15] << 8)
  const pixelDepth = bytes[16]
  const descriptor = bytes[17]
  if (!(width > 0 && height > 0)) throw new Error('tga: bad dimensions')
  const rle = imageType === 9 || imageType === 10 || imageType === 11
  const baseType = rle ? imageType - 8 : imageType
  const topDown = (descriptor & 0x20) !== 0
  const rightToLeft = (descriptor & 0x10) !== 0
  const pixelCount = width * height

  let pos = 18 + idLength
  let palette = null
  if (colorMapType === 1) {
    const entryBytes = Math.max(1, (colorMapDepth + 7) >> 3)
    palette = bytes.subarray(pos, pos + colorMapLength * entryBytes)
    pos += colorMapLength * entryBytes
  }

  const entryBytes = Math.max(1, (pixelDepth + 7) >> 3)
  const total = pixelCount * entryBytes
  let body
  if (rle) {
    body = new Uint8Array(total)
    let o = 0
    while (pos < bytes.length && o < total) {
      const header = bytes[pos]
      pos += 1
      const run = (header & 0x7f) + 1
      if ((header & 0x80) !== 0) {
        const px = bytes.subarray(pos, pos + entryBytes)
        pos += entryBytes
        for (let n = 0; n < run && o + entryBytes <= total; n += 1) {
          body.set(px, o)
          o += entryBytes
        }
      } else {
        const span = Math.min(run * entryBytes, total - o)
        body.set(bytes.subarray(pos, pos + span), o)
        pos += run * entryBytes
        o += span
      }
    }
  } else {
    if (bytes.length - pos < total) throw new Error('tga: truncated body')
    body = bytes.subarray(pos, pos + total)
  }

  const data = new Uint8ClampedArray(pixelCount * 4)

  /** 写一个像素（考虑 origin 标志）。 */
  const put = (index, r, g, b, a) => {
    const x = rightToLeft ? width - 1 - (index % width) : index % width
    const y = topDown ? Math.floor(index / width) : height - 1 - Math.floor(index / width)
    const at = (y * width + x) * 4
    data[at] = r
    data[at + 1] = g
    data[at + 2] = b
    data[at + 3] = a
  }

  for (let i = 0; i < pixelCount; i += 1) {
    const at = i * entryBytes
    if (baseType === 1 && palette !== null) {
      const index = entryBytes === 1 ? body[at] : body[at] | (body[at + 1] << 8)
      const entry = index * Math.max(1, (colorMapDepth + 7) >> 3)
      if (colorMapDepth === 24) put(i, palette[entry + 2], palette[entry + 1], palette[entry], 255)
      else if (colorMapDepth === 32) put(i, palette[entry + 2], palette[entry + 1], palette[entry], palette[entry + 3])
      else if (colorMapDepth === 15 || colorMapDepth === 16) {
        const v = palette[entry] | (palette[entry + 1] << 8)
        put(i, ((v >> 10) & 0x1f) << 3, ((v >> 5) & 0x1f) << 3, (v & 0x1f) << 3, (v & 0x8000) !== 0 ? 255 : 0)
      } else {
        throw new Error('tga: unsupported colour map depth')
      }
      continue
    }
    if (baseType === 3) {
      const level = body[at]
      put(i, level, level, level, 255)
      continue
    }
    if (baseType !== 2) throw new Error('tga: unsupported image type')
    if (pixelDepth === 32) {
      put(i, body[at + 2], body[at + 1], body[at], body[at + 3])
    } else if (pixelDepth === 24) {
      put(i, body[at + 2], body[at + 1], body[at], 255)
    } else if (pixelDepth === 16 || pixelDepth === 15) {
      const v = body[at] | (body[at + 1] << 8)
      const alpha = pixelDepth === 16 && (descriptor & 0x0f) > 0 ? ((v & 0x8000) !== 0 ? 255 : 0) : 255
      put(i, ((v >> 10) & 0x1f) << 3, ((v >> 5) & 0x1f) << 3, (v & 0x1f) << 3, alpha)
    } else if (pixelDepth === 8 && baseType === 2) {
      const level = body[at]
      put(i, level, level, level, 255)
    } else {
      throw new Error('tga: unsupported pixel depth')
    }
  }

  return { width, height, data }
}

//#endregion

//#region TIFF

/** TIFF 字段类型 → 单值字节数。 */
const TIFF_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }

/**
 * TIFF LZW 还原（MSB-first，无 early change，与 GIF 变体不同）。
 * @param {Uint8Array} src - 压缩数据。
 * @param {number} expected - 期望解出的字节数。
 * @returns {Uint8Array} 解压后的字节。
 */
function tiffLzw(src, expected) {
  const out = new Uint8Array(expected)
  const prefix = new Int32Array(4096).fill(-1)
  const suffix = new Uint8Array(4096)
  const first = new Uint8Array(4096)
  for (let i = 0; i < 256; i += 1) { suffix[i] = i; first[i] = i }
  const stack = new Uint8Array(4097)
  let codeWidth = 9
  let next = 258
  let prev = -1
  let bitBuf = 0
  let bitCount = 0
  let srcPos = 0
  let outPos = 0

  while (outPos < expected) {
    while (bitCount < codeWidth) {
      if (srcPos >= src.length) return out
      bitBuf = ((bitBuf << 8) | src[srcPos]) >>> 0
      srcPos += 1
      bitCount += 8
    }
    const code = (bitBuf >>> (bitCount - codeWidth)) & ((1 << codeWidth) - 1)
    bitCount -= codeWidth
    bitBuf &= (1 << bitCount) - 1
    if (code === 256) { codeWidth = 9; next = 258; prev = -1; continue }
    if (code === 257) break
    let sp = 0
    let walk = code
    if (code >= next) {
      if (prev < 0) break
      stack[sp] = first[prev]
      sp += 1
      walk = prev
    }
    // sp 上限兼作畸形数据的护栏：前缀链若有环，宁可变短也不能卡死渲染线程。
    while (walk >= 258 && sp < 4096) { stack[sp] = suffix[walk]; sp += 1; walk = prefix[walk] }
    stack[sp] = suffix[walk]
    sp += 1
    const head = suffix[walk]
    while (sp > 0 && outPos < expected) { sp -= 1; out[outPos] = stack[sp]; outPos += 1 }
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev
      suffix[next] = head
      first[next] = first[prev]
      next += 1
      // TIFF 规范 Table 8 的码长边界比满表早一格（9 位只到 510），libtiff 依此实现。
      if (next === (1 << codeWidth) - 1 && codeWidth < 12) codeWidth += 1
    }
    prev = code
  }
  return out
}

/**
 * TIFF PackBits 还原。
 * @param {Uint8Array} src - 压缩数据。
 * @param {number} expected - 期望解出的字节数。
 * @returns {Uint8Array} 解压后的字节。
 */
function tiffPackBits(src, expected) {
  const out = new Uint8Array(expected)
  let i = 0
  let o = 0
  while (i < src.length && o < expected) {
    const header = (src[i] << 24) >> 24
    i += 1
    if (header >= 0) {
      const run = header + 1
      for (let n = 0; n < run && i < src.length && o < expected; n += 1) { out[o] = src[i]; o += 1; i += 1 }
    } else if (header !== -128) {
      const run = 1 - header
      if (i >= src.length) break
      const value = src[i]
      i += 1
      for (let n = 0; n < run && o < expected; n += 1) { out[o] = value; o += 1 }
    }
  }
  return out
}

/**
 * Deflate（zlib 包装）还原，走平台的 DecompressionStream。
 * @param {Uint8Array} src - 压缩数据。
 * @param {number} expected - 期望解出的字节数。
 * @returns {Promise<Uint8Array>} 解压后的字节。
 */
async function tiffDeflate(src, expected) {
  if (typeof DecompressionStream !== 'function') throw new Error('tiff: deflate needs DecompressionStream')
  const stream = new Blob([src]).stream().pipeThrough(new DecompressionStream('deflate'))
  const buffer = await new Response(stream).arrayBuffer()
  const bytes = new Uint8Array(buffer)
  if (bytes.length >= expected) return bytes.subarray(0, expected)
  const out = new Uint8Array(expected)
  out.set(bytes)
  return out
}

/**
 * 解析 TIFF 的 IFD，回读成「tag → 值数组 / 标量」的读取器。
 * @param {Uint8Array} bytes - 字节视图。
 * @param {DataView} view - 同一段内存上的 DataView。
 * @param {boolean} le - 是否小端。
 * @param {number} offset - IFD 起始偏移。
 * @returns {(tag:number)=>number[]} 取值函数，返回原始数值数组。
 */
function tiffIfdReader(bytes, view, le, offset) {
  const count = view.getUint16(offset, le)
  /** @type {Map<number, number[]>} */
  const table = new Map()
  for (let i = 0; i < count; i += 1) {
    const entry = offset + 2 + i * 12
    if (entry + 12 > bytes.length) break
    const tag = view.getUint16(entry, le)
    const type = view.getUint16(entry + 2, le)
    const n = view.getUint32(entry + 4, le)
    const size = TIFF_TYPE_SIZE[type] ?? 1
    const total = size * n
    const values = new Array(n)
    if (total <= 4) {
      for (let k = 0; k < n; k += 1) values[k] = readTiffValue(view, entry + 8 + k * size, type, le)
    } else {
      const at = view.getUint32(entry + 8, le)
      for (let k = 0; k < n; k += 1) values[k] = readTiffValue(view, at + k * size, type, le)
    }
    table.set(tag, values)
  }
  return (tag) => table.get(tag) ?? []
}

/**
 * 读一个 TIFF 字段值。
 * @param {DataView} view - DataView。
 * @param {number} at - 偏移。
 * @param {number} type - 字段类型。
 * @param {boolean} le - 是否小端。
 * @returns {number} 数值。
 */
function readTiffValue(view, at, type, le) {
  switch (type) {
    case 3: return view.getUint16(at, le)
    case 4: return view.getUint32(at, le)
    case 8: return view.getInt16(at, le)
    case 9: return view.getInt32(at, le)
    case 11: return view.getFloat32(at, le)
    case 12: return view.getFloat64(at, le)
    default: return view.getUint8(at)
  }
}

/**
 * 解 TIFF（基线 strips 布局）。
 * @param {Uint8Array} bytes - 字节视图。
 * @returns {Promise<{width:number,height:number,data:Uint8ClampedArray}>} 解码结果。
 */
export async function decodeTiff(bytes) {
  if (bytes.length < 8) throw new Error('tiff: too short')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const le = bytes[0] === 0x49
  const ifdOffset = view.getUint32(4, le)
  const read = tiffIfdReader(bytes, view, le, ifdOffset)
  const scalar = (tag, fallback) => {
    const values = read(tag)
    return values.length > 0 ? values[0] : fallback
  }

  const width = scalar(256, 0)
  const height = scalar(257, 0)
  if (!(width > 0 && height > 0)) throw new Error('tiff: bad dimensions')
  const compression = scalar(259, 1)
  const photometric = scalar(262, 1)
  const samplesPerPixel = scalar(277, 1)
  const bitsList = read(258)
  const bits = bitsList.length > 0 ? bitsList[0] : 1
  const fillOrder = scalar(266, 1)
  const planar = scalar(284, 1)
  const predictor = scalar(317, 1)
  const extraSamples = read(338)
  const alphaMode = extraSamples.length > 0 ? extraSamples[0] : 2
  if (planar !== 1) throw new Error('tiff: planar configuration 2 is not supported')

  const tileOffsets = read(324)
  if (tileOffsets.length > 0) throw new Error('tiff: tiled layout is not supported')

  const stripOffsets = read(273)
  const stripCounts = read(279)
  if (stripOffsets.length === 0) throw new Error('tiff: no image strips')
  const rowsPerStrip = scalar(278, height)
  const bpsSum = bits * samplesPerPixel
  const rowBytes = Math.ceil((width * bpsSum) / 8)

  const data = new Uint8ClampedArray(width * height * 4)
  const samples = samplesPerPixel

  for (let strip = 0; strip < stripOffsets.length; strip += 1) {
    const from = stripOffsets[strip]
    const to = from + (stripCounts[strip] ?? 0)
    if (from >= bytes.length) break
    const chunk = bytes.subarray(from, Math.min(to, bytes.length))
    const rows = Math.min(rowsPerStrip, height - strip * rowsPerStrip)
    if (rows <= 0) break
    const expected = rowBytes * rows
    let raw
    if (compression === 1) raw = chunk.length >= expected ? chunk.subarray(0, expected) : chunk
    else if (compression === 5) raw = tiffLzw(chunk, expected)
    else if (compression === 32773) raw = tiffPackBits(chunk, expected)
    else if (compression === 8 || compression === 32946) raw = await tiffDeflate(chunk, expected)
    else throw new Error(`tiff: compression ${compression} is not supported`)

    // Predictor 2：同一行内按样本差分累加，必须在展开像素之前还原。
    if (predictor === 2 && bits === 8) {
      for (let y = 0; y < rows; y += 1) {
        const base = y * rowBytes
        for (let i = samples; i < width * samples; i += 1) {
          raw[base + i] = (raw[base + i] + raw[base + i - samples]) & 0xff
        }
      }
    } else if (predictor === 2 && bits === 16) {
      for (let y = 0; y < rows; y += 1) {
        const base = y * rowBytes
        for (let i = samples; i < width * samples; i += 1) {
          const at = base + i * 2
          const prevAt = base + (i - samples) * 2
          const sum = ((raw[at] << 8) | raw[at + 1]) + ((raw[prevAt] << 8) | raw[prevAt + 1])
          raw[at] = (sum >> 8) & 0xff
          raw[at + 1] = sum & 0xff
        }
      }
    } else if (predictor !== 1 && predictor !== 2) {
      throw new Error(`tiff: predictor ${predictor} is not supported`)
    }

    const paletteValues = photometric === 3 ? read(320) : EMPTY
    const paletteSize = 1 << bits
    const baseRow = strip * rowsPerStrip

    for (let y = 0; y < rows; y += 1) {
      const targetY = baseRow + y
      if (targetY >= height) break
      const rowStart = y * rowBytes
      for (let x = 0; x < width; x += 1) {
        const at = (targetY * width + x) * 4
        let r = 0
        let g = 0
        let b = 0
        let a = 255

        if (bits === 8 || bits === 16) {
          /** 读第 k 个样本，统一缩放到 0..255。 */
          const sample = (k) => {
            if (bits === 8) return raw[rowStart + (x * samples + k)]
            const at16 = rowStart + (x * samples + k) * 2
            return raw[at16]
          }
          if (samples >= 3) {
            r = sample(0)
            g = sample(1)
            b = sample(2)
            if (samples >= 4) a = sample(3)
          } else {
            const value = sample(0)
            if (photometric === 3) {
              const index = bits === 8 ? value : ((raw[rowStart + x * 2] << 8) | raw[rowStart + x * 2 + 1])
              r = (paletteValues[index] ?? 0) >> 8
              g = (paletteValues[paletteSize + index] ?? 0) >> 8
              b = (paletteValues[paletteSize * 2 + index] ?? 0) >> 8
            } else if (photometric === 0) {
              r = g = b = 255 - value
            } else {
              r = g = b = value
            }
          }
          if (samples === 2) a = sample(1)
          if (samples === 4 && alphaMode === 1) {
            // 关联 alpha：先解预乘，避免画面发暗。
            if (a > 0) { r = Math.min(255, (r * 255) / a); g = Math.min(255, (g * 255) / a); b = Math.min(255, (b * 255) / a) }
          }
        } else {
          // 1/2/4 位：按位取值后展开。
          const perByte = 8 / bits
          const mask = (1 << bits) - 1
          const sampleIndex = x * samples
          const byte = raw[rowStart + Math.floor(sampleIndex / perByte)]
          const shift = 8 - bits - (sampleIndex % perByte) * bits
          let value = (byte >> shift) & mask
          if (fillOrder === 2) {
            // 反向位序：把同一字节里的位倒过来再取。
            let reversed = 0
            for (let bit = 0; bit < 8; bit += 1) reversed |= ((byte >> bit) & 1) << (7 - bit)
            value = (reversed >> shift) & mask
          }
          if (photometric === 3) {
            r = (paletteValues[value] ?? 0) >> 8
            g = (paletteValues[paletteSize + value] ?? 0) >> 8
            b = (paletteValues[paletteSize * 2 + value] ?? 0) >> 8
          } else {
            const level = Math.round((value * 255) / mask)
            r = g = b = photometric === 0 ? 255 - level : level
          }
        }

        data[at] = r
        data[at + 1] = g
        data[at + 2] = b
        data[at + 3] = a
      }
    }
  }

  return { width, height, data }
}

//#endregion

/**
 * 按格式名解码一段字节。
 * @param {Uint8Array|ArrayBuffer} input - 文件字节。
 * @param {'tiff'|'tga'|'pcx'|'netpbm'} format - 容器格式。
 * @returns {Promise<{width:number,height:number,data:Uint8ClampedArray}>} 解码结果。
 */
export async function decodeImageBuffer(input, format) {
  const bytes = asBytes(input)
  switch (format) {
    case 'tiff': return await decodeTiff(bytes)
    case 'tga': return decodeTga(bytes)
    case 'pcx': return decodePcx(bytes)
    case 'netpbm': return decodeNetpbm(bytes)
    default: throw new Error(`codec: unknown format ${String(format)}`)
  }
}
