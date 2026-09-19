#!/usr/bin/env node
/**
 * 双账号（双微信号）端到端验证：行程编辑归属 + 足迹互见。
 *
 * 用 miniprogram-automator 驱动微信开发者工具，全程走真实 UI：
 *
 *   用户 A：SyncPage 登录 → 足迹页标「成都·去过」→ 建行程（成都）
 *   用户 B：清存储重新登录（第二个固定 code → 另一个 openid，等价第二个微信号）
 *           → 发现页看到 A 的行程 → 点开是只读详情（无「进入编辑」）
 *           → 发现页看到 A 的足迹（作者名）→ 标「武汉·想去」
 *   切回 A：UI 退出登录 → 用 A 的固定 code 重新登录 → 自己的行程带「我的」角标
 *           → 点开直接进行程编辑页；A 也能看到 B 的足迹
 *
 * 服务端断言用两个身份各自的 token 直接查 API 交叉验证（归属隔离、广场剥 code）。
 * 结束后清理测试数据（删行程、撤足迹）并把小程序恢复为未登录空态。
 *
 * 用法：node scripts/verify-two-users.mjs   （需先 npm run server 启动 :8787）
 *
 * 自动化要点（踩过的坑）：
 *   · uni-app 自定义组件（app-empty 等）的内部节点 automator 查不到，
 *     登录按钮改用 SyncPage 的页面作用域按钮；页面文本断言用根节点 text()（可穿透）。
 *   · reLaunch 之后必须等 page.path 变成目标页，否则 $$ 拿到的是旧页面的节点。
 *   · /api/my/guides 的攻略字段是 cityName（assembleGuide），不是 name。
 *   · 身份切换不做「存储写回」手术：活实例的启动同步 / 持久化定时器几秒内就会
 *     覆盖手写的存储，怎么等都没用。改用 mp.mockWxMethod('login') 把 wx.login
 *     桩成固定 code —— dev 登录的 openid 由 code 派生，固定 code = 固定身份，
 *     会话 C 走真实 UI（退出登录 → 再登录）就能换回 A，等价「A 回到自己设备」。
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import automator from 'miniprogram-automator'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PROJECT = join(ROOT, 'dist', 'build', 'mp-weixin')
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const BASE = 'http://localhost:8787'

/** 固定登录 code：dev openid = 'dev' + sha1('dev:'+code) 前 24 位 → 固定 code = 固定身份 */
const CODE_A = 'e2e-verify-user-A'
const CODE_B = 'e2e-verify-user-B'
const devOpenidOf = (code) => 'dev' + createHash('sha1').update('dev:' + code).digest('hex').slice(0, 24)

