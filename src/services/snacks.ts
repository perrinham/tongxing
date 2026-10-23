/**
 * 行程项「附近的吃」推荐服务。
 *
 * 交互模型（用户定的口径）：餐饮**不进行程时间轴** —— 行程项只放正事
 * （景点/场馆/交通），吃的东西按「这个点的位置 + 当前时间段」现查现推：
 *   · 9 点的静安寺 → 附近的早餐/咖啡店
 *   · 12 点的 XX → 附近的午餐
 * 放在 ItemEditPage 里展示（services/amap.searchAround 现拉，30min 缓存）。
 *
 * 任何失败都静默（返回空数组、隐藏区块）——推荐是锦上添花，绝不能变成报错。
 */
import { searchAround, type NearbyPoi } from './amap'

export type SnackSlot = 'breakfast' | 'coffee' | 'lunch' | 'tea' | 'dinner' | 'supper'

export const SNACK_SLOT_LABELS: Record<SnackSlot, string> = {
  breakfast: '早餐',
  coffee: '咖啡 · 茶歇',
  lunch: '午餐',
  tea: '下午茶',
  dinner: '晚餐',
  supper: '宵夜'
}

/** 每时段的检索词。午餐/晚餐不挑品类（word 检索会把「面馆」之外的全漏），用餐饮服务大类 050000 */
const SLOT_QUERY: Record<SnackSlot, { keywords?: string; types?: string; radius: number }> = {
  breakfast: { keywords: '早餐|包子|粥|豆浆|面馆|肠粉', radius: 1200 },
  coffee: { keywords: '咖啡|咖啡厅', radius: 1200 },
  lunch: { types: '050000', radius: 1500 },
  tea: { keywords: '咖啡|甜品|茶', radius: 1500 },
  dinner: { types: '050000', radius: 2000 },
  supper: { keywords: '夜宵|烧烤|小龙虾|大排档', radius: 3000 }
}

/**
 * HH:mm → 推荐时段。
 * 口径：06:00 起早餐；临近午市（10:30+）先咖啡；11:30-14:00 午餐；
 * 下午茶到 17 点；晚餐到 22 点；之后算宵夜（含凌晨）。
 */
export function snackSlotFor(time: string): SnackSlot {
  const [h, m = 0] = time.split(':').map(Number)
  const t = (h || 0) * 60 + (m || 0)
  if ((h || 0) < 6) return 'supper'
  if (t < 10 * 60 + 30) return 'breakfast'
  if (t < 11 * 60 + 30) return 'coffee'
  if (t < 14 * 60) return 'lunch'
  if (t < 17 * 60) return 'tea'
  if (t < 22 * 60) return 'dinner'
  return 'supper'
}

/** 简单内存缓存：瞬时点开多个行程项不重复打高德（30 分钟过期，上限 200 条防泄漏） */
const cache = new Map<string, { at: number; list: NearbyPoi[] }>()
const TTL = 30 * 60 * 1000

export async function nearbySnacks(
  lng: number,
  lat: number,
  slot: SnackSlot
): Promise<NearbyPoi[]> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)},${slot}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.list
  if (cache.size > 200) {
    // 最老的先清（近似 LRU；推荐缓存不值得真 LRU 结构）
    const first = cache.keys().next().value
    if (first) cache.delete(first)
  }
  const q = SLOT_QUERY[slot]
  const raw = await searchAround(lng, lat, { ...q, limit: 14 })
  // 直线距离 < 100m 的多半是「行程项自己」（景点带餐厅资质的 POI 名），剔除；
  // 有评分的排前（同都无评分保留距离序），再截 head
  const list = raw
    .filter((p) => p.distKm > 0.1)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 6)
    .sort((a, b) => a.distKm - b.distKm)
  cache.set(key, { at: Date.now(), list })
  return list
}
