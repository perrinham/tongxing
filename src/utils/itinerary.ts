import type { Day, ItineraryItem, ItemType, WeatherDay } from '@/types'
import { CITIES, matchCity, isKnownCity } from '@/data/poi'
import type { PoiSeed, CitySeed } from '@/data/poi'
import { getGuide, type CityGuide } from '@/data/guides'
import { buildCityFromAmap } from '@/services/cityPoi'
import { uid } from '@/utils/id'
import { addDays, daysBetween } from '@/utils/format'
import { isIndoorPoi } from '@/utils/indoor'
import { tasteBoost, type Taste } from '@/utils/taste'

/** 生成入口的附加选项 */
export interface GenOpts {
  /**
   * 逐日预报（date → WeatherDay）。给了就做雨天适配：
   * 预报当天有降水的日子，规则引擎排出的天把室内项稳定提前，并写 day.note 提示。
   * 异步入口可直接给 Promise（页面用「天气请求 + 生成请求并发」省一跳延迟）。
   */
  weather?: Map<string, WeatherDay> | Promise<Map<string, WeatherDay> | undefined>
  /**
   * 口味画像（utils/taste 从足迹推断）。样本 ≥2 才生效：选点温和加权，
   * 不碰地理聚类；攻略（真人玩法）模式不参与。
   */
  taste?: Taste
  /**
   * 测试注入口：直接喂合成城市，跳过 matchCity（matchCity 对未知地名会兜底
   * CITIES[0]，用它构造的合成城市根本进不了排程）。仅同步入口认这个字段。
   */
  city?: CitySeed
}

/** WMO 天气码 ≥51 都是降水：51-67 雨/冻雨，71-86 雪，95-99 雷暴（0-48 是晴/云/雾） */
export function isWetDayCode(code: number): boolean {
  return code >= 51 && code < 100
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
  onStage?: GenStageSink,
  opts?: { weather?: Map<string, WeatherDay>; taste?: Taste; city?: CitySeed }
): GenerateOutput {
  const city = opts?.city ?? matchCity(input.destination)
  const known = opts?.city ? true : isKnownCity(input.destination)
  const totalDays = Math.max(1, daysBetween(input.startDate, input.endDate))
  const pace = PACE_SLOTS[input.pace] || PACE_SLOTS.normal
  const prefs = input.prefs || []

  return assemble(city, known, input, totalDays, pace, prefs, onStage, opts?.weather, opts?.taste)
}

/**
 * 异步入口：本地库未命中时先拉高德在线库，抓不到再回退本地模板。
 * 页面层统一走这个（generateItinerary 保留给旧调用方/测试）。
 */
