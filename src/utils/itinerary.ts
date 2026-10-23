import type { Day, ItineraryItem, ItemType } from '@/types'
import { CITIES, matchCity, isKnownCity } from '@/data/poi'
import type { PoiSeed, CitySeed } from '@/data/poi'
import { getGuide, type CityGuide } from '@/data/guides'
import { buildCityFromAmap } from '@/services/cityPoi'
import { uid } from '@/utils/id'
import { addDays, daysBetween } from '@/utils/format'

/** 该城市是否在本地经典路线库里（在线库城市没有攻略兜底） */
function guideHasPlan(city: CitySeed): boolean {
  return !!getGuide(city.name)
}

export type PaceLevel = 'relax' | 'normal' | 'packed'

export interface GenerateInput {
  destination: string
  startDate: string
  endDate: string
  /** 同行人数，用于节奏参考 */
  peopleCount: number
  /** 偏好标签 */
  prefs: string[]
  pace: PaceLevel
}

export interface GenerateOutput {
  days: Day[]
  items: ItineraryItem[]
  /** 生成说明，用于向用户交代策略 */
  summary: string
}

/** 偏好标签 -> 影响排序的权重规则 */
export const PREF_OPTIONS = [
  { key: 'nature', label: '自然风光' },
  { key: 'history', label: '历史人文' },
  { key: 'food', label: '美食探店' },
  { key: 'night', label: '夜生活' },
  { key: 'art', label: '艺术展馆' },
  { key: 'shopping', label: '逛街购物' },
  { key: 'family', label: '亲子友好' },
  { key: 'chill', label: '轻松躺平' }
] as const

const PACE_SLOTS: Record<PaceLevel, { start: string; perDay: number }> = {
  relax: { start: '10:00', perDay: 2 },
  normal: { start: '09:00', perDay: 3 },
  packed: { start: '08:30', perDay: 4 }
}

const PACE_LABEL: Record<PaceLevel, string> = {
  relax: '松弛',
  normal: '标准',
  packed: '紧凑'
}

