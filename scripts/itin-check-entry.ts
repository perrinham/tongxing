/**
 * 行程校验器单测入口 —— 由 scripts/itin-check-test.mjs 用 esbuild 打包后在 Node 上跑。
 *
 * 覆盖到七类规则 + 降级路径 + 缓存命中。规则全部是纯几何/纯字段判定，
 * route 注入 fake 就能测 tight 与「失败静默」两条路，不需要真出网。
 */
import assert from 'node:assert/strict'
import type { ItineraryItem, ItinIssue } from '../src/types'
import {
  checkItinerary,
  timeMinOf,
  kmBetween,
  type RouteLike,
  type LatLike
} from '../src/utils/itinCheck'

// ── 构造辅助 ──────────────────────────────────────────────────────────────────

const CITY = { lat: 30.6, lng: 104.06 }
/** 在城市原点附近撒点，offsetDeg 约每 0.11° = 11km */
function coord(offsetDeg: number): LatLike {
  return { lat: CITY.lat + offsetDeg, lng: CITY.lng + offsetDeg }
}

function mkItem(p: Partial<ItineraryItem> & { id: string; dayId: string }): ItineraryItem {
  return {
    order: 0,
    time: '',
    type: 'spot',
    title: '点',
    address: '四川省成都市某地址',
    lat: CITY.lat,
    lng: CITY.lng,
    cost: 0,
    duration: 60,
    note: '',
    done: false,
    ...p
  }
}

const D = 'day1'
const rulesOf = (list: ItinIssue[]) => list.map((i) => i.rule)

let passed = 0
const failures: string[] = []

async function spec(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(name)
    console.log(`  ✗ ${name}`)
    console.log(`    ${e instanceof Error ? e.message : e}`)
  }
}

// ── 用例 ─────────────────────────────────────────────────────────────────────

console.log('\n· 行程校验规则')

await spec('全绿日用出零问题', async () => {
  const items = [
    mkItem({ id: 'a', dayId: D, time: '09:00', duration: 60, ...coord(0) }),
    mkItem({ id: 'b', dayId: D, time: '11:00', duration: 120, order: 1, ...coord(0.003) })
  ]
  assert.deepEqual(await checkItinerary(items), [])
})

await spec('R1 两个相邻项时间重叠', async () => {
  const items = [
    mkItem({ id: 'a', dayId: D, time: '09:00', duration: 60, ...coord(0) }),
    mkItem({ id: 'b', dayId: D, time: '09:30', duration: 60, order: 1, ...coord(0.003) })
  ]
  const out = await checkItinerary(items)
  assert.equal(out.length, 1)
  assert.equal(out[0].rule, 'overlap')
  assert.equal(out[0].level, 'error')
  assert.deepEqual(out[0].itemIds.sort(), ['a', 'b'])
})

await spec('R1 三项成链并成一条，而不是两条 2 元问题', async () => {
  const items = [
    mkItem({ id: 'a', dayId: D, time: '09:00', duration: 60, ...coord(0) }),
    mkItem({ id: 'b', dayId: D, time: '09:30', duration: 60, order: 1, ...coord(0.001) }),
    mkItem({ id: 'c', dayId: D, time: '10:00', duration: 60, order: 2, ...coord(0.002) })
  ]
  const out = (await checkItinerary(items)).filter((i) => i.rule === 'overlap')
  assert.equal(out.length, 1)
  assert.deepEqual([...out[0].itemIds].sort(), ['a', 'b', 'c'])
})

await spec('R2 总时长超载报 warn', async () => {
  const items = [
    mkItem({ id: 'a', dayId: D, time: '09:00', duration: 300, ...coord(0) }),
    mkItem({ id: 'b', dayId: D, time: '15:00', duration: 300, order: 1, ...coord(0.003) }),
    mkItem({ id: 'c', dayId: D, time: '21:00', duration: 300, order: 2, ...coord(0.006) })
  ]
  const out = await checkItinerary(items)
  assert.deepEqual(rulesOf(out), ['overload'])
  assert.equal(out[0].level, 'warn')
})

await spec('R3 相邻 >3km 没交通 → gap；route 假数据叠加 tight', async () => {
  const fake = async (): Promise<RouteLike> => ({ distance: 8000, duration: 1800 })
  const items = [
    mkItem({ id: 'a', dayId: D, time: '09:00', duration: 60, ...coord(0) }),
    mkItem({ id: 'b', dayId: D, time: '10:00', duration: 60, order: 1, ...coord(0.072) })
  ]
  const out = await checkItinerary(items, { route: fake })
  assert.deepEqual(rulesOf(out).sort(), ['gap', 'tight'])
  assert.equal(out.find((i) => i.rule === 'tight')!.level, 'warn')
  assert.equal(out.find((i) => i.rule === 'gap')!.itemIds.length, 2)
})

