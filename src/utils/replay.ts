import { CANVAS_PALETTE, shortDate } from './format'
import type { Day, ItineraryItem, ItemType } from '@/types'

/**
 * 行程回放 —— 借 motrix/Travel-Story「按天画线 + 逐点推进」的思想
 * （MIT，参考实现思路，代码自写）发给用户的轻量版：
 *
 *  · 回放 = 把一段行程的带坐标行程项按「天 → 时序」排成一条推进轨道，页面上
 *    用 wx `<map>` 画已走过的 polyline、逐点跳 marker/字幕；
 *  · 海报 = 纯排版（原生 map 组件截不了图），把逐日路线列成一张可保存/分享的图。
 *
 * 本文件放**纯函数**：排序、过滤、轨道推进、字幕、逐日摘要、海报绘制数据。
 * 全部不碰 uni/map API，可直接进 Node 单测（scripts/replay-entry.ts）。
 *
 * 颜色纪律与 utils/poster.ts 相同：**不许手写颜色字面量**，一律走 CANVAS_PALETTE。
 */
const P = CANVAS_PALETTE

/** 回放轨道上的一站」（已过滤无坐标项） */
export interface ReplayStep {
  id: string
  /** 天序（0 基） */
  dayNo: number
  date: string
  lat: number
  lng: number
  /** HH:mm，空 = 未定时 */
  time: string
  title: string
  type: ItemType
  done: boolean
  /** 天内序（0 基） */
  posInDay: number
  /** 当天带坐标的点数 */
  dayLen: number
}

export interface LatLng {
  latitude: number
  longitude: number
}

/** 有坐标才算回放点（lat/lng 都有值）。与 MapPage 的 geoItems 同个口径。 */
export function hasCoord(it: { lat: number; lng: number }): boolean {
  return !!it.lat && !!it.lng
}

/**
 * 天内排序：与 TripViewPage/ItineraryPage 的时序口径一致 ——
 * 「未定时（空 time）排最后（'99:99'）」，同时段再按 order。
 * 只留带坐标的点（无坐标项不进回放轨道）。
 */
export function orderDayItems(items: ItineraryItem[]): ItineraryItem[] {
  const list = items.filter(hasCoord)
  return list.sort((a, b) => {
    const t = (a.time || '99:99').localeCompare(b.time || '99:99')
    if (t !== 0) return t
    return a.order - b.order
  })
}

/** 全行程回放轨道：天按 index 升序，天内的点按时序；dayNo 连续推进 */
export function buildReplaySteps(days: Day[], items: ItineraryItem[]): ReplayStep[] {
  const sorted = [...days].sort((a, b) => a.index - b.index)
  const steps: ReplayStep[] = []
  sorted.forEach((day, dayNo) => {
    const dayItems = orderDayItems(items.filter((i) => i.dayId === day.id))
    dayItems.forEach((it, posInDay) => {
      steps.push({
        id: it.id,
        dayNo,
        date: day.date,
        lat: it.lat,
        lng: it.lng,
        time: it.time || '',
        title: it.title,
        type: it.type,
        done: !!it.done,
        posInDay,
        dayLen: dayItems.length
      })
    })
  })
  return steps
}

export function stepPoint(s: ReplayStep): LatLng {
  return { latitude: s.lat, longitude: s.lng }
}

/** 当前天已走过的一段（0..posInDay 含首位）。单点天返回空数组（画不出线）。 */
export function sequencePolyline(steps: ReplayStep[], dayNo: number, uptoPos: number): LatLng[] {
  const pts = steps.filter((s) => s.dayNo === dayNo).slice(0, Math.max(0, uptoPos + 1))
  if (pts.length < 2) return []
  return pts.map(stepPoint)
}

/** 天首站的全局下标：切天时把游标跳过去 */
export function firstStepOfDay(steps: ReplayStep[], dayNo: number): number {
  return steps.findIndex((s) => s.dayNo === dayNo)
}

/** 字幕：第 N 天 · HH:mm · 名称 */
export function replaySubtitle(s: ReplayStep | null): string {
  if (!s) return ''
  const t = s.time ? `${s.time} · ` : ''
  return `第 ${s.dayNo + 1} 天 · ${t}${s.title}`
}

