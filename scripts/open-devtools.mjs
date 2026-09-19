#!/usr/bin/env node
/**
 * 把构建产物（dist/build/mp-weixin）导进微信开发者工具。
 *
 * 用法：
 *   npm run devtools            # 直接打开
 *   npm run devtools -- --print # 只打印将要执行的命令与前置检查结果，不真的调用
 *
 * ── 为什么要有这个脚本 ──
 * 开发者工具自带的 CLI（`cli open --project <dir>`）比手工点「导入项目」更可靠，
 * 但它有两个不写在帮助里的前置条件，踩过一次就会浪费半小时：
 *
 * 1. **服务端口必须先开**。默认是关的，此时 CLI 只会回一句
 *    「工具的服务端口已关闭」，并不会告诉你该怎么开。
 *    它存在 `~/Library/Application Support/微信开发者工具/<hash>/WeappLocalData/*.json`
 *    的 `security.enableServicePort`。开的方式见下面 SERVICE_PORT_HINT。
 *
 * 2. **CLI 不接受游客 AppID**（`touristappid`）或空 AppID。
 *    这条限制只在工具日志里可见：
 *      [q.formatProject] [automation_game] formatProject reject tourist/empty appid
 *    对外表现成「不存在此 AppID 请检查后重新输入」—— 看起来像是 AppID 填错了，
 *    其实是「游客模式不被 CLI 支持」。
 *    → 没有真实 AppID 时，只能用 GUI 的「导入项目」（游客模式可用）。
 *
 * 这两件事都是「报错信息不以字面意思理解就会查错方向」的典型，所以固化在这里。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DIST = join(ROOT, 'dist', 'build', 'mp-weixin')

const HOME = process.env.HOME || ''
const CLI_CANDIDATES = [
  '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
  '/Applications/微信web开发者工具.app/Contents/MacOS/cli',
  join(HOME, 'Applications/wechatwebdevtools.app/Contents/MacOS/cli')
]

/** 这些 AppID 在 GUI 里是合法的「游客模式」，但 CLI 会直接拒绝 */
const TOURIST_APPIDS = new Set(['', 'touristappid', 'wx6ac3f5090a6b99c5'])

const SERVICE_PORT_HINT = `
开发者工具的「服务端口」默认是关闭的，开一次就会持久化，两种方式二选一：

  A. GUI（推荐，一次点击）
     工具 → 设置 → 安全设置 → 打开「服务端口」

  B. 命令行（适合远程 / 脚本化）
     退出工具后带参数启动一次，它会自己把这项设置写成 true：
       open -a /Applications/wechatwebdevtools.app --args --enable-service-port
     注意：参数只在**冷启动**时生效，对已经运行的实例无效。

开好之后端口号会写进
  ~/Library/Application Support/微信开发者工具/<hash>/Default/.cli
`.trim()

/**
 * 只打印，不执行。--print 与「前置检查没过」两条路径共用，
 * 避免两处各写一遍导致文案漂移。
 */
function report(label, rows) {
  console.log(`\n${label}`)
  for (const [k, v] of rows) console.log(`  ${k.padEnd(10)} ${v}`)
}

const printOnly = process.argv.includes('--print')

// ── 1. 构建产物 ────────────────────────────────────────────────
if (!existsSync(DIST)) {
  console.error(`✖ 找不到构建产物：${DIST}`)
  console.error('  先跑一次构建：npm run build:mp-weixin')
  process.exit(1)
}

const cfgPath = join(DIST, 'project.config.json')
let appid = ''
try {
  appid = String(JSON.parse(readFileSync(cfgPath, 'utf8')).appid || '')
} catch (err) {
  console.error(`✖ 读不出 ${cfgPath}：${err.message}`)
  process.exit(1)
}

// ── 2. 开发者工具 CLI ─────────────────────────────────────────
const cli = CLI_CANDIDATES.find((p) => existsSync(p))
if (!cli) {
  console.error('✖ 没找到微信开发者工具。已找过：')
  for (const p of CLI_CANDIDATES) console.error(`    ${p}`)
  console.error('  从 https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html 安装后重试。')
  process.exit(1)
}

const argv = [cli, 'open', '--project', DIST]
report('将要用开发者工具打开：', [
  ['项目', DIST],
  ['AppID', appid || '(空)'],
  ['CLI', cli],
  ['命令', `"${cli}" open --project "${DIST}"`]
])

// ── 3. 游客 AppID 的硬限制 ────────────────────────────────────
// 放在调用之前判，而不是拿到「不存在此 AppID」再猜 —— 那样会一路怀疑配置。
if (TOURIST_APPIDS.has(appid)) {
  console.log(`
⚠ 当前是游客 AppID（${appid || '空'}），CLI 打不开这个项目。

  工具日志原文：
    [q.formatProject] [automation_game] formatProject reject tourist/empty appid

  也就是说 CLI 的 open 流程在进项目之前就把游客 AppID 挡掉了，
  对外却报成「不存在此 AppID 请检查后重新输入」，很容易误判成 AppID 填错。

  两个选择：

  ① 继续用游客模式（不需要 AppID，功能受限：不能真机调试、微信登录拿不到 openid）
     在已经打开的工具里点「导入项目」，选择：
       ${DIST}
     路径与 AppID 都不用手填，工具会读 project.config.json。

  ② 填一个真实小程序 AppID（推荐，能让真机调试与 openid 账号体系真正跑起来）
     改 src/manifest.json 的 mp-weixin.appid，然后：
       npm run build:mp-weixin && npm run devtools
`)
  process.exit(2)
}

if (printOnly) {
  console.log('\n(--print：未真的调用 CLI)')
  process.exit(0)
}

// ── 4. 真正调用 ───────────────────────────────────────────────
// `cli open` 在没有服务端口时会退化成一句「服务端口已关闭」，
// 这里在输出里认这个词，补上「怎么开」——否则用户只知道失败了、不知道下一步。
const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
const onChunk = (buf) => {
  const text = buf.toString()
  out += text
  process.stdout.write(text)
}
child.stdout.on('data', onChunk)
child.stderr.on('data', onChunk)

child.on('error', (err) => {
  console.error(`✖ 启动 CLI 失败：${err.message}`)
  process.exit(1)
})

child.on('close', (code) => {
  const servicePortOff = /service port disabled|服务端口已关闭/.test(out)
  if (servicePortOff) {
    console.error(`\n✖ ${SERVICE_PORT_HINT}`)
    process.exit(3)
  }
  if (/不存在此 AppID|not exist/i.test(out)) {
    console.error(`
✖ 工具说「不存在此 AppID」。除了 AppID 真的写错，还有一个常见原因是它其实是
  游客 AppID —— CLI 对这种情况也报同一句话（见本文件顶部注释）。`)
    process.exit(4)
  }
  if (code !== 0) {
    console.error(`\n✖ 开发者工具返回退出码 ${code}`)
    process.exit(code || 1)
  }
  console.log('\n✔ 项目已在微信开发者工具中打开。')
  console.log('  若页面请求后端失败，确认后端在跑：npm run server')
  console.log('  工具的「详情 → 本地设置」里勾上「不校验合法域名」即可直连 localhost。')
})
