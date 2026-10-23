/**
 * 行程回放单测入口 —— 由 scripts/replay-test.mjs 用 esbuild 打包后在 Node 上跑。
 *
 * 覆盖面：回放轨道（天→时序、坐标护栏）、天切换游标、polyline 截取、
 * 字幕格式、逐日摘要与里程、海报数据/测高/绘制冒烟（假 ctx）。
 */
import assert from 'node:assert/strict'
import {
  buildReplaySteps,
  dayBriefs,
  dayDistanceKm,
  drawReplayPoster,
  firstStepOfDay,
  hasCoord,
  kmLabel,
  orderDayItems,
  replayPosterData,
  replayPosterHeight,
  replaySubtitle,
  sequencePolyline,
  stepPoint
} from '../src/utils/replay'
import type { Day, ItineraryItem } from '../src/types'

let passed = 0
function ok(cond: unknown, name: string) {
  if (!cond) throw new Error(`断言失败：${name}`)
  passed++
  console.log(`  ✓ ${name}`)
}
async function spec(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`· ${name}`)
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e instanceof Error ? e.message : e}`)
    process.exitCode = 1
  }
}

const day = (id: string, index: number, date: string): Day => ({
  id,
  tripId: 't',
  index,
  date,
  title: `第${index + 1}天`,
  note: ''
})

const item = (id: string, dayId: string, opts: Partial<ItineraryItem> = {}): ItineraryItem => ({
  id,
  dayId,
  tripId: 't',
  order: 0,
  time: '',
  type: 'spot',
  title: id,
  address: '',
  lat: 30.66,
  lng: 104.06,
  cost: 0,
  duration: 60,
  note: '',
  done: false,
  ...opts
})

console.log('· 坐标护栏与天内排序')

await spec('无坐标项被静默跳过（lat/lng 任一为 0）', () => {
  assert.equal(hasCoord({ lat: 30.5, lng: 104 }), true)
  assert.equal(hasCoord({ lat: 0, lng: 104 }), false)
  assert.equal(hasCoord({ lat: 30.5, lng: 0 }), false)
  const list = [
    item('a', 'd1'),
    item('noboard', 'd1', { lat: 0, lng: 104.06 }),
    item('b', 'd1', { order: 1 })
  ]
  assert.deepEqual(orderDayItems(list).map((i) => i.id), ['a', 'b'])
})

await spec('时序口径：未定时（空 time）排最后，同时段按 order', () => {
  const list = [
    item('late', 'd1', { time: '20:00' }),
    item('untimed', 'd1', { order: 9 }),
    item('early', 'd1', { time: '08:00', order: 5 }),
    item('mid', 'd1', { time: '10:00', order: 1 })
  ]
  assert.deepEqual(orderDayItems(list).map((i) => i.id), ['early', 'mid', 'late', 'untimed'])
})

console.log('· 回放轨道')

const days = [day('d2', 1, '2026-03-02'), day('d1', 0, '2026-03-01'), day('d3', 2, '2026-03-03')]
const items = [
  item('d2-b', 'd2', { time: '14:00', order: 1, lat: 30.67, lng: 104.07 }),
  item('d2-a', 'd2', { time: '09:00', order: 0, lat: 30.66, lng: 104.06 }),
  item('d2-nocoord', 'd2', { time: '11:00' } as Partial<ItineraryItem> as ItineraryItem)
]
// 修正：显式 0 坐标
;(items[2] as ItineraryItem).lat = 0
;(items[2] as ItineraryItem).lng = 0
;((items[2] as ItineraryItem).title = 'd2-nocoord')
items.push(item('d1-a', 'd1', { time: '10:00', lat: 30.6 }))
items.push(item('d3-a', 'd3', { time: '12:00', lng: 104.1 }))

const steps = buildReplaySteps(days, items)

await spec('轨道：天按 index 升序推进，天内按时序', () => {
  assert.deepEqual(
    steps.map((s) => s.id),
    ['d1-a', 'd2-a', 'd2-b', 'd3-a']
  )
  assert.deepEqual(
    steps.map((s) => [s.dayNo, s.posInDay, s.dayLen]),
    [
      [0, 0, 1],
      [1, 0, 2],
      [1, 1, 2],
      [2, 0, 1]
    ]
  )
})

await spec('天切换游标：firstStepOfDay 命中各天首站', () => {
  assert.equal(firstStepOfDay(steps, 0), 0)
  assert.equal(firstStepOfDay(steps, 1), 1)
  assert.equal(firstStepOfDay(steps, 2), 3)
  assert.equal(firstStepOfDay(steps, 9), -1)
})

await spec('polyline 截取：只画走过的一段；单点天画不出线', () => {
  const seg = sequencePolyline(steps, 1, 1)
  assert.equal(seg.length, 2)
  assert.deepEqual(seg[0], stepPoint(steps[1]))
  assert.deepEqual(seg[1], stepPoint(steps[2]))
  assert.equal(sequencePolyline(steps, 0, 0).length, 0) // 单点天
  assert.equal(sequencePolyline(steps, 1, -1).length, 0) // 负游标护栏
})

console.log('· 字幕与摘要')

await spec('字幕：定时/未定时的两种格式', () => {
  assert.equal(replaySubtitle(steps[1]), '第 2 天 · 09:00 · d2-a')
  assert.equal(replaySubtitle(steps[0]), '第 1 天 · 10:00 · d1-a')
  assert.equal(replaySubtitle(null), '')
})

await spec('里程：0.01° 经差 + 0.01° 纬差 ≈ 1.47 公里（勾股叠加）', () => {
  const km = dayDistanceKm(steps, 1)
  assert.ok(km > 1.4 && km < 1.55, `km=${km}`)
  assert.equal(dayDistanceKm(steps, 0), 0)
  assert.equal(kmLabel(0.964), '964m')
  assert.equal(kmLabel(km), '1.5km')
})

const briefs = dayBriefs(days, items)

await spec('逐日摘要：站数/首末点名/日期（无坐标天为 0 站空名）', () => {
  assert.equal(briefs.length, 3)
  assert.deepEqual(
    briefs.map((b) => b.no),
    [0, 1, 2]
  )
  const d2 = briefs[1]
  assert.equal(d2.count, 2)
  assert.equal(d2.first, 'd2-a')
  assert.equal(d2.last, 'd2-b')
  assert.equal(d2.date, '2026-03-02')
  assert.ok(d2.km > 1.4 && d2.km < 1.55)
  assert.equal(briefs[2].count, 1)
  assert.equal(briefs[2].first, 'd3-a')
})

console.log('· 海报')

await spec('海报数据：区间/站数/人数', () => {
  const data = replayPosterData(
    { title: '春熙路两日', destination: '成都', startDate: '2026-03-01', endDate: '2026-03-03' },
    briefs,
    4
  )
  assert.equal(data.range, '03/01 → 03/03')
  assert.equal(data.points, 4)
  assert.equal(data.peopleCount, 4)
  const single = replayPosterData(
    { title: '一日', destination: '成都', startDate: '2026-03-01', endDate: '2026-03-01' },
    briefs.slice(0, 1),
    2
  )
  assert.equal(single.range, '03/01')
})

await spec('测高：随天数据条数增长，且不少于底带', () => {
  const data = replayPosterData(
    { title: 't', destination: 'd', startDate: '2026-03-01', endDate: '2026-03-03' },
    briefs,
    2
  )
  const h = replayPosterHeight(data)
  const h1 = replayPosterHeight({ ...data, days: briefs.slice(0, 1) })
  assert.ok(h > h1)
  assert.ok(h > 600)
})

await spec('绘制冒烟：假 ctx 跑完不炸、品牌带颜色来自 CANVAS_PALETTE', () => {
  const calls: string[] = []
  const ctx: any = new Proxy(
    {
      beginPath: () => calls.push('beginPath'),
      moveTo: () => {},
      arcTo: () => {},
      closePath: () => {},
      fill: () => calls.push('fill'),
      fillRect: () => calls.push('fillRect'),
      fillText: () => calls.push('fillText')
    },
    {
      set(target, key, value) {
        if (key === 'fillStyle') calls.push(`fillStyle:${value}`)
        return Reflect.set(target, key, value)
      },
      get(target, key) {
        return (target as any)[key]
      },
      has: () => true
    }
  )
  const data = replayPosterData(
    { title: '春熙路两日', destination: '成都', startDate: '2026-03-01', endDate: '2026-03-03' },
    briefs,
    4
  )
  drawReplayPoster(ctx, 750, replayPosterHeight(data), data)
  ok('有填充与文字', calls.includes('fillRect') && calls.includes('fillText'))
  ok('品牌带用 brandDeep（白字对比度口径）', calls.some((c) => c === 'fillStyle:#12724F'))
})

console.log(`\n===== 行程回放结果：${passed} 通过 / ${process.exitCode ? '有失败' : '0 失败'} =====`)
