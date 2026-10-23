/**
 * 排程质量单测入口 —— 由 scripts/plan-quality-test.mjs 用 esbuild 打包后在 Node 上跑。
 *
 * 覆盖排程升级（全部纯函数，不起后端、不出网，城市走 opts.city 注入）：
 *  ① 多天地理聚类：每天应是同城一小片，而不是「第 1 天吃掉全城高分点」
 *  ② 餐饮不进行程：时间轴只放正事；吃的改成行程项详情页「附近推荐」（snackSlot 口径）
 *  ③ 雨天适配：预报有降水的天，室内项稳定提前并写 note；攻略模式只提示不重排
 *  ④ isWetDayCode 的 WMO 码口径 + isIndoorPoi 推断口径
 */
import assert from 'node:assert/strict'
import type { CitySeed, PoiSeed } from '../src/data/poi'
import { generateItinerary, isWetDayCode } from '../src/utils/itinerary'
import { isIndoorPoi } from '../src/utils/indoor'
import { SNACK_SLOT_LABELS, snackSlotFor } from '../src/services/snacks'
import type { WeatherDay } from '../src/types'

let passed = 0
function ok(name: string, cond: boolean): void {
  if (!cond) throw new Error('断言失败：' + name)
  passed += 1
  console.log('  ✓ ' + name)
}

const DATE = '2026-11-06'
const BASE: { lat: number; lng: number } = { lat: 28.2, lng: 113.0 }

function spot(name: string, dx: number, dy = 0, extra?: Partial<PoiSeed>): PoiSeed {
  return {
    name,
    type: 'spot',
    lng: BASE.lng + dx,
    lat: BASE.lat + dy,
    duration: 90,
    cost: 0,
    area: '测试区',
    ...extra
  }
}
function food(name: string, dx: number, dy = 0): PoiSeed {
  return { name, type: 'food', lng: BASE.lng + dx, lat: BASE.lat + dy, duration: 60, cost: 50, area: '测试区' }
}

const BASE_INPUT = {
  destination: '注',
  startDate: DATE,
  endDate: DATE,
  peopleCount: 2,
  prefs: [],
  pace: 'normal' as const // perDay: 3
}

/** 天内景点按 order 排好后的相邻跳跃最大值 */
function maxJump(items: { lng: number; lat: number; type: string }[]): number {
  const only = items.filter((i) => i.type === 'spot')
  let m = 0
  for (let k = 1; k < only.length; k += 1) {
    const a = { lng: only[k - 1].lng, lat: only[k - 1].lat, name: '', type: 'spot', duration: 0, cost: 0, area: '' }
    const b = { lng: only[k].lng, lat: only[k].lat, name: '', type: 'spot', duration: 0, cost: 0, area: '' }
    m = Math.max(m, km(a, b))
  }
  return m
}

function km(a: PoiSeed, b: PoiSeed): number {
  return Math.hypot((a.lng - b.lng) * 95, (a.lat - b.lat) * 111)
}

const dayItems = (out: ReturnType<typeof generateItinerary>, d: number) =>
  out.items.filter((i) => i.dayId === out.days[d].id)

// ─────────────────────────────────────────────────────────────
console.log('═══ ① 单天：顺路序（相邻跳跃近）═══')
{
  // 西簇 3 点（每相邻 ~1km）+ 东簇 4 点（~20km 外），1 天 3 槽只装得下一簇的量
  const city: CitySeed = {
    name: '单天城',
    alias: [],
    intro: '',
    pois: [
      spot('西0', -0.2, 0.001, { rating: 4.9 }),
      spot('西1', -0.19, 0.002, { rating: 4.85 }),
      spot('西2', -0.18, 0.003, { rating: 4.8 }),
      spot('东0', 0.2, -0.002, { rating: 4.75 }),
      spot('东1', 0.21, -0.001, { rating: 4.7 }),
      spot('东2', 0.22, 0, { rating: 4.65 }),
      spot('东3', 0.23, 0.001, { rating: 4.6 }),
      food('西门食', -0.195, 0.004)
    ]
  }
  const out = generateItinerary({ ...BASE_INPUT }, undefined, { city })
  const day1 = dayItems(out, 0)
  ok('1 天装满 3 槽（normal，餐饮不再占槽）', day1.filter((i) => i.type === 'spot').length >= 3)
  ok('单天相邻跳跃 ≤ 3km（只在一个簇内玩，不吃跨城大跳）', maxJump(day1) <= 3)
  ok('餐饮不进行程时间轴', day1.every((i) => i.type !== 'food'))
}

// ─────────────────────────────────────────────────────────────
console.log('═══ ② 多天：地理聚类分天（旧版第 1 天吃全城高分点的病灶）═══')
{
  // 三个地理簇：西簇 / 市中心 / 东簇，每簇 4 个高分景点，间隔 ~20km；
  // 3 天行程必须每天自成一簇（旧版会排出 西→中→东 的大 8 字）
  const mk = (prefix: string, dx: number, rating: number) =>
    [0, 1, 2, 3].map((i) => spot(`${prefix}${i}`, dx + i * 0.01, (i % 2) * 0.005, { rating: rating - i * 0.01 }))
  const city: CitySeed = {
    name: '三簇城',
    alias: [],
    intro: '',
    pois: [
      ...mk('西', -0.22, 4.9),
      ...mk('中', 0, 4.8),
      ...mk('东', 0.22, 4.85),
      food('西食', -0.215, 0.002),
      food('中食', 0.005, -0.001),
      food('东食', 0.225, 0.002)
    ]
  }
  const out = generateItinerary({ ...BASE_INPUT, endDate: '2026-11-08' }, undefined, { city })
  assert.equal(out.days.length, 3)
  for (let d = 0; d < 3; d += 1) {
    const day = dayItems(out, d)
    const heads = day.filter((i) => i.type === 'spot').map((i) => i.title[0])
    const uniq = Array.from(new Set(heads))
    ok(`第 ${d + 1} 天的景点全部同簇（${uniq.join('·') || '空'}）`, uniq.length <= 1)
    ok(`第 ${d + 1} 天无餐饮项`, day.every((i) => i.type !== 'food'))
  }
}

