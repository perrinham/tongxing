/**
 * 把 `cloudfunctions/_lib/*.js` 同步到每个云函数目录下的 `_lib/` 副本。
 *
 * 为什么需要这一步：微信云开发上传云函数时**按函数目录打包**，函数里 `require('../_lib/..')`
 * 这种「跨函数目录」的相对路径在云端不存在（上传只带该函数自己的目录）。所以共享库必须
 * 物理复制进每个函数目录。
 *
 * 唯一源：`cloudfunctions/_lib/`（与 server/lib/*.mjs、src/services/*.ts 构成孪生文件链，
 * 见各文件头的说明）。**各函数目录里的副本是生成物，不要手改** —— 改完源文件后跑：
 *   npm run cloud:sync-lib
 *
 * 建议在每次改动 _lib 后、以及上传云函数前执行。
 */
import { readdirSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const libDir = resolve(root, 'cloudfunctions/_lib')
const FUNCTIONS = ['auth', 'trips', 'guides', 'weather', 'migrate']

/** 生成物头部加一行「勿手改」标记（源文件不带，便于区分） */
const BANNER = '// ⚠️ 生成物，勿手改 —— 源：cloudfunctions/_lib/%s（npm run cloud:sync-lib 生成）\n'

let copied = 0
try {
  const files = readdirSync(libDir).filter((f) => f.endsWith('.js'))
  if (!files.length) {
    console.error('[cloud:sync-lib] cloudfunctions/_lib 下没有 .js 文件')
    process.exit(1)
  }
  for (const fn of FUNCTIONS) {
    const target = resolve(root, 'cloudfunctions', fn, '_lib')
    mkdirSync(target, { recursive: true })
    for (const f of files) {
      const src = join(libDir, f)
      const body = readFileSync(src, 'utf8')
      const out = BANNER.replace('%s', f) + body
      writeFileSync(join(target, f), out, 'utf8')
      copied += 1
    }
    console.log(`[cloud:sync-lib] ${fn}/_lib  <- ${files.length} 个文件`)
  }
  console.log(`[cloud:sync-lib] 完成，共 ${copied} 个副本`)
} catch (e) {
  console.error('[cloud:sync-lib] 失败:', e.message)
  process.exit(1)
}