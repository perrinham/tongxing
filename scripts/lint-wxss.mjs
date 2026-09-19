#!/usr/bin/env node
/**
 * 用微信官方的 WXSS 编译器校验小程序产物样式。
 *
 * 为什么需要它：WXSS 不是 CSS 的子集那么简单，它**会拒绝**一些完全合法的 CSS 写法，
 * 而开发者工具只会甩出一句「编译 .wxss 文件错误，错误信息如上，可在控制台查看更详细信息」——
 * 不给文件名、不给行列号，细节只落在模拟器控制台里。等你在工具里看到这句话再回头找，
 * 就得把二十来个 wxss 翻一遍。
 *
 * 已知会被拒的写法（都用 wcsc 实测过）：
 *   · 通用选择器 `*`            → unexpected token `*`
 *   · 子代 + 通用 `.a > *`      → error at token `*`
 * 而以下写法**是合法**的（别误删）：
 *   · `@media (prefers-reduced-motion: reduce)` —— 媒体特性本身没问题，出错的是里面的 `*`
 *   · 属性选择器 `[data-x="y"]`、`.a[disabled]`
 *   · `::-webkit-scrollbar` / `::placeholder` / `:nth-child(n+6)` / CSS 变量 / `env()`
 *   · `select` 等标签选择器（uni-app 会警告，但编译器接受）
 *
 * 编译器是开发者工具自带的原生二进制（wcc-exec/wcsc），不需要 npm 依赖。
 * 找不到工具时**只提示、不算失败** —— 免得没装工具的环境跑不了 `npm run verify`。
 *
 * 用法：
 *   npm run wxss:lint
 *   WCSC=/path/to/wcsc npm run wxss:lint      # 手动指定编译器
 *   node scripts/lint-wxss.mjs --dir dist/build/h5
 */
import { existsSync, readdirSync, statSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'

const CANDIDATES = [
  process.env.WCSC,
  '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec/wcsc',
  '/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-electron/build/Release/wcsc',
  // Windows
  'C:/Program Files (x86)/Tencent/微信web开发者工具/code/package.nw/node_modules/wcc-exec/wcsc.exe',
  'C:/Program Files/Tencent/微信web开发者工具/code/package.nw/node_modules/wcc-exec/wcsc.exe'
].filter(Boolean)

const args = process.argv.slice(2)
const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : 'dist/build/mp-weixin'
const root = resolve(process.cwd(), dirArg)

const wcsc = CANDIDATES.find((p) => existsSync(p))
if (!wcsc) {
  console.log('[wxss:lint] 未找到微信开发者工具的 WXSS 编译器，跳过。')
  console.log('           装了开发者工具还这样，就用 WCSC=/path/to/wcsc 手动指定。')
  process.exit(0)
}
if (!existsSync(root)) {
  console.error(`[wxss:lint] 目录不存在：${root}\n           先跑一次构建（npm run build:mp-weixin）。`)
  process.exit(1)
}

/** 递归收集所有 .wxss（跳过 node_modules，产物里本来也不会有） */
function collect(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...collect(p))
    else if (name.endsWith('.wxss')) out.push(p)
  }
  return out
}

const files = collect(root).sort()
const outFile = join(mkdtempSync(join(tmpdir(), 'wxss-lint-')), 'out.wxss')

let failed = 0
const failures = []

for (const file of files) {
  let out = ''
  try {
    // 逐个文件单独编译：一次编译多个文件时，编译器报出第一个错误就收工，
    // 会把后面文件的问题一起藏起来。
    out = execFileSync(wcsc, ['-lc', '-o', outFile, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '')
  }
  if (out.includes('ERR')) {
    failed += 1
    failures.push({ file: relative(root, file), detail: out.trim() })
  }
}

if (!failed) {
  console.log(`[wxss:lint] ${files.length} 个 wxss 全部通过（编译器：${wcsc}）`)
  process.exit(0)
}

console.error(`[wxss:lint] ${failed}/${files.length} 个文件编译失败：\n`)
for (const f of failures) {
  console.error(`  ✗ ${f.file}`)
  for (const line of f.detail.split('\n')) {
    if (!line.trim()) continue
    console.error(`      ${line.replace(root + '/', '')}`)
  }
}
console.error(
  '\n提示：WXSS 最常见的坑是通用选择器 `*`（含 `.a > *`）。' +
    '\n      这段 CSS 的来源可能不在本文件里 —— 检查 @import 与全局样式。'
)
process.exit(1)
