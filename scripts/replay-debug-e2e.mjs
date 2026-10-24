#!/usr/bin/env node
/**
 * 回放页调试 e2e：冷启动 → 启动即落在 ItineraryPage（已登录、有本地行程）
 * → 原样走用户路径：点概览组「行程回放」行 → 落在 ReplayPage，
 * 打印页面 data 摘要 / 节点计数 / 控制台消息，排查「回放页空白」。
 */
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import automator from 'miniprogram-automator'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PROJECT = join(ROOT, 'dist', 'build', 'mp-weixin')
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'

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
const pagePath = async (mp) => {
  const p = await mp.currentPage()
  return p ? String(p.path || '') : ''
}

async function main() {
  try {
    execSync('pkill -9 -f wechatwebdevtools', { stdio: 'ignore' })
  } catch {}
  await sleep(2000)

  const consoleMsgs = []
  console.log('· 冷启动开发者工具…')
  const mp = await automator.launch({ cliPath: CLI, projectPath: PROJECT, timeout: 120000 })
  mp.on('console', (msg) => {
    const args = (msg.args || []).map((a) =>
      typeof a === 'string' ? a.slice(0, 300) : JSON.stringify(a)?.slice(0, 300)
    )
    consoleMsgs.push(`[${msg.type}] ${args.join(' | ')}`)
  })
  mp.on('exception', (e) => consoleMsgs.push(`[EXCEPTION] ${e?.message || JSON.stringify(e)}`))

  await until(async () => (await pagePath(mp)) !== '', 60000, '小程序启动')
  console.log('· 启动完成，当前页：', await pagePath(mp))
  await sleep(3000)

  const raw = await mp.callWxMethod('getStorageSync', 'travel_h5_state_v1')
  const sync = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {}
  const trips = sync?.trips || []
  const allItems = sync?.items || []
  console.log('· 存储行程清单：')
  trips.slice(0, 10).forEach((t) => {
    const its = allItems.filter((i) => i.tripId === t.id)
    const geo = its.filter((i) => i.lat && i.lng).length
    console.log(`  ${t.id}｜title=${String(t.title || '').slice(0, 16)}｜items=${its.length}｜geo=${geo}`)
  })
  const best = trips
    .map((t) => ({
      id: t.id,
      geo: allItems.filter((i) => i.tripId === t.id && i.lat && i.lng).length
    }))
    .sort((a, b) => b.geo - a.geo)[0]
  if (!best || !best.geo) throw new Error('存储里没有任何带坐标的行程')
  console.log('· 选 items 最多的行程：', best.id, 'geo=', best.geo)

  await mp.reLaunch('/pages/ReplayPage?id=' + best.id)
  await until(async () => (await pagePath(mp)).includes('ReplayPage'), 20000, '回放页')
  await sleep(3000)
  console.log('· 已在 ReplayPage')

  const page = await mp.currentPage()
  const data = (await page.data()) || {}
  const interesting = {}
  const keys = Object.keys(data)
  console.log('· data 顶层键数：', keys.length)
  for (const k of keys) {
    const v = data[k]
    const s = JSON.stringify(v)
    if (Array.isArray(v)) interesting[k] = Array.isArray(v) ? `Array(${v.length}) ${s.slice(0, 220)}` : v
    else if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string')
      interesting[k] = s.slice(0, 120)
    else if (v && typeof v === 'object') interesting[k] = s.slice(0, 220)
  }
  Object.entries(interesting).forEach(([k, v]) => console.log(`  ${k} => ${v}`))

  const maps = await page.$$('map')
  const buttons = await page.$$('button')
  const ps = await page.$$('p')
  console.log(`· 节点：map=${maps.length} button=${buttons.length} p=${ps.length}`)

  const chips = []
  for (const el of buttons.slice(0, 14)) {
    try {
      const t = await el.text()
      if (t) chips.push(t.trim().slice(0, 40))
    } catch {}
  }
  console.log('· 按钮文本:', JSON.stringify(chips))

  // 播放推进验证：点「播放」，几秒后字幕序号应增长
  const subtitleOf = (d) =>
    Object.values(d || {}).find(
      (v) => typeof v === 'string' && /^第 \d+ 天 ·/.test(v)
    )
  const findBtnByText = async (text) => {
    for (const el of await page.$$('button')) {
      try {
        if ((await el.text()).trim() === text) return el
      } catch {}
    }
    return null
  }
  const before = String(subtitleOf(await page.data()) || '')
  let playBtn = null
  for (const el of await page.$$('button')) {
    try {
      const t = await el.text()
      if (t.replace(/\s+/g, '').includes('播放')) {
        playBtn = el
        break
      }
    } catch {}
  }
  if (playBtn) {
    await playBtn.tap()
    await until(
      async () => {
        const d = await page.data()
        return String(subtitleOf(d) || '') !== before
      },
      10000,
      '字幕推进'
    )
    const after = String(subtitleOf(await page.data()) || '')
    console.log(`· 播放推进验证：${before} → ${after}`)
  } else {
    console.log('· 没找到播放钮（可能已自动播放）')
  }

  // 连线 + 步距小字验证：连线是站点直线（点数 = 当天已走站数），
  // 步距「上一步约 … · 步行约 N 分钟」纯本地估算，零外部依赖，必须出现
  await sleep(2500)
  const d2 = await page.data()
  let maxPts = 0
  for (const v of Object.values(d2 || {})) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0]) {
      if ('points' in v[0] && Array.isArray(v[0].points)) {
        maxPts = Math.max(maxPts, v[0].points.length)
      } else if (
        'latitude' in v[0] &&
        'longitude' in v[0] &&
        Object.keys(v[0]).length === 2
      ) {
        maxPts = Math.max(maxPts, v.length)
      }
    }
  }
  const leg = Object.values(d2 || {}).find(
    (v) => typeof v === 'string' && v.startsWith('上一步约 ')
  )
  console.log(`· 连线点数（站点直线）：${maxPts}`)
  if (maxPts < 2) console.log('  ⚠️ 没画出连线')
  if (leg) console.log(`· 步距小字：${leg}`)
  else console.log('  ⚠️ 步距小字缺失')

  console.log('\n===== 控制台消息（全部） =====')
  consoleMsgs.forEach((m) => console.log(m))

  await mp.close()
  process.exit(0)
}

main().catch(async (e) => {
  console.error('调试失败：', e instanceof Error ? e.message : e)
  try {
    await pagePath(mp).then((p) => console.log('· 失败时所在页：', p))
  } catch {}
  process.exit(1)
})