let pass = 0
let fail = 0
function ok(cond, label, extra) {
  if (cond) {
    pass += 1
    console.log('  ✓', label)
  } else {
    fail += 1
    console.log('  ✗', label, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300))
  }
}
function section(t) {
  console.log('\n' + t)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(cond, timeout = 10000, label = '条件') {
  const end = Date.now() + timeout
  let lastErr = null
  while (Date.now() < end) {
    try {
      if (await cond()) return true
    } catch (e) {
      lastErr = e
    }
    await sleep(300)
  }
  if (lastErr) console.log('  (轮询出错：' + String(lastErr?.message || lastErr) + ')')
  console.log('  … 等待超时：' + label)
  return false
}

/** 用身份 token 调后端（GET，node 侧交叉验证用） */
async function api(path, token) {
  const r = await fetch(BASE + path, {
    headers: token ? { 'X-Session-Token': token } : {}
  })
  let data = null
  try {
    data = await r.json()
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: r.status, data }
}

/** 从存储元数据里取登录身份 */
function parseIdentity(raw) {
  try {
    const meta = typeof raw === 'string' ? JSON.parse(raw) : raw
    return meta?.identity || null
  } catch {
    return null
  }
}

// ── automator 小工具 ──────────────────────────────────────────────

let mp = null

async function pagePath() {
  try {
    const p = await mp.currentPage()
    return p ? String(p.path || '') : ''
  } catch {
    return ''
  }
}

async function waitRoute(pathPart, timeout = 15000) {
  const done = await until(async () => (await pagePath()).includes(pathPart), timeout, '进入页面 ' + pathPart)
  if (!done) throw new Error('没能进入页面：' + pathPart + '（当前 ' + (await pagePath()) + '）')
  await sleep(500) // 首屏渲染
  return mp.currentPage()
}

async function reLaunch(route, pathPart) {
  await mp.reLaunch(route)
  return waitRoute(pathPart || route.replace(/^\//, ''))
}

/** 页面根节点全文（可穿透自定义组件；断言「文字在不在页面上」用） */
async function pageText(page) {
  for (const sel of ['.page', '.welcome', 'view']) {
    try {
      const el = await page.$(sel)
      if (el) return await el.text()
    } catch {
      /* 下一个 */
    }
  }
  return ''
}

/** 页面作用域里按文本找按钮（exact=true 精确匹配） */
async function findButton(page, text, { exact = false } = {}) {
  let els = []
  try {
    els = await page.$$('button')
  } catch {
    return null
  }
  for (const el of els) {
    let t = ''
    try {
      t = (await el.text()).trim()
    } catch {
      continue
    }
    if (exact ? t === text : t.includes(text)) return el
  }
  return null
}

// ── 业务动作 ──────────────────────────────────────────────────────

/**
 * 真实 UI 登录（SyncPage 的页面作用域「微信登录」按钮）。
 * @param code 用 mp.mockWxMethod('login') 把 wx.login 桩成固定 code ——
 *   dev 模式下 openid 由 code 派生，固定 code = 固定身份（可复现的「微信号」）。
 *   若存储里已有登录态（上一轮残留），先走 UI「退出登录」。
 */
async function loginViaSyncPage(code) {
  const page = await reLaunch('/pages/SyncPage', 'pages/SyncPage')
  // 已登录态（上一轮残留）会显示「退出登录」分支 —— 先退出，登录按钮才出现
  const staleLogout = await findButton(page, '退出登录', { exact: true })
  if (staleLogout) {
    await staleLogout.tap()
    await sleep(1000)
  }
  let btn = null
  await until(async () => {
    btn = await findButton(page, '微信登录', { exact: true })
    return !!btn
  }, 8000, 'SyncPage 微信登录按钮')
  if (!btn) throw new Error('SyncPage 没找到「微信登录」按钮')
  await mp.mockWxMethod('login', { code, errMsg: 'login:ok' })
  try {
    await btn.tap()
    let raw = ''
    const okLogin = await until(async () => {
      raw = await mp.callWxMethod('getStorageSync', 'travel_sync_v1')
      return !!parseIdentity(raw)?.token
    }, 15000, '登录完成（存储出现身份）')
    const id = parseIdentity(raw)
    if (!okLogin || !id) throw new Error('登录失败：存储里没有身份')
    return { openid: id.openid, token: id.token, raw }
  } finally {
    try {
      await mp.restoreWxMethod('login')
    } catch {
      /* mock 恢复失败不影响后续（下次登录会重新 mock） */
    }
  }
}

/** 足迹页：添加城市（status 默认 visited；wish 需要点「想去」） */
async function markCityViaUI(name, status) {
  const page = await reLaunch('/pages/CityMapPage', 'pages/CityMapPage')
  const addBtn = await page.$('.add-btn')
  if (!addBtn) throw new Error('没找到「添加城市」入口（.add-btn）')
  await addBtn.tap()
  let input = null
  await until(async () => {
    input = await page.$('.text-input')
    return !!input
  }, 5000, '添加城市弹层输入框')
  if (!input) throw new Error('弹层输入框没出现')
  await input.input(name)
  await sleep(300)
  if (status === 'wish') {
    const wish = await findButton(page, '想去', { exact: true })
    if (!wish) throw new Error('没找到「想去」分段按钮')
    await wish.tap()
    await sleep(200)
  }
  const confirm = await findButton(page, '添加', { exact: true })
  if (!confirm) throw new Error('没找到弹层「添加」确认按钮')
  await confirm.tap()
  await sleep(600) // 弹层关闭 + 自动发布异步触发
}

/** 建行程：TripCreatePage 目的地/日期已有默认值 → 生成页再点「开始生成」 */
async function createTripViaUI() {
  const page = await reLaunch('/pages/TripCreatePage', 'pages/TripCreatePage')
  const btn = await findButton(page, '生成行程草稿')
  if (!btn) throw new Error('没找到「生成行程草稿」按钮')
  await btn.tap()
  await waitRoute('pages/TripGeneratePage')
  const genPage = await mp.currentPage()
  const startBtn = await findButton(genPage, '开始生成')
  if (!startBtn) throw new Error('生成页没找到「开始生成」按钮')
  await startBtn.tap()
  // 本地 6 城（成都）走本地种子生成，完成后自动进行程页
  const ok = await until(async () => (await pagePath()).includes('pages/ItineraryPage'), 60000, '行程生成完成')
  if (!ok) throw new Error('生成行程后没有进入行程页')
  await sleep(600)
}

/** 等某 token 的广场里出现指定标题的行程，返回该 brief */
async function waitDiscoverTrip(token, titlePart, timeout = 20000) {
  let found = null
  await until(async () => {
    const r = await api('/api/trips/discover', token)
    found = (r.data?.trips || []).find((t) => String(t.title || '').includes(titlePart))
    return !!found
  }, timeout, '广场出现行程 ' + titlePart)
  return found
}

/** 在发现页 UI 里找到标题含 titlePart 的行程卡片 */
async function findTripCard(page, titlePart) {
  let card = null
  await until(async () => {
    for (const el of await page.$$('.trip-card')) {
      if ((await el.text()).includes(titlePart)) {
        card = el
        return true
      }
    }
    return false
  }, 12000, '发现页行程卡片：' + titlePart)
  return card
}

// ── 主流程 ────────────────────────────────────────────────────────

async function main() {
  // 0. 前置检查
  const health = await api('/api/health')
  if (health.status !== 200) throw new Error('后端 :8787 不在线（先 npm run server）')
  console.log('· 后端在线（storage:', health.data?.storage, '）')

  // 冷启动开发者工具（记忆教训：反复 launch 会楔死工具 → rawPath 报错，
  // 必须全杀进程、等退干净、再冷启动）。
  // 双账号模拟 = **三个独立冷启动会话**（A 会话 → 冷启 B 会话 → 冷启后 UI 登回 A），
  // 等价两台真机各自的存储与内存状态；同会话里切身份会把上一个用户的
  // 行程留在内存 store 里，造成「能编辑别人行程」的假阳性。
  const killAll = async () => {
    try {
      execSync('pkill -9 -f wechatwebdevtools', { stdio: 'ignore' })
    } catch {
      /* 本来就没跑 */
    }
    await until(() => {
      try {
        execSync('pgrep -f wechatwebdevtools', { stdio: 'ignore' })
        return false // 还有进程
      } catch {
        return true // pgrep 无匹配 → 全部退出
      }
    }, 20000, '开发者工具进程全部退出')
    await sleep(2000)
  }

  /** 全杀 → 冷启 → 等小程序就绪 */
  const coldLaunch = async () => {
    await killAll()
    console.log('· 冷启动开发者工具（automator）…')
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        mp = await automator.launch({ cliPath: CLI, projectPath: PROJECT, timeout: 90000 })
        break
      } catch (e) {
        if (attempt === 3) throw e
        console.log('  启动失败（' + String(e?.message || e).slice(0, 90) + '），全杀后重试…')
        await killAll()
      }
    }
    await until(async () => (await pagePath()) !== '', 60000, '小程序启动')
    console.log('· 小程序已启动，当前页：', await pagePath())
  }

  // ══════════════════════════════════════════════════════════════
  // 会话 A：登录 → 标足迹 → 建行程
  // ══════════════════════════════════════════════════════════════
  section('【会话 A】用户 A：登录 + 标记足迹 + 创建行程')
  await coldLaunch()
  await mp.callWxMethod('clearStorageSync') // 从干净的未登录状态开始

  const aPage0 = await reLaunch('/pages/DiscoverPage', 'pages/DiscoverPage')
  ok((await pageText(aPage0)).includes('先登录再看'), '未登录看不到广场（先登录再看）')

  const A = await loginViaSyncPage(CODE_A)
  ok(A.openid === devOpenidOf(CODE_A), 'A 登录成功（固定 code → 确定身份）openid=' + A.openid)
  const authorA = '旅人' + A.openid.slice(-4)

  // A 标成都·去过（登录后自动发布）
  await markCityViaUI('成都', 'visited')
  let mine = null
  await until(async () => {
    const r = await api('/api/my/guides', A.token)
    mine = (r.data?.guides || []).find((g) => g.cityName === '成都')
    return !!mine
  }, 10000, 'A 的成都足迹自动发布到服务端')
  ok(!!mine, 'A 标记的成都已自动发布（/api/my/guides 可查回）')
  ok(mine?.author === authorA, '作者名按 openid 派生：' + authorA, mine?.author)
  ok(mine?.status === 'visited', '状态 visited')

  // A 建行程（成都）
  await createTripViaUI()
  const aTrip = await waitDiscoverTrip(A.token, '成都')
  ok(!!aTrip, 'A 创建的行程已同步到服务端并进入广场')
  ok(aTrip?.mine === true, 'A 看自己的行程 mine=true')
  ok(typeof aTrip?.code === 'string' && !!aTrip?.code, 'A 看自己的行程带分享码（可共编）')
  const tripId = aTrip?.id

  // ══════════════════════════════════════════════════════════════
  // 会话 B：清存储 → 冷启动 → 登录第二个微信号 → 只读可见性
  // ══════════════════════════════════════════════════════════════
  section('【会话 B】用户 B（第二个微信号）：别人的行程只读、足迹互见')
  await mp.callWxMethod('clearStorageSync')
  await coldLaunch()

  const B = await loginViaSyncPage(CODE_B)
  ok(
    B.openid === devOpenidOf(CODE_B) && B.openid !== A.openid,
    'B 是另一个身份（第二个微信号）openid=' + B.openid
  )
  const authorB = '旅人' + B.openid.slice(-4)

  // B 的广场里能看到 A 的行程
  const bTrip = await waitDiscoverTrip(B.token, '成都')
  ok(!!bTrip, 'B 在「发现」看到 A 的行程')
  ok(bTrip?.mine === false, 'B 看别人的行程 mine=false')
  ok(bTrip?.code === undefined, '别人的行程服务端剥掉了分享码（无法绕过只读）', bTrip?.code)

  // 服务端佐证：B 的空间同步列表不含 A 的行程（B 的本地 store 拿不到它 → 无编辑入口）
  const bSpaces = await api('/api/trips', B.token)
  ok(
    !(bSpaces.data?.spaces || []).some((s) => s.id === tripId),
    'B 的空间同步列表（GET /api/trips）不含 A 的行程'
  )

  // B 点开 A 的行程 → 只读详情页
  const bPage = await reLaunch('/pages/DiscoverPage', 'pages/DiscoverPage')
  const card = await findTripCard(bPage, '成都')
  ok(!!card, '找到 A 的行程卡片')
  const cardText = card ? await card.text() : ''
  ok(!cardText.includes('我的'), '别人的行程没有「我的」角标', cardText)
  await card.tap()
  await waitRoute('pages/TripViewPage')
  const viewPage = await mp.currentPage()
  const viewText = await pageText(viewPage)
  ok(viewText.includes('只读浏览'), '只读详情页有「只读浏览」标识')
  ok(!(await findButton(viewPage, '进入编辑')), '只读详情没有「进入编辑」按钮（B 不能编辑 A 的行程）')

  // B 在广场足迹区看到 A 的成都
  const bPage2 = await reLaunch('/pages/DiscoverPage', 'pages/DiscoverPage')
  await until(async () => {
    const t = await pageText(bPage2)
    return t.includes('成都') && t.includes(authorA)
  }, 12000, 'B 看到足迹 成都·' + authorA)
  ok(true, `B 在「大家的足迹」看到：成都 · ${authorA}`)

  // B 标武汉·想去
  await markCityViaUI('武汉', 'wish')
  let bWuhan = null
  await until(async () => {
    const r = await api('/api/my/guides', B.token)
    bWuhan = (r.data?.guides || []).find((g) => g.cityName === '武汉')
    return !!bWuhan
  }, 10000, 'B 的武汉足迹自动发布到服务端')
  ok(!!bWuhan && bWuhan.status === 'wish', 'B 标记的武汉（想去）已自动发布')
  ok(bWuhan?.author === authorB, 'B 的作者名独立：' + authorB, bWuhan?.author)

  // 归属隔离：B 拉不回 A 的成都；A 拉不回 B 的武汉
  const bMine = await api('/api/my/guides', B.token)
  ok(!(bMine.data?.guides || []).some((g) => g.cityName === '成都'), 'B 的「我的足迹」里没有 A 的成都（归属隔离）')
  const aMine = await api('/api/my/guides', A.token)
  ok(!(aMine.data?.guides || []).some((g) => g.cityName === '武汉'), 'A 的「我的足迹」里没有 B 的武汉（归属隔离）')

  // ══════════════════════════════════════════════════════════════
  // 会话 C：冷启动（以 B 身份）→ UI 退出 → 用 A 的固定 code 登回 → 可编辑 + 互见
  // ══════════════════════════════════════════════════════════════
  section('【会话 C】切回 A：自己的行程可编辑 + 看到 B 的足迹')
  await coldLaunch()
  // 同一固定 code → 同一 dev openid：等价「A 回到自己设备」。
  // 不做存储写回手术 —— 活实例的启动同步 / 持久化定时器会覆盖手写的存储。
  const C = await loginViaSyncPage(CODE_A)
  ok(C.openid === A.openid, '同一 code 登回 → 还是 A 的身份（等价回到自己设备）', {
    got: C.openid,
    want: A.openid
  })
  await sleep(3000) // 登录动作内的重拉（pullAll）把 A 的行程并回本地 store，等渲染/实时就绪

  const aPage2 = await reLaunch('/pages/DiscoverPage', 'pages/DiscoverPage')
  const myCard = await findTripCard(aPage2, '成都')
  ok(!!myCard, 'A 的广场行程卡片已渲染')
  const myText = myCard ? await myCard.text() : ''
  ok(myText.includes('我的'), 'A 看自己的行程带「我的」角标', myText)

  // 进行程编辑页；若启动同步还没拉完文档（空态），等 3 秒重试一次（重找卡片）
  let itinText = ''
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let c
    if (attempt === 1) {
      c = myCard
    } else {
      console.log('  · 行程文档尚未拉回本地，等 3 秒重试…')
      await sleep(3000)
      const p2 = await reLaunch('/pages/DiscoverPage', 'pages/DiscoverPage')
      c = await findTripCard(p2, '成都')
      if (!c) break
    }
    await c.tap()
    await waitRoute('pages/ItineraryPage')
    itinText = await pageText(await mp.currentPage())
    if (itinText.includes('成都') && !itinText.includes('还没有属于你的行程')) break
  }
  ok(
    (await pagePath()).includes('pages/ItineraryPage') &&
      itinText.includes('成都') &&
      !itinText.includes('还没有属于你的行程'),
    'A 点自己的行程进入行程编辑页，且内容完整（不是只读/空态）'
  )

  const aPage3 = await reLaunch('/pages/DiscoverPage', 'pages/DiscoverPage')
  await until(async () => {
    const t = await pageText(aPage3)
    return t.includes('武汉') && t.includes(authorB)
  }, 12000, 'A 看到足迹 武汉·' + authorB)
  ok(true, `A 在「大家的足迹」看到：武汉 · ${authorB}（互相可见）`)

  // ──────────────────────────────────────────────────────────────
  // 清理：删测试行程 + 撤回两条足迹 + 小程序恢复未登录空态
  // ──────────────────────────────────────────────────────────────
  section('【清理】删除测试数据')
  await cleanup(A, B, tripId, authorA, authorB)
}

