/**
 * 行程校验器 —— AI 生成/手动编辑的行程项做一轮机械体检，问题打「待核实」。
 *
 * 为什么不落盘：所有规则都能从 ItineraryItem 本身（lat/lng/time/duration/address）
 * 幂等重算，结果不进 LWW 同步 —— 每次打开页面现算就好。唯一的持久化是人工核销
 * 的 `ItineraryItem.verifiedAt`（用户「现场确认」时写时间戳，走 updateItem 正常盖章）。
 *
 * 为什么是注入式 route：amap 步行/驾车查询有 QPS 配额，一天 N 项最多 N-1 对相邻
 * 查询，且拿不到路线（境外/断网/限流）就静默降级 —— 该规则只出「待核实」不报错，
 * 绝不打扰行程主流程。配置 route 时才出网；测试里注入 fake 构造各种路线。
 *
 * 纯函数模块：不 import 任何 uni / store 依赖，靠 esbuild 打包就能在 Node 里单测
 * （scripts/itin-check-test.mjs），也方便孪生到其它端。
 */
import type { ItineraryItem } from '@/types'

export interface RouteLike {
  /** 米 */
  distance: number
  /** 秒 */
  duration: number
}

export interface LatLike {
  lat: number
  lng: number
}

export type RouteFetcher = (from: LatLike, to: LatLike) => Promise<RouteLike | null>

export type ItinIssueRule =
  | 'overlap'      // 同日时间倒挂/重叠
  | 'overload'     // 当日总时长超载
  | 'tight'        // 实测移动时间 > 两项之间的空闲间隔
  | 'gap'          // 相邻两地 > 3km 却没有交通项
  | 'jump'         // 同日 > 200km，疑似跨城没覆盖
  | 'no-location'  // 有地点但缺坐标，距离类规则核验不了
  | 'bad-data'     // 字段异常（负花销/非法时间/空标题）
  | 'dupe'         // 同日两点位 < 50m，疑似重复

export interface ItinIssue {
  rule: ItinIssueRule
  level: 'error' | 'warn'
  dayId: string
  /** 关联行程项 id，通常 1–2 个 */
  itemIds: string[]
  /** 给用户的一句话 */
  title: string
  /** 建议的修法（UI 上直接展示） */
  hint: string
}

export interface CheckOptions {
  /** 注入高德路线查询；缺省则跳过 tight 规则（其余规则都不需要出网） */
  route?: RouteFetcher
  /** route 结果缓存：命中即不再请求，跨次调用复用 */
  routeCache?: Map<string, RouteLike | null>
}

/** 相邻 pair 的路线待查项（暂存在一次 checkItinerary 的闭包里） */
interface PendingPair {
  a: ItineraryItem
  b: ItineraryItem
  km: number
}

// ── 时间与小工具 ──────────────────────────────────────────────────────────────

/** '09:30' → 570；空串返回 null（= 未定时，合法跳过时间规则）；非法格式返回 NaN */
export function timeMinOf(time: string | undefined | null): number | null {
  if (!time) return null
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) return NaN
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

