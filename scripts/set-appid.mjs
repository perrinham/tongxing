#!/usr/bin/env node
/**
 * 切换小程序 AppID（写进 src/manifest.json 的 mp-weixin.appid）。
 *
 * 用法：
 *   npm run appid -- wx1234567890abcdef      # 写入
 *   npm run appid                            # 只显示当前值
 *
 * 为什么要有这个小脚本：
 * AppID 在项目里其实只该有**一个**权威位置 —— `src/manifest.json`。
 * `dist/build/mp-weixin/project.config.json` 里的那份是构建时生成的，
 * 手改它会在下一次构建被覆盖（本轮就踩过：为排查问题临时置空，随即发现
 * 根本没走到取值这一步，白改一次）。所以这里只改源头。
 *
 * 顺带把「游客模式」和「真实 AppID」的区别说清楚，因为两者行为差别很大：
 *   touristappid  → 能跑界面，但 CLI 打不开、不能真机调试、uni.login 拿不到可用 openid
 *   wx...（真实） → 全部能力可用，需要在服务端配 WX_APPID / WX_SECRET
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MANIFEST = resolve(__dirname, '..', 'src', 'manifest.json')

const TOURIST_APPID = 'touristappid'
/** 真实 AppID：wx + 16 位十六进制。宽一点也接受，避免把合法值拒之门外 */
const APPID_RE = /^wx[0-9a-f]{16}$/i

const raw = readFileSync(MANIFEST, 'utf8')
const manifest = JSON.parse(raw)
const next = process.argv[2]

if (!next) {
  const cur = manifest['mp-weixin']?.appid || manifest.appid || ''
  console.log(`当前 AppID：${cur || '(空)'}`)
  console.log(
    cur === TOURIST_APPID
      ? '  → 游客模式：能跑界面，但 CLI 打不开、不能真机调试、登录拿不到 openid'
      : '  → 真实 AppID：全部能力可用（服务端需配 WX_APPID / WX_SECRET）'
  )
  console.log('\n写入方式：npm run appid -- wx1234567890abcdef')
  process.exit(0)
}

if (next !== TOURIST_APPID && !APPID_RE.test(next)) {
  console.error(`✖ AppID 形态不对：${next}`)
  console.error('  真实 AppID 形如 wx + 16 位十六进制；要用游客模式请显式传 touristappid')
  process.exit(1)
}

const section = manifest['mp-weixin']
if (!section) {
  console.error('✖ src/manifest.json 里没有 mp-weixin 段，请先确认项目结构')
  process.exit(1)
}

const before = section.appid
section.appid = next
// 顶层 appid 也要同步：uni 某些平台会读它，留着旧值会让两端不一致
if (manifest.appid !== undefined) manifest.appid = next

writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

console.log(`✔ AppID 已更新：${before || '(空)'} → ${next}`)
console.log(`  写入位置：${MANIFEST}（mp-weixin.appid 与顶层 appid）`)
console.log('')
console.log('下一步：')
console.log('  npm run devtools:build      # 重新构建并导进开发者工具')
if (next !== TOURIST_APPID) {
  console.log('  并确认服务端已配 WX_APPID / WX_SECRET（否则 /api/auth/wx 回 503，登录仍不可用）')
} else {
  console.log('  游客模式只能用 GUI 的「导入项目」打开，CLI 会拒绝（见 scripts/open-devtools.mjs）')
}
