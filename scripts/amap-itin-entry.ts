/**
 * 高德在线行程生成端到端验证（真实调用高德 API）。
 *
 * 断言点：
 * 1. 本地 6 城（成都）走精修库 + 经典路线，行为不回归
 * 2. 陌生城市（长沙）走高德在线库：能出多天计划、天数正确、
 *    有景点有餐饮、坐标落在目的地城市范围内
 * 3. 高德失败时（离线模拟）回退本地模板，不崩
 */
import { mock } from './uni-mock'
import { createPinia } from 'pinia'
import { generateItineraryAsync, generateItinerary } from '../src/utils/itinerary'
import { isKnownCity } from '../src/data/poi'
import { createHarness } from './lib/test-harness.mjs'

const H = createHarness()
const { ok, section } = H

// uni.request 走 uni-mock 的 fetch 桥，但只 rewrite 本地后端地址 ——
// 高德 restapi.amap.com 不在 rewrite 范围内，天然直连真 API。
mock.useDevice('A')

const BASE_INPUT = {
  startDate: '2026-10-01',
  endDate: '2026-10-03', // daysBetween 是「含头含尾」：1001→1003 = 3 天
  peopleCount: 2,
  prefs: ['food', 'nature'],
  pace: 'normal' as const
}

// ────────────────────────────────────────────────────────────────────────
section('[1] 本地城回归：成都仍走精修库 + 经典路线')

const local = generateItinerary({ destination: '成都', ...BASE_INPUT })
ok(isKnownCity('成都'), '成都命中本地库')
ok(local.days.length === 3, '3 天计划', local.days.length)
ok(local.days[0].title === '市区人文 · 三国与老成都', '第 1 天主题来自攻略库', local.days[0].title)
ok(local.items.length >= 8, '行程项充足', local.items.length)
ok(local.items.every((i) => i.lat && i.lng), '所有行程项有坐标')

// ────────────────────────────────────────────────────────────────────────
section('[2] 陌生城市在线生成：长沙（真实高德检索）')

console.log('  … 调高德 API（景点/餐饮/商圈 + geocode，约 1-2s）')
const t0 = Date.now()
const cs = await generateItineraryAsync({ destination: '长沙', ...BASE_INPUT })
const elapsed = Date.now() - t0

ok(cs.days.length === 3, '3 天计划', cs.days.length)
ok(cs.items.length >= 10, `行程项充足（${cs.items.length} 个）`, cs.items.length)

const spots = cs.items.filter((i) => i.type === 'spot')
const foods = cs.items.filter((i) => i.type === 'food')
ok(spots.length >= 6, `景点足够（${spots.length} 个）`, spots.length)
ok(foods.length >= 3, `餐饮足够（${foods.length} 个）`, foods.length)

// 坐标落在长沙（市中心 112.94,28.23 附近 80km 内）
const CENTER = { lng: 112.94, lat: 28.23 }
const near = cs.items.filter((i) => {
  const dLng = (i.lng - CENTER.lng) * 96
  const dLat = (i.lat - CENTER.lat) * 111
  return Math.sqrt(dLng ** 2 + dLat ** 2) < 80
})
ok(near.length >= cs.items.length * 0.7, `坐标大都在长沙附近（${near.length}/${cs.items.length}）`)

// 每天都有内容； famous 地标出现
const day0Items = cs.items.filter((i) => i.dayId === cs.days[0].id)
ok(day0Items.length >= 2, '第 1 天有安排', day0Items.length)
const famous = ['橘子洲', '岳麓山', '天心阁', '马王堆', '太平', '坡子街', '五一']
ok(
  cs.items.some((i) => famous.some((f) => i.title.includes(f))),
  '包含长沙知名地标',
  cs.items.map((i) => i.title).slice(0, 6)
)

// 每天不超过紧凑上限
const perDay = cs.days.map((d) => cs.items.filter((i) => i.dayId === d.id).length)
ok(Math.max(...perDay) <= 6, `单日不爆量（max ${Math.max(...perDay)}）`, perDay)
ok(elapsed < 15000, `生成耗时合理（${elapsed}ms）`)

// 展示一下生成结果的样子
console.log('\n  ── 长沙 3 日草稿预览 ──')
cs.days.forEach((d) => {
  console.log(`  Day ${d.index + 1} · ${d.date}`)
  cs.items
    .filter((i) => i.dayId === d.id)
    .forEach((i) => console.log(`    ${i.time} ${i.type === 'food' ? '🍜' : '📍'} ${i.title}`))
})

// ────────────────────────────────────────────────────────────────────────
section('[3] 高德失败回退：完全断网后不崩、回退本地模板')

mock.setOfflineAll(true)
const fallback = await generateItineraryAsync({ destination: '长沙', ...BASE_INPUT })
ok(fallback.days.length === 3, '回退后仍出 3 天计划')
ok(fallback.items.length >= 6, '回退后仍有行程项（成都模板）', fallback.items.length)
ok(
  fallback.summary.includes('在线检索失败'),
  'summary 交代了回退',
  fallback.summary
)
mock.setOfflineAll(false)

// ────────────────────────────────────────────────────────────────────────
console.log(`\n===== 高德在线生成结果：${H.pass} 通过 / ${H.fail} 失败 =====`)
if (H.fail > 0) process.exit(1)
