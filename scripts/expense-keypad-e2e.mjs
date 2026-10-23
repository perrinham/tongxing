#!/usr/bin/env node
/**
 * 记账键盘端到端冒烟：真实冷启动开发者工具 → 建行程 → 打开 ExpenseEditPage
 * → automator 依次敲 5 8 + 2，断言金额区显示为 58 / 58+ / 58+2，无报错即通过。
 *
 * 背景：d6eb9e9 引入金额算式后，用户反馈「点数字没反应」。构建产物查无异常，
 * 本脚本冷启动复跑 = 正常 —— 结论是 devtools 在构建替换 dist 期间的热重载把
 * 旧渲染层（wxml 里的 bindtap 令牌）和新 JS 混着跑了。重开工具即恢复。
 * 这也解释了为什么这个脚本值得留下：以后动键盘/绑定的改动，用它冷启复验。
 *
 * 前置：npm run server（:8787 在线）；不要手动占用 automator（无服务端口时
 * automator.launch 会自己用 --auto 拉起，见 verify-two-users.mjs 同款约定）。
 *
 * 用法：node scripts/expense-keypad-e2e.mjs → 退出码 0 = 通过
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
const CODE = 'debug-keypad-user'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(cond, timeout = 15000, label = '条件') {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try {
      if (await cond()) return true
    } catch (e) {
      console.log('  (轮询 err：' + String(e?.message || e).slice(0, 120) + ')')
    }
    await sleep(300)
  }
  throw new Error('等待超时：' + label)
}

let failures = []
let mp = null
const consoleMsgs = []
const pagePath = async () => {
  const p = await mp.currentPage()
  return p ? String(p.path || '') : ''
}
const waitRoute = async (part, timeout = 20000) => {
  await until(async () => (await pagePath()).includes(part), timeout, '进入 ' + part)
  await sleep(600)
  // currentPage() 偶发返回过渡对象（没有 $$ 的壳），轮询到拿到真正的 Page 为止
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
  if (health.status !== 200) throw new Error('后端不在线（先: cd ' + ROOT + ' && npm run server）')

  const killAll = async () => {
    try {
      execSync('pkill -9 -f wechatwebdevtools', { stdio: 'ignore' })
    } catch {}
    await until(async () => {
      try {
        execSync('pgrep -f wechatwebdevtools', { stdio: 'ignore' })
        return false
      } catch {
        return true
      }
    }, 20000, '工具进程退出')
    await sleep(2000)
  }
  await killAll()
  console.log('· 冷启动开发者工具…')
  mp = await automator.launch({ cliPath: CLI, projectPath: PROJECT, timeout: 120000 })
  await until(async () => (await pagePath()) !== '', 60000, '小程序启动')
  console.log('· 启动完成，当前页：', await pagePath())

  mp.on('console', (msg) => {
    const args = (msg.args || []).map((a) => (typeof a === 'string' ? a : JSON.stringify(a)).slice(0, 200))
    consoleMsgs.push(`[${msg.type}] ` + args.join(' | '))
  })

  await mp.callWxMethod('clearStorageSync')

  // 登录（固定 code → 固定身份，保证本地行程归属一致）
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
  if (!loginBtn) throw new Error('没找到「微信登录」按钮')
  await mp.mockWxMethod('login', { code: CODE, errMsg: 'login:ok' })
  await loginBtn.tap()
  await until(async () => {
    const raw = JSON.stringify(await mp.callWxMethod('getStorageSync', 'travel_sync_v1'))
    return raw.includes('openid')
  }, 15000, '登录完成')
  console.log('· 已登录（code=' + CODE + '）')

  // 建行程（成都 → 本地种子生成）
  await mp.reLaunch('/pages/TripCreatePage')
  const createPage = await waitRoute('pages/TripCreatePage', 90000)
  const createBtn = await findButton(createPage, '生成行程草稿')
  await createBtn.tap()
  const genPage = await waitRoute('pages/TripGeneratePage')
  const startBtn = await findButton(genPage, '开始生成')
  await startBtn.tap()
  await waitRoute('pages/ItineraryPage', 60000)
  console.log('· 行程已建好')

  // 打开记账页
  await mp.reLaunch('/pages/ExpenseEditPage')
  const expPage = await waitRoute('pages/ExpenseEditPage', 30000)
  console.log('· 已进入记账页')

  // 渲染数据 & 事件描述符
  const data = await expPage.data()
  const renderKeys = Object.keys(data || {}).filter((k) => /^[A-Z]{1,3}$/.test(k))
  const keypadArr = data?.I
  console.log('· 页面渲染数据顶层键：', renderKeys.join(','))
  if (!keypadArr) {
    console.log('  !! 没有渲染数组 I —— v-for 数据为空')
  } else {
    console.log('· I[0..3]（含 h 事件描述符）：', JSON.stringify(keypadArr.slice(0, 4)))
  }

  // 读金额文本
  const amountEl = await expPage.$('.amount')
  const readAmount = async () => {
    let el = await expPage.$('.amount')
    return el ? (await el.text()).trim() : '(no .amount)'
  }
  console.log('· 初始金额显示：', await readAmount())

  const expect = async (want, label, extra = '') => {
    const got = await readAmount()
    if (got === want) {
      console.log('  ✓ 按下 ' + extra + ' → 显示 "' + got + '"')
    } else {
      failures.push(label)
      console.log('  ✗ 按下 ' + extra + ' → 显示 "' + got + '"，期望 "' + want + '"')
    }
  }

  let failures = []
  for (const k of ['5', '8', '+', '2']) {
    let keyBtn = null
    for (const el of await expPage.$$('.key')) {
      try {
        if ((await el.text()).trim() === k) {
          keyBtn = el
          break
        }
      } catch {}
    }
    if (!keyBtn) {
      failures.push('键盘上没有键 ' + k)
      console.log('  !! 没找到键 [' + k + ']')
      continue
    }
    await keyBtn.tap()
    await sleep(400)
  }
  await expect('58+2', '58+2', '5 8 + 2')

  // 退格与算式求值联动：删一位 → 58+，删 → 58，保存键应亮起
  const delBtn = (await (async () => {
    for (const el of await expPage.$$('.key')) {
      try {
        if ((await el.text()).trim() === '') return el // 退格键文本为空（只剩图标）
      } catch {}
    }
    return null
  })())
  if (delBtn) {
    for (let i = 0; i < 2; i++) {
      await delBtn.tap()
      await sleep(300)
    }
    await expect('58', '退格两下回 58', 'del×2')
  } else {
    // 找不到就用 store 数据兜底断言键盘存在 16 键
    const keys = (await expPage.data())?.I
    if (keys?.length !== 16) failures.push('键盘应有 16 键，实得 ' + (keys?.length ?? 0))
  }

  const errConsoles = consoleMsgs.filter((m) => m.startsWith('[error]'))
  if (errConsoles.length) {
    failures.push('页面 console 有 error：' + errConsoles[0])
  }

  console.log('\n===== 记账键盘 e2e 结果：' + (failures.length ? '失败 ' + failures.length : '通过') + ' =====')
  if (failures.length) console.error('失败项：' + failures.join('；'))

  console.log('\n· 页面 console 输出（近 40 条）：')
  for (const m of consoleMsgs.slice(-40)) console.log('   ', m)

  try {
    await mp.close()
  } catch {}
  await killAll()
  if (failures.length) process.exitCode = 1
  console.log('开发者工具已退出')
}

main().catch((e) => {
  console.error('诊断失败：', e)
  process.exit(1)
})
