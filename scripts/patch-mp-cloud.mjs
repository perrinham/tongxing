/**
 * postbuild（mp-weixin）：把仓库根的 `cloudfunctions/` 复制进小程序项目，并写 cloudfunctionRoot。
 *
 * 为什么是「复制进项目」而不是把 cloudfunctionRoot 指到 `../../..`：
 * 微信开发者工具打开的项目根是 `dist/build/mp-weixin/`，它要求 cloudfunctionRoot 是
 * **项目目录内**的相对路径。仓库根的 cloudfunctions 在项目之外三层，DevTools 不认。
 * 所以这里把云函数目录整体拷到项目内，再声明 `"cloudfunctionRoot": "cloudfunctions/"`。
 *
 * 源仍然是仓库根的 `cloudfunctions/`（唯一源）；这里是生成物，dist/ 已被 .gitignore 忽略。
 * 改完云函数后：`npm run build:mp-weixin`（会自动先跑 cloud:sync-lib 再复制），
 * 然后在 DevTools 里对每个函数「上传并部署：云端安装依赖」。
 */
import { readFileSync, writeFileSync, existsSync, rmSync, cpSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const mpDir = resolve(root, 'dist/build/mp-weixin')
const srcDir = resolve(root, 'cloudfunctions')
const dstDir = resolve(mpDir, 'cloudfunctions')
const configPath = resolve(mpDir, 'project.config.json')

if (!existsSync(mpDir)) {
  console.error('[patch:mp-cloud] 找不到 dist/build/mp-weixin，请先 npm run build:mp-weixin')
  process.exit(1)
}

try {
  // 1) 复制云函数（排除 node_modules / lock：依赖由 DevTools「云端安装依赖」装）
  rmSync(dstDir, { recursive: true, force: true })
  cpSync(srcDir, dstDir, {
    recursive: true,
    filter: (src) => {
      const base = src.split('/').pop()
      if (base === 'node_modules' || base === 'package-lock.json') return false
      // 只拷各函数目录里的 _lib 副本；根级 cloudfunctions/_lib 是「唯一源」，
      // 拷进去会被 DevTools 当成一个云函数目录列出来（它不是函数，别误导上传）。
      if (base === '_lib' && resolve(src, '..') === srcDir) return false
      return true
    }
  })

  // 2) 写 cloudfunctionRoot
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  if (cfg.cloudfunctionRoot === 'cloudfunctions/') {
    console.log('[patch:mp-cloud] cloudfunctionRoot 已就绪，云函数已刷新')
    process.exit(0)
  }
  cfg.cloudfunctionRoot = 'cloudfunctions/'
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  console.log('[patch:mp-cloud] 已复制云函数并写入 cloudfunctionRoot=cloudfunctions/')
} catch (e) {
  console.error('[patch:mp-cloud] 失败:', e.message)
  process.exit(1)
}