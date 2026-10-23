#!/usr/bin/env node
/**
 * 诊断：TripGeneratePage 流式卡在生成过程中处于视口的哪个位置。
 * 复用 keypad-e2e 冷启动套路，点「开始生成」后立刻测 .stream 的 offset() 与屏高。
 */
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import automator from 'miniprogram-automator'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PROJECT = join(ROOT, 'dist', 'build', 'mp-weixin')
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const BASE = 'http://localhost:8787'
const CODE = 'debug-capture-user'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(cond, timeout = 15000, label = '条件') {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try {
      if (await cond()) return true
    } catch { /* 重试 */ }
    await sleep(300)
  }
  throw new Error('等待超时：' + label)
}

let mp = null
const pagePath = async () => {
  const p = await mp.currentPage()
  return p ? String(p.path || '') : ''
}
const waitRoute = async (part, timeout = 20000) => {
  await until(async () => (await pagePath()).includes(part), timeout, '进入 ' + part)
  await sleep(600)
  let page = null
  await until(async () => {
    page = await mp.currentPage()
    return !!page && typeof page.$$ === 'function'
  }, 15000, '拿到可用 Page 对象')
  return page
}
const findButton = async (page, text) => {
  for (const el of await page.$$('button')) {
    try {
      if ((await el.text()).trim() === text) return el
    } catch {}
  }
  return null
}

async function main() {
  const health = await fetch(BASE + '/api/health')
  if (health.status !== 200) throw new Error('后端不在线')

  const killAll = async () => {
    try {
      execSync('pkill -9 -f wechatwebdevtools', { stdio: 'ignore' })
    } catch {}
    await until(async () => {
      try {
        execSync('pgrep -f wechatwebdevtools', { stdio: 'ignore' })
        return false
      } catch { return true }
    }, 20000, '工具进程退出')
    await sleep(2000)
  }
  await killAll()
  mp = await automator.launch({ cliPath: CLI, projectPath: PROJECT, timeout: 120000 })
  await until(async () => (await pagePath()) !== '', 60000, '小程序启动')

  await mp.callWxMethod('clearStorageSync')
  await mp.reLaunch('/pages/SyncPage')
  const loginPage = await waitRoute('pages/SyncPage', 90000)
  const logoutBtn = await findButton(loginPage, '退出登录')
  if (logoutBtn) {
    await logoutBtn.tap()
    await sleep(1000)
    await waitRoute('pages/SyncPage', 90000)
  }
  const curPage = await waitRoute('pages/SyncPage', 90000)
  const loginBtn = await findButton(curPage, '微信登录')
  await mp.mockWxMethod('login', { code: CODE, errMsg: 'login:ok' })
  await loginBtn.tap()
  await until(async () => {
    const raw = JSON.stringify(await mp.callWxMethod('getStorageSync', 'travel_sync_v1'))
    return raw.includes('openid')
  }, 15000, '登录完成')

  await mp.reLaunch('/pages/TripCreatePage')
  const createPage = await waitRoute('pages/TripCreatePage', 90000)
  await (await findButton(createPage, '生成行程草稿')).tap()
  const genPage = await waitRoute('pages/TripGeneratePage')

  const sys = await mp.callWxMethod('getSystemInfoSync')
  const winH = sys.windowHeight
  console.log('· 视口高：', winH)

  const btn = await findButton(genPage, '开始生成')
  await btn.tap()

  // 点完立刻轮测流式卡的几何（生成在 120ms 后才开跑，赶得上第一帧）
  const t0 = Date.now()
  for (const at of [200, 450, 800]) {
    const wait = at - (Date.now() - t0)
    if (wait > 0) await sleep(wait)
    const stream = await genPage.$('.stream')
    if (!stream) {
      console.log(`· [${at}ms] .stream 还没出现在渲染树`)
      continue
    }
    const off = await stream.offset()
    const size = await stream.size()
    console.log(`· [${at}ms] .stream top=${off.top} height=${size.height} ${off.top >= winH ? '← 视口外！' : '（视口内）'}`)
    // 正在打的行（当前落点）也在哪
    const typing = await genPage.$('.gl-line.typing')
    if (typing) {
      const toff = await typing.offset()
      console.log(`  · [${at}ms] typing 行 top=${toff.top} ${toff.top >= winH ? '← 视口外！' : ''}`)
    }
  }
  const shot = '/var/folders/jz/twlnnqdd1kl48rhd0k4y710h0000gn/T/opencode/gen-viewport.png'
  try {
    await mp.screenshot({ path: shot })
    console.log('· 截图：', shot)
  } catch (e) {
    console.log('· 截图失败：', String(e?.message || e).slice(0, 100))
  }

  try {
    await mp.close()
  } catch {}
  await sleep(1000)
  try {
    execSync('pkill -9 -f wechatwebdevtools', { stdio: 'ignore' })
  } catch {}
}

main().catch((e) => {
  console.error('诊断失败：', e)
  process.exit(1)
})