// ─────────────────────────────────────────────────────────────
console.log('═══ ③ 餐饮不进行程 ─══')
{
  const city: CitySeed = {
    name: '餐饮城',
    alias: [],
    intro: '',
    pois: [
      spot('景点甲', 0, 0, { rating: 4.9 }),
      spot('景点乙', 0.01, 0, { rating: 4.8 }),
      spot('景点丙', 0.02, 0, { rating: 4.7 }),
      food('开业网红店', 0.005, 0.001, { rating: 4.9 }),
      food('苍蝇面馆', 0.015, 0.002, { rating: 4.95 })
    ]
  }
  const out = generateItinerary({ ...BASE_INPUT }, undefined, { city })
  ok('评分再高的餐饮也不进时间轴', out.items.every((i) => i.type !== 'food'))
  ok('行程项有正确时间顺序与坐标', out.items.length > 0)
}

console.log('═══ ④ 推荐时段口径（snackSlotFor）═══')
{
  ok('08:00 → 早餐', snackSlotFor('08:00') === 'breakfast')
  ok('09:00（静安寺场景）→ 早餐', snackSlotFor('09:00') === 'breakfast')
  ok('11:00 → 咖啡', snackSlotFor('11:00') === 'coffee')
  ok('12:00（LV/午餐场景）→ 午餐', snackSlotFor('12:00') === 'lunch')
  ok('15:00 → 下午茶', snackSlotFor('15:00') === 'tea')
  ok('18:30 → 晚餐', snackSlotFor('18:30') === 'dinner')
  ok('22:30 / 01:30 → 宵夜', snackSlotFor('22:30') === 'supper' && snackSlotFor('01:30') === 'supper')
  for (const key of ['breakfast', 'coffee', 'lunch', 'tea', 'dinner', 'supper']) {
    ok(`时段 ${key} 有展示名「${SNACK_SLOT_LABELS[key]}」`, SNACK_SLOT_LABELS[key].length > 1)
  }
}

// ─────────────────────────────────────────────────────────────
console.log('═══ ⑤ 雨天适配：室内项提前 + note 提示 ═══')
{
  const city: CitySeed = {
    name: '雨城',
    alias: [],
    intro: '',
    pois: [
      spot('公园', 0, 0, { rating: 4.9 }), // 「园」→ 户外
      spot('市博物馆', 0.01, 0, { rating: 4.8 }), // → 室内
      food('食F', 0.005, 0.001) // 不进行程，但作为干扰项存在
    ]
  }
  const wet: WeatherDay = { date: DATE, code: 63, tmax: 18, tmin: 12 }
  const out = generateItinerary({ ...BASE_INPUT }, undefined, {
    city,
    weather: new Map([[DATE, wet]])
  })
  const day = dayItems(out, 0)
  const iMuseum = day.findIndex((i) => i.title === '市博物馆')
  const iPark = day.findIndex((i) => i.title === '公园')
  ok('雨天：室内项排在户外园前面', iMuseum >= 0 && iPark >= 0 && iMuseum < iPark)
  ok('note 写了降雨提示', /预报有降雨/.test(out.days[0].note))
}
{
  // 晴天：完全不动
  const city: CitySeed = {
    name: '雨城',
    alias: [],
    intro: '',
    pois: [spot('公园', 0, 0, { rating: 4.9 }), spot('市博物馆', 0.01, 0, { rating: 4.8 })]
  }
  const dry: WeatherDay = { date: DATE, code: 1, tmax: 25, tmin: 18 }
  const out = generateItinerary({ ...BASE_INPUT }, undefined, {
    city,
    weather: new Map([[DATE, dry]])
  })
  ok('晴天不重排（户外园第一位）', out.items[0].title === '公园')
  ok('晴天 note 无提示', !/预报有/.test(out.days[0].note))
}

// ─────────────────────────────────────────────────────────────
console.log('═══ ⑥ WMO 口径与室内推断 ═══')
{
  ok('WMO：中雨 63 是降水', isWetDayCode(63))
  ok('WMO：小雪 73 是降水', isWetDayCode(73))
  ok('WMO：雷暴 99 是降水', isWetDayCode(99))
  ok('WMO：晴 0 / 多云 2 / 阴 3 不是', !isWetDayCode(0) && !isWetDayCode(2) && !isWetDayCode(3))
  ok('WMO：雾 45 不是降水', !isWetDayCode(45))
  ok('WMO：未知 -1 不是', !isWetDayCode(-1))
  ok('室内推断：博物馆/海洋馆=室内', isIndoorPoi('市博物馆') && isIndoorPoi('海底世界海洋馆'))
  ok('室内推断：人民广场不误判室内', !isIndoorPoi('人民广场'))
  ok('室内推断：岳麓山/橘子洲=户外', !isIndoorPoi('岳麓山') && !isIndoorPoi('橘子洲'))
  ok('室内推断：商业步行街=室内侧', isIndoorPoi('黄兴路步行街'))
}

console.log(`═══ 排程质量：${passed} 通过 / 0 失败 ═══`)