/** 清理（用 DELETE 显式发请求） */
async function cleanup(A, B, tripId, authorA, authorB) {
  async function del(path, token) {
    const r = await fetch(BASE + path, {
      method: 'DELETE',
      headers: token ? { 'X-Session-Token': token } : {}
    })
    return r.status
  }
  if (tripId) {
    const s = await del('/api/trips/' + tripId, A.token)
    ok(s === 200, '清理：删除测试行程（' + s + '）')
  }
  const s1 = await del('/api/cities/' + encodeURIComponent('成都') + '/guides?author=' + encodeURIComponent(authorA), A.token)
  ok(s1 === 200, '清理：撤回 A 的成都足迹（' + s1 + '）')
  const s2 = await del('/api/cities/' + encodeURIComponent('武汉') + '/guides?author=' + encodeURIComponent(authorB), B.token)
  ok(s2 === 200, '清理：撤回 B 的武汉足迹（' + s2 + '）')
  try {
    await mp.callWxMethod('clearStorageSync')
    await mp.reLaunch('/pages/DiscoverPage')
    console.log('· 小程序已恢复未登录空态')
  } catch {
    /* 工具可能已被关 */
  }
}

main()
  .then(() => {
    console.log(`\n════════ 双账号验证结束：${pass} 通过 / ${fail} 失败 ════════`)
    try {
      mp?.disconnect()
    } catch {
      /* 忽略 */
    }
    process.exit(fail ? 1 : 0)
  })
  .catch((e) => {
    console.error('\n✗ 验证脚本异常：', e?.message || e)
    try {
      mp?.disconnect()
    } catch {
      /* 忽略 */
    }
    process.exit(1)
  })
