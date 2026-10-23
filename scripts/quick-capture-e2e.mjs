#!/usr/bin/env node
/**
 * 「快抄」两面板端到端冒烟：汇率折算（ExpenseEditPage）+ 避雷清单（ItineraryPage）。
 *
 * 复用 expense-keypad-e2e.mjs 的整套冷启动模式：pkill wechatwebdevtools →
 * automator.launch(dist/build/mp-weixin) → clearStorageSync → mock login →
 * TripCreatePage→TripGeneratePage→ItineraryPage 建行程，然后一个冷启动里跑两幕：
 *
 *   ① 汇率面板：数字快抄「汇率」入口 → 选 JPY → 敲 1000 → 结果应显示 ¥48
 *     （fx.ts 静态表 1 JPY ≈ 0.048¥，两位小数口径）→ 点「记 ¥48」→
 *     金额缓冲被【替换】为 48（不是追加 —— replace 语义是 d066.. 换算链的根目的）。
 *   ② 避雷面板：行程页「避雷」行 → 空态文案 → 输入一条「记下」→ 行出现且带署名
 *     （who = 添加当时的 self 成员名）→ 再加一条 → 删头一条 → 剩 1 条且是后者。
 *
 * 背景：面板都是 AppSheet 弹层 + v-model input；automator 的 el.input() 会派发
 * 真实 input 事件，v-model 能吃到。断言一律读渲染树文本（el.text()），不偷看内部 JSON。
 *
 * 前置：npm run server（:8787 在线）；工具不要手动占用（无服务端口时 launch 自带 --auto）。
 * 用法：node scripts/quick-capture-e2e.mjs → 退出码 0 = 通过
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
// 固定 code → 固定身份，两次复跑同一用户，本地行程归属一致
const CODE = 'debug-capture-user'

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

let mp = null
let failures = []
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
/** 按可见文本找按钮（页面上逐个 el.text() 比对，含子元素拼接的整段文本） */
const findButton = async (page, text, { contains = false, selector = 'button' } = {}) => {
  for (const el of await page.$$(selector)) {
    try {
      const t = (await el.text()).trim()
      if (t === text || (contains && t.includes(text))) return el
    } catch {}
  }
  return null
}
const mark = (ok, label, detail = '') => {
  if (ok) console.log('  ✓ ' + label + (detail ? ' —— ' + detail : ''))
  else {
    failures.push(label + (detail ? '（' + detail + '）' : ''))
    console.log('  ✗ ' + label + (detail ? ' —— ' + detail : ''))
  }
}

async function bootAndLogin() {
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
}

async function createTrip() {
  // 成都 → 本地种子生成（同步快链路）
  await mp.reLaunch('/pages/TripCreatePage')
  const createPage = await waitRoute('pages/TripCreatePage', 90000)
  const createBtn = await findButton(createPage, '生成行程草稿')
  await createBtn.tap()
  const genPage = await waitRoute('pages/TripGeneratePage')
  const startBtn = await findButton(genPage, '开始生成')
  await startBtn.tap()
  await waitRoute('pages/ItineraryPage', 60000)
  console.log('· 行程已建好')
}

/** 幕 ①：汇率面板 —— 1000 JPY 折 ¥48，一键替换金额缓冲 */
async function phaseFx() {
  console.log('\n—— 幕 ① 汇率面板 ——')
  await mp.reLaunch('/pages/ExpenseEditPage')
  const page = await waitRoute('pages/ExpenseEditPage', 30000)
  const readAmount = async () => {
    const el = await page.$('.amount')
    return el ? (await el.text()).trim() : '(no .amount)'
  }
  console.log('· 初始金额显示：', await readAmount())

  const fxEntry = await findButton(page, '汇率', { contains: true })
  if (!fxEntry) return mark(false, '快抄行有「汇率」入口')
  await fxEntry.tap()
  await until(async () => !!(await page.$('.fx-grid')), 8000, '汇率面板打开')

  const jpyChip = await findButton(page, 'JPY', { contains: true, selector: '.fx-chip' })
  if (!jpyChip) return mark(false, '币种格里有 JPY 芯片')
  await jpyChip.tap()
  await sleep(400)

  // 敲外币金额（v-model input：automator 的 input() 派发真实 input 事件）
  const fxInput = await page.$('.fx-input')
  if (!fxInput) return mark(false, '面板里有外币输入框')
  await fxInput.input('1000')
  await until(async () => !!(await page.$('.fx-out')), 8000, '折算结果行出现')

  const fxOut = (await (await page.$('.fx-out')).text()).trim()
  // 1000 × 0.048 = 48；money() 整数不带小数、无空格拼符号
  mark(fxOut === '¥48', '1000 JPY → ¥48', '实得 "' + fxOut + '"')

  const fxCap = (await (await page.$('.fx-cap')).text()).trim()
  mark(fxCap === '1 JPY ≈ ¥0.05', '汇率条口径', '实得 "' + fxCap + '"')

  // 面板里的算式链路：清了改敲 500×2，结果同是 ¥48（小票上 10% 服务费那类场景）
  await fxInput.input('500×2')
  await sleep(600)
  const fxOut2 = (await (await page.$('.fx-out')).text()).trim()
  mark(fxOut2 === '¥48', '算式 500×2 同样折 ¥48', '实得 "' + fxOut2 + '"')

  const applyBtn = await page.$('.fx-apply')
  const applyText = (await applyBtn.text()).trim()
  mark(applyText === '记 ¥48', 'apply 钮文本带折算值', '实得 "' + applyText + '"')
  await applyBtn.tap()

  // 点「记」之后：金额被替换成 48（不是在旧缓冲后面拼）。
  // ⚠️ 不做「面板关闭 / 缓冲清空」的 absence 断言：automator 的 page.$ 对
  // wx:if 已卸载的节点仍可查询（实测面板已关、金额已换，$ 仍命中 fx-grid，
  // 截图佐证）—— 不存在类断言在这里不可证伪，只有正面计数/文本可信。
  await until(async () => (await readAmount()) === '48', 8000, '金额被替换为 48')
  mark(true, '金额缓冲被替换为 48', '实得 "' + (await readAmount()) + '"')
}