await spec('route 缓存命中后不再重复请求', async () => {
  let calls = 0
  const fake = async (): Promise<RouteLike> => {
    calls++
    return { distance: 8000, duration: 1800 }
  }
  const items = [
    mkItem({ id: 'a', dayId: D, time: '09:00', duration: 60, ...coord(0) }),
    mkItem({ id: 'b', dayId: D, time: '10:00', duration: 60, order: 1, ...coord(0.072) })
  ]
  const cache = new Map<string, RouteLike | null>()
  await checkItinerary(items, { route: fake, routeCache: cache })
  await checkItinerary(items, { route: fake, routeCache: cache })
  assert.equal(calls, 1)
})

await spec('route 抛错 → 静默降级（有 gap 无 tight，不抛异常）', async () => {
  const bad = async (): Promise<RouteLike | null> => {
    throw new Error('offline')
  }
  const items = [
    mkItem({ id: 'a', dayId: D, time: '09:00', duration: 60, ...coord(0) }),
    mkItem({ id: 'b', dayId: D, time: '10:00', duration: 60, order: 1, ...coord(0.072) })
  ]
  const out = await checkItinerary(items, { route: bad })
  assert.deepEqual(rulesOf(out), ['gap'])
})

await spec('R5 同日 >200km → jump error', async () => {
  const items = [
    mkItem({ id: 'a', dayId: D, time: '09:00', duration: 60, ...coord(0) }),
    mkItem({ id: 'b', dayId: D, time: '19:00', duration: 120, order: 1, ...coord(2.7) })
  ]
  const out = await checkItinerary(items)
  assert.deepEqual(rulesOf(out), ['jump'])
  assert.equal(out[0].level, 'error')
})

await spec('缺坐标 → no-location；transport 类型豁免', async () => {
  const out1 = await checkItinerary([
    mkItem({ id: 'a', dayId: D, title: '景点', lat: 0, lng: 0 })
  ])
  assert.deepEqual(rulesOf(out1), ['no-location'])
  const out2 = await checkItinerary([
    mkItem({ id: 't', dayId: D, type: 'transport', title: '地铁1号线', lat: 0, lng: 0 })
  ])
  assert.deepEqual(out2, [])
})

await spec('R6 字段问题归一条：负花销 + 非法时间', async () => {
  const out = await checkItinerary([
    mkItem({ id: 'a', dayId: D, title: '餐厅', cost: -5, time: '25:99' })
  ])
  assert.deepEqual(rulesOf(out), ['bad-data'])
  assert.equal(out[0].level, 'warn')
})

await spec('R7 同日 <50m 判重复', async () => {
  const items = [
    mkItem({ id: 'a', dayId: D, time: '09:00', title: '博物馆', ...coord(0) }),
    mkItem({ id: 'b', dayId: D, time: '10:00', order: 1, title: '博物馆纪念品', ...coord(0) })
  ]
  const out = await checkItinerary(items)
  assert.deepEqual(rulesOf(out), ['dupe'])
})

await spec('未定时段项跳过时间规则（time 为空合法）', async () => {
  const items = [
    mkItem({ id: 'a', dayId: D, time: '', ...coord(0) }),
    mkItem({ id: 'b', dayId: D, time: '', order: 1, duration: 300, ...coord(0.001) })
  ]
  const out = await checkItinerary(items)
  assert.deepEqual(out, [])
})

console.log('\n· 通用工具')

await spec('timeMinOf：合法解析 / 空串 null / 非法 NaN', async () => {
  assert.equal(timeMinOf('09:30'), 570)
  assert.equal(timeMinOf('9:30'), 570)
  assert.equal(timeMinOf(''), null)
  assert.ok(Number.isNaN(timeMinOf('24:00')))
  assert.ok(Number.isNaN(timeMinOf('09:5')))
})

await spec('kmBetween：零距离与已知公里数', async () => {
  assert.ok(Math.abs(kmBetween({ lat: 30, lng: 104 }, { lat: 30, lng: 104 })) < 1e-9)
  // 纬度 1° ≈ 111.2km
  const km = kmBetween({ lat: 30, lng: 104 }, { lat: 31, lng: 104 })
  assert.ok(km > 110 && km < 112)
})

// ── 收尾 ─────────────────────────────────────────────────────────────────────

console.log(`\n===== 行程核验结果：${passed} 通过 / ${failures.length} 失败 =====`)
if (failures.length) {
  console.error('失败用例：', failures.join('；'))
  process.exitCode = 1
}
