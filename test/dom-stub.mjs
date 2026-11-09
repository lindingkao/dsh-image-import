/**
 * 一个只够跑 bridge 的极简 DOM：元素树、属性选择器、捕获/冒泡派发、假画布。
 *
 * 真实浏览器验证要看 GUI，所以在 Node 里用这套桩把「拦截 → 转码 → 重派」的
 * 控制流跑一遍，避免把死循环和重复派发这类问题留到用户手上。
 */

/** 假画布上下文：只需要 createImageData / putImageData / drawImage。 */
class FakeContext {
  constructor() {
    this.lastImage = null
    this.imageSmoothingQuality = 'low'
  }

  createImageData(width, height) {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) }
  }

  putImageData(image) {
    this.lastImage = image
  }

  drawImage() {}
}

/** 一个元素：够 querySelector('[attr]')、appendChild、事件派发。 */
class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.attributes = new Map()
    this.children = []
    this.parent = null
    this.dataset = {}
    this.style = {}
    this.textContent = ''
    this.innerHTML = ''
    this.listeners = new Map()
    this.context = null
    this.type = ''
    this.files = null
    this.value = ''
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  get parentElement() {
    return this.parent
  }

  get firstChild() {
    return this.children[0] ?? null
  }

  get nextSibling() {
    if (!this.parent) return null
    const index = this.parent.children.indexOf(this)
    return index < 0 ? null : (this.parent.children[index + 1] ?? null)
  }

  appendChild(node) {
    node.parent = this
    this.children.push(node)
    return node
  }

  insertBefore(node, reference) {
    node.parent = this
    const index = this.children.indexOf(reference)
    if (index < 0) this.children.push(node)
    else this.children.splice(index, 0, node)
    return node
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) || []
    list.push(handler)
    this.listeners.set(type, list)
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || []
    this.listeners.set(type, list.filter((entry) => entry !== handler))
  }

  getContext() {
    if (!this.context) {
      this.context = new FakeContext()
      // 测试要检查「画布上真的铺了像素」，所以把每个上下文都记下来。
      ;(globalThis.__fakeContexts ||= []).push(this.context)
    }
    return this.context
  }

  toBlob(callback, type = 'image/png') {
    callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type }))
  }

  /** 只看属性选择器：'[attr]'、'tag[attr]'、'tag[attr="value"]'。 */
  matches(selector) {
    const match = /^([a-zA-Z0-9-]*)\[([a-zA-Z0-9-]+)(?:="([^"]*)")?\]$/.exec(selector)
    if (!match) return false
    const [, tag, attribute, value] = match
    if (tag && this.tagName !== tag.toUpperCase()) return false
    if (!this.attributes.has(attribute)) return false
    return value === undefined || this.attributes.get(attribute) === value
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child
      const nested = child.querySelector(selector)
      if (nested) return nested
    }
    return null
  }

  querySelectorAll(selector) {
    const found = []
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child)
      found.push(...child.querySelectorAll(selector))
    }
    return found
  }
}

/** 一条事件路径：从根到目标，再退回。 */
function pathTo(target) {
  const path = []
  let node = target
  while (node) {
    path.push(node)
    node = node.parent
  }
  return path.reverse()
}

/** 假的 DataTransfer：只关心 items.add 与 types。 */
class FakeDataTransfer {
  constructor() {
    this._files = []
  }

  get items() {
    const self = this
    return {
      add(file) {
        self._files.push(file)
        return file
      },
    }
  }

  get files() {
    return this._files
  }

  get types() {
    return this._files.length > 0 ? ['Files'] : []
  }
}

/** 假事件：带 preventDefault / stopPropagation 的记账。 */
class FakeEvent {
  constructor(type, init = {}) {
    this.type = type
    Object.assign(this, init)
    this.defaultPrevented = false
    this.propagationStopped = false
    this.immediateStopped = false
    this.target = null
  }

  preventDefault() {
    this.defaultPrevented = true
  }

  stopPropagation() {
    this.propagationStopped = true
  }

  stopImmediatePropagation() {
    this.immediateStopped = true
    this.propagationStopped = true
  }
}

/**
 * 装上这套桩，返回测试要用的把手。
 * @returns {{ document: FakeElement, card: FakeElement, dispatched: FakeEvent[], teardown: () => void }}
 */
export function installFakeDom() {
  const document = new FakeElement('#document')
  document.head = new FakeElement('head')
  document.body = new FakeElement('body')
  document.appendChild(document.head)
  document.appendChild(document.body)

  // 真实的 composer 结构：card > row > [加号按钮, 工具按钮…]
  const card = new FakeElement('div')
  card.setAttribute('data-composer-card', '')
  const row = new FakeElement('div')
  const plus = new FakeElement('button')
  plus.setAttribute('aria-haspopup', 'listbox')
  const input = new FakeElement('div')
  input.setAttribute('data-composer-input', '')
  input.setAttribute('contenteditable', 'true')
  row.appendChild(plus)
  row.appendChild(input)
  card.appendChild(row)
  document.body.appendChild(card)

  const dispatched = []

  // 捕获/冒泡派发：document 上的捕获监听先跑，然后才是目标上的监听。
  document.dispatchEvent = (event) => {
    event.target = event.target || document
    const path = pathTo(event.target)
    for (const node of path) {
      for (const handler of node.listeners.get(event.type) || []) {
        if (event.immediateStopped) break
        handler.call(node, event)
      }
      if (event.propagationStopped) break
    }
    return !event.defaultPrevented
  }

  for (const node of [card, row, input]) {
    node.dispatchEvent = (event) => {
      event.target = event.target || node
      const path = pathTo(node)
      for (const current of path) {
        for (const handler of current.listeners.get(event.type) || []) {
          if (event.immediateStopped) break
          handler.call(current, event)
        }
        if (event.propagationStopped) break
      }
      if (event.target === card || event.target === row || event.target === input) dispatched.push(event)
      return !event.defaultPrevented
    }
  }

  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    DataTransfer: globalThis.DataTransfer,
    DragEvent: globalThis.DragEvent,
    ClipboardEvent: globalThis.ClipboardEvent,
    MutationObserver: globalThis.MutationObserver,
    createImageBitmap: globalThis.createImageBitmap,
    Image: globalThis.Image,
    HTMLCanvasElement: globalThis.HTMLCanvasElement,
  }

  globalThis.window = globalThis
  globalThis.document = document
  globalThis.DataTransfer = FakeDataTransfer
  globalThis.DragEvent = FakeEvent
  globalThis.ClipboardEvent = FakeEvent
  globalThis.createImageBitmap = () => Promise.reject(new Error('createImageBitmap stub'))
  globalThis.Image = class {
    set src(_value) {
      queueMicrotask(() => this.onerror?.(new Error('Image stub')))
    }
  }
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.HTMLCanvasElement = FakeElement

  // document 自己的工厂：createElement 只在 document 上有。
  document.createElement = (tag) => new FakeElement(tag)

  return {
    document,
    card,
    dispatched,
    teardown() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key]
        else globalThis[key] = value
      }
    },
  }
}