/** 球面大圆距离（km）。POI 间距判定够用 */
export function kmBetween(a: LatLike, b: LatLike): number {
  const R = 6371
  const toRad = (v: number) => (v * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function hasCoords(it: ItineraryItem): boolean {
  return (
    Number.isFinite(it.lat) &&
    Number.isFinite(it.lng) &&
    !(it.lat === 0 && it.lng === 0)
  )
}

function fmtKm(km: number): string {
  return km >= 1 ? `${km.toFixed(1)}km` : `${Math.round(km * 1000)}m`
}

/** 当天展示顺序（与页面一致：无时间排最后，同时间按 order） */
function displayList(list: ItineraryItem[]): ItineraryItem[] {
  return [...list].sort((a, b) => {
    const ta = a.time || '99:99'
    const tb = b.time || '99:99'
    if (ta !== tb) return ta.localeCompare(tb)
    return a.order - b.order
  })
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

/**
 * 校验一个行程的全部条目（内部按 dayId 分组）。返回问题列表。
 * route 查询串行（一天相邻顶多 7 次请求），命中 routeCache 就不发请求。
 */
export async function checkItinerary(
  items: ItineraryItem[],
  opts: CheckOptions = {}
): Promise<ItinIssue[]> {
  const issues: ItinIssue[] = []
  const pending: PendingPair[] = []

  // 按 dayId 分桶，桶内按展示顺序跑规则
  const groups = new Map<string, ItineraryItem[]>()
  for (const it of items) {
    const arr = groups.get(it.dayId)
    if (arr) arr.push(it)
    else groups.set(it.dayId, [it])
  }

  for (const [dayId, raw] of groups) {
    const list = displayList(raw)
    pushFieldIssues(issues, dayId, list)
    pushOverlapIssues(issues, dayId, list)
    pushOverloadIssue(issues, dayId, list)
    pushDupeIssues(issues, dayId, list)
    gatherPairIssues(issues, pending, !!opts.route, dayId, list)
  }

  await resolveTightIssues(issues, pending, opts)
  return issues
}

// ── 各规则 ───────────────────────────────────────────────────────────────────

/** R6 字段质量（零成本） */
function pushFieldIssues(out: ItinIssue[], dayId: string, list: ItineraryItem[]): void {
  for (const it of list) {
    const bits: string[] = []
    const name = it.title || '未命名'
    if (!it.title.trim()) bits.push('标题为空')
    if (it.duration <= 0) bits.push('停留时长应当 > 0')
    if (it.cost < 0) bits.push('花销不应为负数')
    if (it.time && Number.isNaN(timeMinOf(it.time))) bits.push(`时间 ${it.time} 格式不对`)
    if (bits.length) {
      out.push({
        rule: 'bad-data',
        level: 'warn',
        dayId,
        itemIds: [it.id],
        title: `「${name}」字段有问题：${bits.join('；')}`,
        hint: '打开编辑详情修正后自动消除'
      })
    }
    // 缺坐标：距离/衔接类规则（gap/tight/jump/dupe）全部套不上，单独标出来
    if (it.type !== 'transport' && !hasCoords(it)) {
      out.push({
        rule: 'no-location',
        level: 'warn',
        dayId,
        itemIds: [it.id],
        title: `「${name}」没有定位，没法核验距离与衔接`,
        hint: '在编辑详情补充地址/坐标，地图搜索可自动回填'
      })
    }
  }
}

/** R1 时间倒挂/重叠：把成链的重叠并成一条，链上成员都列出来 */
function pushOverlapIssues(out: ItinIssue[], dayId: string, list: ItineraryItem[]): void {
  const timed = list
    .map((it) => ({ it, start: timeMinOf(it.time) }))
    .filter((t): t is { it: ItineraryItem; start: number } => typeof t.start === 'number')
    .sort((a, b) => a.start - b.start)

  const chains: Array<{ it: ItineraryItem; end: number }[]> = []
  for (const { it, start } of timed) {
    const end = start + it.duration
    const chain = chains[chains.length - 1]
    if (chain && start < chain[chain.length - 1].end) chain.push({ it, end })
    else chains.push([{ it, end }])
  }

  for (const chain of chains) {
    if (chain.length < 2) continue
    const names = chain.map((c) => c.it.title || '未命名')
    out.push({
      rule: 'overlap',
      level: 'error',
      dayId,
      itemIds: chain.map((c) => c.it.id),
      title: `${names.join(' 与 ')} 时间重叠`,
      hint: '把时间错开，点一下「重排」也能自动顺序展开'
    })
  }
}

/** R2 当日超载：非 stay 的时长总和 > 11h */
const DAY_CAP_MINUTES = 660

function pushOverloadIssue(out: ItinIssue[], dayId: string, list: ItineraryItem[]): void {
  const total = list.reduce((s, i) => (i.type === 'stay' ? s : s + i.duration), 0)
  if (total <= DAY_CAP_MINUTES) return
  out.push({
    rule: 'overload',
    level: 'warn',
    dayId,
    itemIds: list.map((i) => i.id),
    title: `这天安排了 ${(total / 60).toFixed(1)} 小时，超出一天的合理承载`,
    hint: '删掉一两个点，或把离得近的点挪到前/后一天'
  })
}

/** R7 同 POI 重复：同日两点 < 50m */
const DUPE_KM = 0.05

function pushDupeIssues(out: ItinIssue[], dayId: string, list: ItineraryItem[]): void {
  const valid = list.filter(hasCoords)
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      if (kmBetween(valid[i], valid[j]) >= DUPE_KM) continue
      out.push({
        rule: 'dupe',
        level: 'warn',
        dayId,
        itemIds: [valid[i].id, valid[j].id],
        title: `「${valid[i].title}」和「${valid[j].title}」几乎是同一处`,
        hint: '两条其实是同一个点位，删掉一条即可'
      })
    }
  }
}

/**
 * R3 gap：相邻两点 > 3km 且两侧都不是 transport → 缺交通；
 * R4 jump：> 200km → error；带 route 的调用把 pair 暂存进 pending 等 tight。
 */
const NEAR_KM = 3
const JUMP_KM = 200

function gatherPairIssues(
  out: ItinIssue[],
  pending: PendingPair[],
  withRoute: boolean,
  dayId: string,
  list: ItineraryItem[]
): void {
  const arr = displayList(list)
  for (let i = 0; i + 1 < arr.length; i++) {
    const a = arr[i]
    const b = arr[i + 1]
    if (!hasCoords(a) || !hasCoords(b)) continue
    if (a.type === 'transport' || b.type === 'transport') continue

    const km = kmBetween(a, b)
    if (km > JUMP_KM) {
      out.push({
        rule: 'jump',
        level: 'error',
        dayId,
        itemIds: [a.id, b.id],
        title: `${a.title} → ${b.title} 相隔 ${fmtKm(km)}，一天内跨这么远要重新排`,
        hint: '拆到两天，或补一个城际交通项'
      })
      continue
    }
    if (km > NEAR_KM) {
      out.push({
        rule: 'gap',
        level: 'warn',
        dayId,
        itemIds: [a.id, b.id],
        title: `${a.title} → ${b.title} 相距 ${fmtKm(km)}，中间没有交通安排`,
        hint: '补一个交通项；近的话步行/打车接驳也比硬来强'
      })
      // 有 route 才值得进一步查实测用时（tight）；没有就到此为止
      if (withRoute) pending.push({ a, b, km })
    }
  }
}

/**
 * tight 规则：pending pair 之间实测路线耗时 > 两项间隔 → 「衔接太紧」。
 * any 失败（境外/断网/限流）静默跳过 —— 角标宁可保守也不误报。
 */
async function resolveTightIssues(
  issues: ItinIssue[],
  pending: PendingPair[],
  opts: CheckOptions
): Promise<void> {
  const { route, routeCache } = opts
  if (!route || !pending.length) return

  for (const { a, b } of pending) {
    const cacheKey = `${a.id}|${b.id}`
    let r = routeCache?.get(cacheKey)
    if (r === undefined) {
      try {
        const got = await route({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng })
        r = got ?? null
      } catch {
        r = null
      }
      routeCache?.set(cacheKey, r)
    }
    if (!r) continue

    const aStart = timeMinOf(a.time)
    const bStart = timeMinOf(b.time)
    if (aStart == null || bStart == null) continue
    if (Number.isNaN(aStart) || Number.isNaN(bStart)) continue
    const needMin = Math.ceil(r.duration / 60)
    const gapMin = bStart - (aStart + a.duration)
    // gapMin < 0 已由 R1 overlap 报过；这里只报「赶得上但塞不下」的紧衔接
    if (gapMin >= 0 && gapMin < needMin) {
      issues.push({
        rule: 'tight',
        level: 'warn',
        dayId: a.dayId,
        itemIds: [a.id, b.id],
        title: `${a.title} → ${b.title} 实测移动约 ${needMin} 分钟，间隔只有 ${gapMin} 分钟`,
        hint: '把下一项往后推，或接受走马观花式赶路'
      })
    }
  }
}