/** 幕 ②：避雷面板 —— 记坑署名、加两条删一条 */
async function phaseAvoid() {
  console.log('\n—— 幕 ② 避雷清单面板 ——')
  await mp.reLaunch('/pages/ItineraryPage')
  const page = await waitRoute('pages/ItineraryPage', 30000)

  const avoidRow = await findButton(page, '避雷', { contains: true })
  if (!avoidRow) return mark(false, '行程页有「避雷」入口行')
  await avoidRow.tap()
  await until(async () => !!(await page.$('.avoid-empty')), 8000, '避雷面板打开（空态）')

  const emptyText = (await (await page.$('.avoid-empty')).text()).trim()
  mark(emptyText.includes('谁踩过谁记'), '空态文案在', '实得 "' + emptyText.slice(0, 24) + '…"')

  // 记第一条：输入 → 「记下」 → 行出现且署名（who = 添加当时的 self 成员名）。
  // ⚠️ 行李与避雷两个面板共用 pack-* 类，且已卸载节点仍会被 query 命中——
  //   输入框按 placeholder 挑、按钮按文本挑（避雷「记下」/ 行李「添上」）、
  //   删除钮在 .avoid-row 作用域内查，绝不裸 page.$('.pack-*')。
  const pickAvoidInput = async () => {
    for (const el of await page.$$('.pack-input')) {
      try {
        if ((await el.attribute('placeholder')).includes('哪条坑')) return el
      } catch {}
    }
    return null
  }
  const avoidInput = await pickAvoidInput()
  if (!avoidInput) return mark(false, '避雷面板里有输入框')
  await avoidInput.input('太平街假唱摊别买')
  await sleep(500)
  mark((await avoidInput.attribute('value')) === '太平街假唱摊别买', '输入进 v-model', 'value="' + (await avoidInput.attribute('value')) + '"')
  const addBtn = await findButton(page, '记下')
  if (!addBtn) return mark(false, '找到「记下」按钮')
  await addBtn.tap()
  await until(async () => !!(await page.$('.avoid-row')), 8000, '第一条避雷行出现')

  const row1 = await page.$('.avoid-row')
  const title1 = (await (await row1.$('.avoid-title')).text()).trim()
  mark(title1.includes('太平街假唱摊别买'), '第一条入列', '实得 "' + title1 + '"')
  const whoEl = await row1.$('.avoid-who')
  const who = whoEl ? (await whoEl.text()).trim() : ''
  mark(/^· .+/.test(who), '署名非空（who = 添加当时的成员名）', '实得 "' + who + '"')

  // 再记一条 → 第二条在列表末尾出现
  const avoidInput2 = await pickAvoidInput()
  await avoidInput2.input('橘子洲五点停止入园')
  await (await findButton(page, '记下')).tap()
  await until(async () => {
    const rows = await page.$$('.avoid-row')
    if (rows.length < 2) return false
    const lastTitle = await (await rows[rows.length - 1].$('.avoid-title')).text()
    return lastTitle.includes('橘子洲五点停止入园')
  }, 8000, '第二条避雷行入列')
  mark(true, '第二条入列（共 2 条）')

  // 删头一条 → 首行变为后进的（顺序保留；行数靠缓存会虚高，不作计数断言）
  await (await (await page.$('.avoid-row')).$('.pack-x')).tap()
  await until(async () => {
    const first = await page.$('.avoid-row')
    if (!first) return false
    return (await (await first.$('.avoid-title')).text()).includes('橘子洲五点停止入园')
  }, 8000, '删除后首行变为后者')
  mark(true, '删的是指定那条，后者保留')
}

async function main() {
  consoleMsgs.length = 0
  failures = []
  await bootAndLogin()
  await createTrip()
  await phaseFx()
  await phaseAvoid()

  const errConsoles = consoleMsgs.filter((m) => m.startsWith('[error]'))
  if (errConsoles.length) {
    failures.push('页面 console 有 error：' + errConsoles[0])
  }

  console.log('\n===== 快抄面板 e2e 结果：' + (failures.length ? '失败 ' + failures.length : '通过') + ' =====')
  if (failures.length) console.error('失败项：' + failures.join('；'))

  console.log('\n· 页面 console 输出（近 40 条）：')
  for (const m of consoleMsgs.slice(-40)) console.log('   ', m)

  try {
    await mp.close()
  } catch {}
  await sleep(1000)
  try {
    execSync('pkill -9 -f wechatwebdevtools', { stdio: 'ignore' })
  } catch {}
  if (failures.length) process.exitCode = 1
  console.log('开发者工具已退出')
}

main().catch((e) => {
  console.error('e2e 失败：', e)
  process.exit(1)
})
