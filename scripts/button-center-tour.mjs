#!/usr/bin/env node
/**
 * 按钮居中修复后的视觉巡回：冷启动 → 登录 → 逐页截图。
 * 产出 *.png 到 /tmp opencode 目录，人工目检新补 flex 居中的按钮。
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
const OUT = '/var/folders/jz/twlnnqdd1kl48rhd0k4y710h0000gn/T/opencode/'

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

const stops = [
  ['pages/WelcomePage', 'welcome'],
  ['pages/SyncPage', 'sync'],
  ['pages/ProfilePage', 'profile'],
  ['pages/TripCreatePage', 'tripcreate'],
  ['pages/ItineraryPage', 'itinerary'],
  ['pages/ExpenseEditPage', 'expenseedit'],
  ['pages/SettlePage', 'settle'],
  ['pages/CityMapPage?name=成都', 'citymap'],
  ['pages/MyGuidesPage', 'myguides'],
  ['pages/ItemEditPage', 'itemedit']
]

async function main() {
  const health = await fetch(BASE + '/api/health')
  if (health.status !== 200) throw new Error('后端不在线')
  try {
    execSync('pkill -9 -f wechatwebdevtools', { stdio: 'ignore' })
  } catch {}
  await sleep(2000)
  mp = await automator.launch({ cliPath: CLI, projectPath: PROJECT, timeout: 120000 })
  await until(async () => (await pagePath()) !== '', 60000, '小程序启动')
  await mp.callWxMethod('clearStorageSync')

  // 登录（保证行程页有数据）
  await mp.reLaunch('/pages/SyncPage')
  const loginPage = await waitRoute('pages/SyncPage', 90000)
  await mp.mockWxMethod('login', { code: CODE, errMsg: 'login:ok' })
  const loginBtn = await findButton(loginPage, '微信登录')
  if (loginBtn) {
    await loginBtn.tap()
    await until(async () => {
      const raw = JSON.stringify(await mp.callWxMethod('getStorageSync', 'travel_sync_v1'))
      return raw.includes('openid')
    }, 15000, '登录完成')
  }

  // 建行程（行程相关页才有数据）
  await mp.reLaunch('/pages/TripCreatePage')
  const createPage = await waitRoute('pages/TripCreatePage', 90000)
  const createBtn = await findButton(createPage, '生成行程草稿')
  if (createBtn) {
    await createBtn.tap()
    const genPage = await waitRoute('pages/TripGeneratePage')
    const startBtn = await findButton(genPage, '开始生成')
    await startBtn.tap()
    await waitRoute('pages/ItineraryPage', 60000)
  }

  for (const [path, name] of stops) {
    try {
      await mp.reLaunch('/' + path)
      const page = await waitRoute(path.split('?')[0], 30000)
      const shot = OUT + 'tour-' + name + '.png'
      await mp.screenshot({ path: shot })
      console.log('✓', name, '→', shot)
    } catch (e) {
      console.log('✗', name, String(e?.message || e).slice(0, 100))
    }
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
  console.error('巡回失败：', e)
  process.exit(1)
})