/** 球面距离（km）。与 itinerary.distanceKm 同口径，不引它的内部实现避免互相牵动 */
function havKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6371
  const rad = (v: number) => (v * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** 一天的直线连贯长度（km）—— 天内按回放时序把点串起来 */
export function dayDistanceKm(steps: ReplayStep[], dayNo: number): number {
  const pts = steps.filter((s) => s.dayNo === dayNo)
  let sum = 0
  for (let i = 1; i < pts.length; i += 1) sum += havKm(pts[i - 1], pts[i])
  return sum
}

/** 逐日摘要（海报与回放页头部共用）：MM/DD、首末点名、站数、里程 */
export interface ReplayDayBrief {
  no: number
  date: string
  first: string
  last: string
  count: number
  km: number
}

export function dayBriefs(days: Day[], items: ItineraryItem[]): ReplayDayBrief[] {
  const steps = buildReplaySteps(days, items)
  const sorted = [...days].sort((a, b) => a.index - b.index)
  return sorted.map((d, no) => {
    const dd = steps.filter((s) => s.dayNo === no)
    return {
      no,
      date: d.date,
      first: dd[0]?.title || '',
      last: dd[dd.length - 1]?.title || '',
      count: dd.length,
      km: dayDistanceKm(steps, no)
    }
  })
}

/** 里程显示：< 1km 按米，其余一位小数 */
export function kmLabel(km: number): string {
  if (km <= 0) return ''
  return km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(km < 10 ? 1 : 0)}km`
}

/** 海报数据 + 绘制（纯排版：原生 map 组件截不了图，见文件头） */
export interface ReplayPosterData {
  title: string
  destination: string
  /** 形如 01/02 → 01/06；单日行程只有一截 */
  range: string
  days: ReplayDayBrief[]
  points: number
  peopleCount: number
}

export function replayPosterData(
  trip: { title: string; destination: string; startDate: string; endDate: string },
  briefs: ReplayDayBrief[],
  peopleCount: number
): ReplayPosterData {
  const start = shortDate(trip.startDate)
  const end = shortDate(trip.endDate)
  const range = start && end && start !== end ? `${start} → ${end}` : start || ''
  return {
    title: trip.title,
    destination: trip.destination,
    range,
    days: briefs,
    points: briefs.reduce((s, b) => s + b.count, 0),
    peopleCount
  }
}

const W = 750
const PAD = 48
const FONT = '-apple-system, "PingFang SC", "Helvetica Neue", sans-serif'
const BANNER = 268
const OVERVIEW = 96
const OVERLAP = 36 // 概览卡压进品牌带的深度（与结算海报同语言）
const TITLE_GAP = 56
const DAY_ROW = 96
const FOOTER = 118

export function posterWidth(): number {
  return W
}

export function replayPosterHeight(data: ReplayPosterData): number {
  const dayCount = Math.max(1, data.days.length)
  return BANNER - OVERLAP + OVERVIEW + 34 + TITLE_GAP + 52 + dayCount * DAY_ROW + 34 + FOOTER
}

function ellipsis(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function roundRect(
  ctx: CanvasRenderingContext2D | any,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function font(ctx: CanvasRenderingContext2D | any, weight: number, size: number) {
  ctx.font = `${weight} ${size}px ${FONT}`
}

/** 在 2D 上下文上绘制行程回放海报（坐标系已按 dpr 缩放，绘制使用逻辑像素 W×H） */
export function drawReplayPoster(
  ctx: CanvasRenderingContext2D | any,
  _W: number,
  H: number,
  data: ReplayPosterData
): void {
  ctx.fillStyle = P.bgPage
  ctx.fillRect(0, 0, W, H)

  /* 顶部品牌带用 brandDeep：白字压 brand 只有 3.18:1，压 deep 全字号都过
     （同一结论见 utils/poster.ts 的长注释，两处不再有两种写法） */
  ctx.fillStyle = P.brandDeep
  ctx.fillRect(0, 0, W, BANNER)

  ctx.textAlign = 'left'
  ctx.fillStyle = P.textInverse
  font(ctx, 400, 24)
  ctx.fillText('行程回放', PAD, 62)

  ctx.fillStyle = P.textInverse
  font(ctx, 500, 40)
  ctx.fillText(ellipsis(data.title, 13), PAD, 116)

  ctx.fillStyle = P.textInverse
  font(ctx, 400, 22)
  ctx.fillText(`${ellipsis(data.destination, 6)}${data.range ? ` · ${data.range}` : ''}`, PAD, 154)

  ctx.fillStyle = P.textInverse
  font(ctx, 400, 22)
  ctx.fillText(`走心整理 · ${data.peopleCount} 人同行`, PAD, 200)

  // 概览条（压进品牌带）
  ctx.fillStyle = P.bgCard
  roundRect(ctx, PAD, BANNER - OVERLAP, W - PAD * 2, OVERVIEW, 22)
  ctx.fill()

  const stats: [string, string][] =
    data.points > 0
      ? [
          ['天数', `${data.days.length} 天`],
          ['落脚点', `${data.points} 个`],
          ['总里程', dayKmTotal(data)],
          ['同行', `${data.peopleCount} 人`]
        ]
      : []
  if (stats.length) {
    const cellW = (W - PAD * 2) / stats.length
    stats.forEach(([label, value], i) => {
      const cx = PAD + 28 + i * cellW
      ctx.textAlign = 'left'
      ctx.fillStyle = P.textSecondary
      font(ctx, 400, 21)
      ctx.fillText(label, cx, BANNER - OVERLAP + 38)
      ctx.fillStyle = P.textPrimary
      font(ctx, 500, 27)
      ctx.fillText(value, cx, BANNER - OVERLAP + 72)
    })
  }

  // 逐日路线
  const y0 = BANNER - OVERLAP + OVERVIEW + 34
  ctx.textAlign = 'left'
  ctx.fillStyle = P.textPrimary
  font(ctx, 500, 30)
  ctx.fillText('逐日路线', PAD, y0 + 22)

  const cardY = y0 + TITLE_GAP
  const dayCount = Math.max(1, data.days.length)
  ctx.fillStyle = P.bgCard
  roundRect(ctx, PAD, cardY, W - PAD * 2, 52 + dayCount * DAY_ROW, 22)
  ctx.fill()

  if (!data.days.length) {
    ctx.fillStyle = P.textTertiary
    font(ctx, 400, 24)
    ctx.fillText('这段行程还没有带坐标的安排', PAD + 40, cardY + 52)
  }

  data.days.forEach((d, i) => {
    const ry = cardY + 26 + i * DAY_ROW
    // D 章号
    ctx.fillStyle = P.brand
    roundRect(ctx, PAD + 28, ry + 4, 44, 44, 12)
    ctx.fill()
    ctx.fillStyle = P.textInverse
    font(ctx, 600, 22)
    ctx.textAlign = 'center'
    ctx.fillText(`D${d.no + 1}`, PAD + 50, ry + 32)
    ctx.textAlign = 'left'

    // 首末点名
    const route = d.first
      ? d.last && d.last !== d.first
        ? `${d.first} → ${d.last}`
        : d.first
      : '暂无坐标点'
    ctx.fillStyle = P.textPrimary
    font(ctx, 500, 26)
    ctx.fillText(ellipsis(route, 14), PAD + 92, ry + 18)

    // 次行：日期 · 站数 · 里程
    const sub: string[] = []
    const sd = shortDate(d.date)
    if (sd) sub.push(sd)
    if (d.count > 0) sub.push(`${d.count} 站`)
    const km = kmLabel(d.km)
    if (km) sub.push(km)
    ctx.fillStyle = P.textSecondary
    font(ctx, 400, 22)
    ctx.fillText(sub.join(' · ') || '—', PAD + 92, ry + 52)

    // 右侧里程徽字
    if (km) {
      ctx.textAlign = 'right'
      ctx.fillStyle = P.brandDeep
      font(ctx, 600, 24)
      ctx.fillText(km, W - PAD - 28, ry + 20)
      ctx.textAlign = 'left'
    }
  })

  // 页脚
  const footY = cardY + 52 + dayCount * DAY_ROW + 34
  ctx.textAlign = 'center'
  ctx.fillStyle = P.textSecondary
  font(ctx, 400, 22)
  ctx.fillText('每一站都值得回味 · 同行 AA 记账', W / 2, footY + 24)
  ctx.fillStyle = P.brandDeep
  font(ctx, 600, 26)
  ctx.fillText('TONGXING · 同行', W / 2, footY + 62)
  ctx.textAlign = 'left'
}

function dayKmTotal(data: ReplayPosterData): string {
  const total = data.days.reduce((s, b) => s + b.km, 0)
  const label = kmLabel(total)
  return label || '0'
}
