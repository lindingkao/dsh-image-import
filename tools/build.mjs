/**
 * 把 src/ 下的模块拼成 client.js。
 *
 * DSH 的 web bundle 以普通脚本执行（`window.__ModuleLoader__.load`），不能有
 * `import`/`export`，所以这里做的是「去模块语法 + 内联」，而不是真正的打包。
 *
 * 用法：node tools/build.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE = join(ROOT, 'src', 'client-entry.js')
const OUTPUT = join(ROOT, 'client.js')

/**
 * 去掉 ESM 语法：保留声明本身，只丢掉 `export` 关键字和 `export { ... }` 语句。
 * @param {string} source - 模块源码。
 * @returns {string} 可直接内联的脚本片段。
 */
function stripModuleSyntax(source) {
  return source
    .replace(/^export\s+(?=(?:async\s+)?function|const|let|var|class|default)/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/^import\s+.*$/gm, '')
}

const template = readFileSync(TEMPLATE, 'utf8')
// `$` 在 String.replace 的替换串里有特殊含义，模板里的代码含 `$`，所以用函数形式。
const built = template.replace(/\/\* @@INLINE:(.+?)@@ \*\//g, (_match, relative) => {
  const file = join(ROOT, relative)
  const body = stripModuleSyntax(readFileSync(file, 'utf8'))
  return `// ---------- ${relative} ----------\n${body.trim()}\n`
})

if (/^\s*(import|export)\s/m.test(built)) {
  const offending = built.split('\n').find((line) => /^\s*(import|export)\s/.test(line))
  throw new Error(`client.js 里残留模块语法：${offending}`)
}

// 语法体检：能构造出函数体就说明没写坏（不执行）。
try {
  new Function(built)
} catch (error) {
  throw new Error(`client.js 语法错误：${error.message}`)
}

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, built, 'utf8')
console.log(`client.js 已生成：${(built.length / 1024).toFixed(1)} KB`)