/** 相邻两点的球面距离（公里），用于把顺路的点排到一起 */
function distanceKm(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const la1 = (a.lat * Math.PI) / 180
  const la2 = (b.lat * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** 打分：偏好标签越高分，越优先入选 */
function scorePoi(poi: PoiSeed, prefs: string[]): number {
  let s = 0
  if (prefs.includes('nature') && poi.type === 'spot' && poi.area.includes('山')) s += 3
  if (prefs.includes('nature') && (poi.name.includes('公园') || poi.name.includes('生态') || poi.name.includes('湿地'))) s += 2
  if (prefs.includes('history') && (poi.name.includes('博物馆') || poi.name.includes('遗址') || poi.name.includes('古城') || poi.name.includes('寺') || poi.name.includes('塔'))) s += 3
  if (prefs.includes('history') && poi.type === 'spot' && poi.cost > 0) s += 1
  if (prefs.includes('food') && poi.type === 'food') s += 4
  if (prefs.includes('night') && poi.best === 'night') s += 4
  if (prefs.includes('night') && poi.best === 'evening') s += 2
  if (prefs.includes('art') && (poi.name.includes('艺术') || poi.name.includes('记忆') || poi.name.includes('博物'))) s += 3
  if (prefs.includes('shopping') && (poi.name.includes('太古') || poi.name.includes('步行街') || poi.name.includes('市场') || poi.name.includes('中心'))) s += 3
  if (prefs.includes('family') && (poi.name.includes('熊猫') || poi.name.includes('植物园') || poi.name.includes('海洋') || poi.name.includes('水世界'))) s += 3
  if (prefs.includes('chill') && poi.duration <= 90) s += 1
  if (prefs.includes('chill') && poi.cost === 0) s += 1
  // 经典必去项保底加权
  if (poi.name.includes('熊猫') || poi.name.includes('兵马俑') || poi.name.includes('鼓浪屿')) s += 2.5
  if (poi.name.includes('洱海') || poi.name.includes('古城') || poi.name.includes('洪崖洞')) s += 1.5
  // 高德在线库的评分加权（0-5 分映射到最高 +3）：4.8 分相当于 +2.9
  if (poi.rating) s += (poi.rating - 3.5) * 2
  return s
}

/** 时间槽：根据次序和停留时长推进 */
function slotTime(start: string, index: number, gapMinutes: number[], baseGap = 30): string {
  const [h, m] = start.split(':').map(Number)
  let total = h * 60 + m
  for (let i = 0; i < index; i += 1) {
    total += (gapMinutes[i] || 90) + baseGap
  }
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** 打选好的候选点位、排完天、铺完时间轴，逐个环节向页面「播报」 —— 流式渐显的节点 */
export type GenStage = 'fetch' | 'score' | 'plan' | 'timeline'

export interface GenStageInfo {
  /** score/timeline：条数 */
  count?: number
  /** plan：天数 */
  days?: number
}

export type GenStageSink = (stage: GenStage, info: GenStageInfo) => void

/**
 * 规则引擎生成行程草稿（同步入口）。
 * 思路：选出候选 POI -> 打散远郊 -> 按地理近邻聚类分天 -> 按时间槽排布
 *
 * 目的地在本地 6 城库里时直接同步生成；不在时走异步入口（先问高德）。
 * onStage 是可选的进度播报：生成器仍是「一次算完再返回」，阶段标记只是
 * 给页面做流式渐显的锚点（页面自己排队逐字打出，见 TripGeneratePage）。
 */
export function generateItinerary(
  input: GenerateInput,
  onStage?: GenStageSink
): GenerateOutput {
  const city = matchCity(input.destination)
  const known = isKnownCity(input.destination)
  const totalDays = Math.max(1, daysBetween(input.startDate, input.endDate))
  const pace = PACE_SLOTS[input.pace] || PACE_SLOTS.normal
  const prefs = input.prefs || []

  return assemble(city, known, input, totalDays, pace, prefs, onStage)
}

/**
 * 异步入口：本地库未命中时先拉高德在线库，抓不到再回退本地模板。
 * 页面层统一走这个（generateItinerary 保留给旧调用方/测试）。
 */
export async function generateItineraryAsync(
  input: GenerateInput,
  onStage?: GenStageSink
): Promise<GenerateOutput> {
  const known = isKnownCity(input.destination)
  const totalDays = Math.max(1, daysBetween(input.startDate, input.endDate))
  const pace = PACE_SLOTS[input.pace] || PACE_SLOTS.normal
  const prefs = input.prefs || []

  if (!known) {
    // 在线拉取要 1-2s，是整个链路里最值得先「流」出来的环节
    onStage?.('fetch', {})
    const online = await buildCityFromAmap(input.destination)
    if (online) {
      const out = assemble(online, true, input, totalDays, pace, prefs, onStage)
      return out
    }
    // 在线抓取失败（断网/限流/地名检索质量差）：明确报错让用户重试。
    // ⚠️ 绝不能静默回退 matchCity —— 那会兜底到 CITIES[0]（成都），用户要洛阳
    // 却拿到一份成都的行程，比失败糟糕得多。
    throw new Error(
      `未能从高德拉取「${input.destination}」的点位（可能在限流或断网），请稍后重试`
    )
  }

  const city = matchCity(input.destination)
  return assemble(city, known, input, totalDays, pace, prefs, onStage)
}

/** 组装：选攻略/规则引擎排布 -> 生成天与行程项 -> 交代策略 */
function assemble(
  city: CitySeed,
  known: boolean,
  input: GenerateInput,
  totalDays: number,
  pace: { start: string; perDay: number },
  prefs: string[],
  onStage?: GenStageSink
): GenerateOutput {
  onStage?.('score', { count: city.pois.length })
  const days: Day[] = []
  for (let i = 0; i < totalDays; i += 1) {
    days.push({
      id: uid('day'),
      tripId: '',
      date: addDays(input.startDate, i),
      index: i,
      title: `第 ${i + 1} 天`,
      note: ''
    })
  }

  // ---- 经典路线优先：命中攻略库则按真人玩法排布 ----
  const guide = getGuide(city.name)
  onStage?.('plan', { days: totalDays })
  const plan: PoiSeed[][] = guide
    ? guidePlan(city, guide, totalDays, pace)
    : ruleEnginePlan(city, totalDays, pace, prefs)

  // 攻略模式：用主题作当天标题，提示写入 day.note
  if (guide) {
    guide.days.slice(0, totalDays).forEach((gd, i) => {
      if (days[i]) {
        days[i].title = gd.theme
        days[i].note = gd.tip || ''
      }
    })
  }

  // ---- 生成行程项 ----
  // plan 到这里**已经排好顺序**，直接铺上时间轴，不再重排：
  //   · 规则引擎模式：ruleEnginePlan 内部按「地理近邻 + 餐饮就近插入」排的顺路顺序 ——
  //     再按 morning/night 时段权重重排会把它打破。实测长沙 Day1 曾排出
  //     「岳麓书院 → 5km 外的东方红广场 → 折回旁边的岳麓山」，多绕 4km。
  //   · 攻略模式：真人玩法的主题顺序，本来就不该动。
  // （曾用布尔参数 preserveOrder 控制要不要重排，两个调用方语义不同却共用一个
  //   布尔值正是当时 bug 的源头；修完两路都要求保留，参数与重排分支一并删除。）
  const items: ItineraryItem[] = itemsFromPlan(plan, days, city.name, pace)
  onStage?.('timeline', { count: items.length })

  const summary = buildSummary(city.name, totalDays, input.pace, prefs, items, known, input.destination, guide)
  return { days, items, summary }
}

/** 取打分表里还没被用过的点 */
function queue2(scored: { poi: PoiSeed }[], plan: PoiSeed[][]): PoiSeed[] {
  const used = new Set<string>()
  plan.flat().forEach((p) => used.add(p.name))
  return scored.map((x) => x.poi).filter((p) => !used.has(p.name))
}

type PlanPace = { start: string; perDay: number }

/** 规则引擎排布（攻略库未命中时的兜底）：打分 -> 远郊分天 -> 地理近邻聚类 -> 补餐饮 */
function ruleEnginePlan(
  city: CitySeed,
  totalDays: number,
  pace: PlanPace,
  prefs: string[]
): PoiSeed[][] {
  const scored = city.pois
    .map((p) => ({ poi: p, score: scorePoi(p, prefs) }))
    .sort((a, b) => b.score - a.score)

  const dayTrips = scored.filter((x) => x.poi.dayTrip).map((x) => x.poi)
  const locals = scored.filter((x) => !x.poi.dayTrip).map((x) => x.poi)
  const spots = locals.filter((p) => p.type === 'spot')
  const foods = locals.filter((p) => p.type === 'food')

  const maxDayTrips = Math.min(dayTrips.length, Math.max(1, Math.floor(totalDays / 3)))
  const usedDayTrips = dayTrips.slice(0, totalDays >= 3 ? maxDayTrips : 0)

  const plan: PoiSeed[][] = Array.from({ length: totalDays }, () => [])

  const dayTripSlots: number[] = []
  for (let i = totalDays - 2; i >= 0 && dayTripSlots.length < usedDayTrips.length; i -= 1) {
    dayTripSlots.push(i)
  }
  if (totalDays <= 2 && usedDayTrips.length) dayTripSlots.push(0)
  usedDayTrips.forEach((poi, idx) => {
    const slot = dayTripSlots[idx]
    if (slot !== undefined) plan[slot].push(poi)
  })

  const dayTripDaySet = new Set(dayTripSlots.slice(0, usedDayTrips.length))

  const availableDays = Array.from({ length: totalDays }, (_, i) => i).filter(
    (i) => !dayTripDaySet.has(i)
  )

  if (availableDays.length) {
    const morningMust = spots.find((p) => p.best === 'morning')
    const spotPool = spots.filter((p) => p !== morningMust)
    const queue: PoiSeed[] = morningMust ? [morningMust, ...spotPool] : [...spotPool]
    // 每天景点槽位：本地库按 perDay-1 就够（餐饮会补位）；
    // 在线库没有「经典路线」兜底，景点就是行程主体，槽位放宽到 perDay 全额
    const isOnline = !guideHasPlan(city)
    const spotPerDay = isOnline ? pace.perDay : Math.max(1, pace.perDay - 1)

    let cursor = 0
    while (cursor < queue.length) {
      const dayIdx = availableDays.find(
        (i) => plan[i].filter((p) => p.type === 'spot').length < spotPerDay
      )
      if (dayIdx === undefined) break

      const current = plan[dayIdx]
      const anchor = current.length ? current[current.length - 1] : null
      if (!anchor) {
        current.push(queue[cursor])
        cursor += 1
        continue
      }
      let bestIdx = -1
      let bestDist = Infinity
      for (let k = cursor; k < queue.length; k += 1) {
        const d = distanceKm(anchor, queue[k])
        if (d < bestDist) {
          bestDist = d
          bestIdx = k
        }
      }
      if (bestIdx < 0) break
      current.push(queue[bestIdx])
      queue.splice(bestIdx, 1)
    }
  }

  const foodPool = [...foods]
  for (let dayIdx = 0; dayIdx < totalDays; dayIdx += 1) {
    if (dayTripDaySet.has(dayIdx) && plan[dayIdx].length === 1) continue
    const current = plan[dayIdx]
    if (!current.length) continue
    const need = Math.min(2, Math.max(1, Math.round(pace.perDay / 2)))
    for (let n = 0; n < need && foodPool.length; n += 1) {
      let bestIdx = 0
      let bestDist = Infinity
      foodPool.forEach((f, k) => {
        const d = Math.min(...current.map((a) => distanceKm(a, f)))
        if (d < bestDist) {
          bestDist = d
          bestIdx = k
        }
      })
      current.push(foodPool[bestIdx])
      foodPool.splice(bestIdx, 1)
    }
  }

  const leftover = [...foodPool, ...queue2(scored, plan)]
  for (let dayIdx = 0; dayIdx < totalDays; dayIdx += 1) {
    if (plan[dayIdx].length === 0 && leftover.length) {
      const take = leftover.splice(0, pace.perDay)
      plan[dayIdx].push(...take)
    }
  }

  return plan
}

/** 攻略排布：按经典路线每天的主题顺序直接铺，保留真人玩法的时间先后 */
function guidePlan(city: CitySeed, guide: CityGuide, totalDays: number, pace: PlanPace): PoiSeed[][] {
  const byName = new Map(city.pois.map((p) => [p.name, p]))
  const plan: PoiSeed[][] = Array.from({ length: totalDays }, () => [])
  guide.days.slice(0, totalDays).forEach((gd, i) => {
    gd.pois.forEach((name) => {
      const seed = byName.get(name)
      if (seed) plan[i].push(seed)
    })
  })
  // 攻略天数不够：剩余 POI 按节奏补满额外天
  if (totalDays > guide.days.length) {
    const used = new Set(plan.flat().map((p) => p.name))
    const leftover = city.pois.filter((p) => !used.has(p.name))
    let k = 0
    for (let i = guide.days.length; i < totalDays && k < leftover.length; i += 1) {
      const take = leftover.slice(k, k + pace.perDay)
      plan[i].push(...take)
      k += take.length
    }
  }
  return plan
}

/**
 * 把每天的点铺成行程项（编号 + 时间轴）。
 *
 * **不重排**：pois 已经由上游排好（规则引擎 = 地理顺路序，攻略 = 主题序），
 * 这里只负责按 order 编号、按 duration 推进时间。时段时间从 pace.start 起步、
 * 逐项推进，早晚节奏由上游排进顺序里的点自然呈现。
 */
function itemsFromPlan(
  plan: PoiSeed[][],
  days: Day[],
  cityName: string,
  pace: PlanPace
): ItineraryItem[] {
  const items: ItineraryItem[] = []
  plan.forEach((pois, dayIdx) => {
    const day = days[dayIdx]
    let running = pace.start
    pois.forEach((poi, order) => {
      items.push({
        id: uid('item'),
        dayId: day.id,
        tripId: '',
        order,
        time: running,
        type: poi.type,
        title: poi.name,
        address: poi.address || `${cityName} · ${poi.area}`,
        lat: poi.lat,
        lng: poi.lng,
        cost: poi.cost,
        duration: poi.duration,
        note: '',
        done: false
      })
      running = pushTime(running, poi.duration + 30)
    })
  })
  return items
}

function pushTime(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number)
  const total = h * 60 + m + minutes
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function buildSummary(
  city: string,
  daysCount: number,
  pace: PaceLevel,
  prefs: string[],
  items: ItineraryItem[],
  known: boolean,
  rawInput: string,
  guide?: CityGuide | null
): string {
  const prefLabels = prefs
    .map((p) => PREF_OPTIONS.find((o) => o.key === p)?.label)
    .filter(Boolean)
    .join('、')
  const parts = [`按${city} ${daysCount} 天、${PACE_LABEL[pace]}节奏生成`]
  if (prefLabels) parts.push(`偏好：${prefLabels}`)
  const source = guide ? ` · 参考${guide.source}` : ''
  parts.push(`共 ${items.length} 个安排${source}`)
  if (!known) {
    parts.push(`「${rawInput}」在线检索失败，已用${city}模板演示`)
  }
  return parts.join(' · ')
}

/** 可生成的目的地列表，用于选择器 */
export function availableCities(): { name: string; intro: string; count: number }[] {
  return CITIES.map((c) => ({
    name: c.name,
    intro: c.intro,
    count: c.pois.length
  }))
}