export async function generateItineraryAsync(
  input: GenerateInput,
  onStage?: GenStageSink,
  opts?: GenOpts
): Promise<GenerateOutput> {
  const known = isKnownCity(input.destination)
  const totalDays = Math.max(1, daysBetween(input.startDate, input.endDate))
  const pace = PACE_SLOTS[input.pace] || PACE_SLOTS.normal
  const prefs = input.prefs || []

  // 天气（Promise 支持页面「天气 + 生成并发」）：失败静默，天气永远不能变成报错
  let weather: Map<string, WeatherDay> | undefined
  if (opts?.weather) {
    try {
      weather = (await opts.weather) || undefined
    } catch {
      weather = undefined
    }
  }

  if (!known) {
    // 在线拉取要 1-2s，是整个链路里最值得先「流」出来的环节
    onStage?.('fetch', {})
    // 抓取失败时 buildCityFromAmap 会 throw 带具体原因（errMsg/LIMIT/INVALID_USER_KEY 等），
    // 包一层保留前缀，让真机上的报错一眼能定位（域名漏白名单 / key 过期 / 限流三种症状不同）
    const online = await buildCityFromAmap(input.destination).catch((e) => {
      throw new Error(
        `未能从高德拉取「${input.destination}」的点位（${(e as Error)?.message || e}），请稍后重试`
      )
    })
    if (online) {
      const out = assemble(online, true, input, totalDays, pace, prefs, onStage, weather, opts?.taste)
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
  return assemble(city, known, input, totalDays, pace, prefs, onStage, weather, opts?.taste)
}

/** 组装：选攻略/规则引擎排布 -> 天气适配 -> 生成天与行程项 -> 交代策略 */
function assemble(
  city: CitySeed,
  known: boolean,
  input: GenerateInput,
  totalDays: number,
  pace: { start: string; perDay: number },
  prefs: string[],
  onStage?: GenStageSink,
  weather?: Map<string, WeatherDay>,
  taste?: Taste
): GenerateOutput {
  // indoor 统一推断：内置库没标，在线库也没标 —— 一把尺子（utils/indoor）在装配口统一量
  const marked: CitySeed = {
    ...city,
    pois: city.pois.map((p) => ({
      ...p,
      indoor: p.indoor ?? isIndoorPoi(p.name, p.area)
    }))
  }
  onStage?.('score', { count: marked.pois.length })
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
  const guide = getGuide(marked.name)
  onStage?.('plan', { days: totalDays })
  const plan: PoiSeed[][] = guide
    ? guidePlan(marked, guide, totalDays, pace)
    : ruleEnginePlan(marked, totalDays, pace, prefs, taste)

  // 攻略模式：用主题作当天标题，提示写入 day.note
  if (guide) {
    guide.days.slice(0, totalDays).forEach((gd, i) => {
      if (days[i]) {
        days[i].title = gd.theme
        days[i].note = gd.tip || ''
      }
    })
  }

  // ---- 天气适配：预报有降水的日子，室内项排前面 + note 提示 ----
  adaptWeather(plan, days, weather, !!guide)

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

  const summary = buildSummary(marked.name, totalDays, input.pace, prefs, items, known, input.destination, guide, taste)
  return { days, items, summary }
}

/**
 * 天气适配：预报有降水的日子 ——
 *  · 规则引擎模式：把该天的室内项（food 一律算室内 + isIndoorPoi 命中）稳定提前，
 *    户外项整体后移（两侧各自保持地理顺路的相对顺序）。远郊 dayTrip 天只提示不重排
 *    （就一个点，无序可排）。
 *  · 攻略模式：真人玩法的主题顺序本就不该被算法打乱，只写 day.note 提示。
 * 没预报 / 没下雨的天一律不动。note 是追加而不是覆盖（攻略模式 note 上已有 tip）。
 */
function adaptWeather(
  plan: PoiSeed[][],
  days: Day[],
  weather: Map<string, WeatherDay> | undefined,
  isGuide: boolean
): void {
  if (!weather) return
  days.forEach((day, i) => {
    const w = weather.get(day.date)
    if (!w || !isWetDayCode(w.code)) return
    const pois = plan[i]
    if (pois?.length) {
      if (!isGuide && !(pois.length === 1)) {
        const indoor = pois.filter((p) => p.type === 'food' || p.indoor)
        const outdoor = pois.filter((p) => !(p.type === 'food' || p.indoor))
        if (indoor.length && outdoor.length) {
          plan[i] = [...indoor, ...outdoor]
        }
      }
    }
    const wetWord = w.code >= 71 && w.code < 95 ? '降雪' : '降雨'
    const tip = `预报有${wetWord}，${isGuide ? '经典路线顺序未动' : '已把室内项排前面'}，户外项建议带伞或调整`
    day.note = day.note ? `${day.note}；${tip}` : tip
  })
}

/** 取打分表里还没被用过的点。餐饮不进行程（改成行程项详情页的「附近推荐」，见 services/snacks.ts） */
function queue2(scored: { poi: PoiSeed }[], plan: PoiSeed[][]): PoiSeed[] {
  const used = new Set<string>()
  plan.flat().forEach((p) => used.add(p.name))
  return scored.map((x) => x.poi).filter((p) => !used.has(p.name) && p.type !== 'food')
}

type PlanPace = { start: string; perDay: number }

/**
 * 规划天序的排布（攻略库未命中时的兜底）。
 *
 * 三步：
 *  ① 远郊分天（dayTrip 点位单独占天，避免拖累市内行程）
 *  ② 多天地理聚类：先用「最远种子」给每天定一个空间重心，再轮转生长 ——
 *    每天 = 一小片地理区域，不会出现「第 1 天按分数铺开全城乱跑」
 *    （旧版逐天贪心从『当天最后一个点』捡最近的，第 1 天吃掉全城高分点，
 *    岳麓书院→东方红广场→折回岳麓山这种多绕 4km 的路线就是这么来的）
 *  ③ 餐饮就近且顺路：选「离当天任意点最近」的食物，插到路径增量最小的位置
 *    （不是无脑 append —— 否则午餐会排到一天的最后，顺序错乱）
 */
function ruleEnginePlan(
  city: CitySeed,
  totalDays: number,
  pace: PlanPace,
  prefs: string[],
  taste?: Taste
): PoiSeed[][] {
  const scored = city.pois
    .map((p) => ({ poi: p, score: scorePoi(p, prefs) + tasteBoost(p, taste) }))
    .sort((a, b) => b.score - a.score)

  const dayTrips = scored.filter((x) => x.poi.dayTrip).map((x) => x.poi)
  const locals = scored.filter((x) => !x.poi.dayTrip).map((x) => x.poi)
  const spots = locals.filter((p) => p.type === 'spot')

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
    // 每天景点槽位：餐饮不进行程后，位置全让给景点（perDay 全额）；
    // 攻略/本地/在线三路统一
    const spotPerDay = pace.perDay

    // —— 种子：给每天定一个地理重心（高分优先 + 空间分散） ——
    // morningMust 是必去，永远当第 0 天的种子；其余天按「与已有种子最远」选种，
    // 让各天天然散开成片区（市 7 区 vs 江对岸 vs 城东各占一天）而不是挤在同一片。
    const SEED_SEP_KM = 4
    const seeds: PoiSeed[] = []
    for (let d = 0; d < availableDays.length; d += 1) {
      if (!queue.length) break
      let idx = 0
      if (d > 0) {
        // 第 2 颗种子起：取「与已有种子距离都 ≥ SEED_SEP_KM 的最高分点」，
        // 让各天天然散成片区（市中心 vs 江对岸 vs 城东各占一天）；
        // 全城小而挤（任意两点 < 4km，线上小城常见）时找不到分散种子 ——
        // 退化为取队首，照常分天（小城本来就不需要分散）
        const SEP_KM = 4
        // 只看队头（高分）30 个：低分点不值得为了空间分散单独占天
        idx = -1
        for (let k = 0; k < queue.length && k < 30; k += 1) {
          if (seeds.every((q) => distanceKm(q, queue[k]) >= SEP_KM)) {
            idx = k
            break
          }
        }
        if (idx === -1) idx = 0
      }
      const s = queue.splice(idx, 1)[0]
      seeds.push(s)
      plan[availableDays[d]].push(s)
    }

    // —— 轮转生长：每天轮流从队列捡「离本天最后一个点最近」的未用点 ——
    // 循环占据保证几天同步长出（后长出来的天也能吃到高分点附近的点），
    // 而不是让第 0 天把队列前段消化完。
    let grew = true
    while (grew) {
      grew = false
      for (const dayIdx of availableDays) {
        const current = plan[dayIdx]
        if (current.filter((p) => p.type === 'spot').length >= spotPerDay) continue
        if (!current.length) continue
        const anchor = current[current.length - 1]
        let bestIdx = -1
        let bestDist = Infinity
        for (let k = 0; k < queue.length; k += 1) {
          const d = distanceKm(anchor, queue[k])
          if (d < bestDist) {
            bestDist = d
            bestIdx = k
          }
        }
        if (bestIdx < 0) continue
        current.push(queue[bestIdx])
        queue.splice(bestIdx, 1)
        grew = true
      }
      // 空天（种子耗尽后的多余天数）不被轮转管到 —— 由下面的 leftover 补位
    }
  }

  // 餐饮不再进行程：用户定的交互 —— 时间轴只放正事，吃的按「位置 + 时段」
  // 现查现推（行程项详情页的「附近的吃」，见 services/snacks.ts）。
  // 位置槽位全让给景点，多余的低分景点照旧留空不硬塞。
  const leftover = [...queue2(scored, plan)]
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
      // 餐饮不进行程（改行程项详情页「附近推荐」）；正文里的餐馆名仅在 summary 里占位
      if (seed && seed.type !== 'food') plan[i].push(seed)
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
  guide?: CityGuide | null,
  taste?: Taste
): string {
  const prefLabels = prefs
    .map((p) => PREF_OPTIONS.find((o) => o.key === p)?.label)
    .filter(Boolean)
    .join('、')
  const parts = [`按${city} ${daysCount} 天、${PACE_LABEL[pace]}节奏生成`]
  if (prefLabels) parts.push(`偏好：${prefLabels}`)
  // 个性化画像起效时向用户交代（没交代会像「随机改了行程」；样本不足时 brief 为空不出现）
  if (taste?.brief) parts.push(`按你的足迹：${taste.brief}`)
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
