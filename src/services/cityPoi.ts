import { searchPoi, searchPoiWithTypes, geocode } from './amap'
import type { CitySeed, PoiSeed } from '@/data/poi'
import { AMAP_ENABLED } from '@/config'

/**
 * 高德在线城市库：把任意城市现场抓成一份候选池。
 *
 * 本地 6 城（data/poi.ts）有精修的 POI 与经典路线；其他城市走高德
 * 「风景名胜 + 餐饮 + 商圈」检索，按评分取头部，组装成 CitySeed 喂给
 * 行程生成规则引擎 —— 地理聚类分天、远郊拆分、补餐饮全部复用。
 *
 * 高德没有「建议停留时长」字段，duration / cost 按 POI 类型给缺省值；
 * 评分 biz_ext.rating 折进 PoiSeed.rating，由打分函数加权。
 */

/**
 * ⚠️ 高德 /v3/place/text 的 types 检索**排序与质量无关**（近似按内部 id），
 * 实测橘子洲（4.9 分）落在长沙 600 条结果的第 6 页 —— 抓前 3 页必漏地标。
 * 有效抓法是「细分类型 + 关键词」多路组合，各自第 1 页：
 *   - 110203 国家级景点：数量少（几十条）但全是硬核地标，1 页抓完
 *   - 关键词「风景名胜」/「景区」：按名称匹配，命中率远高于纯类型翻页
 * 实测长沙用 3 路组合，头部即为 橘子洲 4.9 / 岳麓山 4.8 / 太平老街 4.8 / 岳麓书院 4.8。
 */

/** 国家级景点（硬核地标，1 页抓完） */
const NATURAL_LANDMARK_TYPES = '110203'
/** 风景名胜大类：风景名胜/寺庙道观/纪念馆/公园/教堂（关键词路） */
const SPOT_KEYWORD = '风景名胜'
/** 备用关键词：景区 */
const SCENIC_KEYWORD = '景区'
/** 商场购物中心 */
const SHOP_TYPES = '060101'
/** 餐饮大类 */
const FOOD_TYPES = '050000'

/** 每类抓取量（头部按评分截断后的目标值） */
const SPOT_LIMIT = 18
const FOOD_LIMIT = 12
const SHOP_LIMIT = 6

/** 距市中心超过该距离按「远郊一日」处理（与本地库 dayTrip 同语义） */
const DAY_TRIP_KM = 30
/** 远郊最多标记几个，防止把一半日子拉去郊区 */
const DAY_TRIP_MAX = 3

/** 名称里带这些词的多为设施/子点位/机构，不是可游玩目的地 */
const NAME_BLOCKLIST = [
  '停车场', '售票处', '售票', '游客中心', '游客服务', '咨询中心', '公厕',
  '办事处', '营业部', '分公司', '有限公司', '管理处', '派出所', '居委会',
  '检票口', '索道站', '充电站', '幼儿园', '小学', '中学'
]

interface SeedOpts {
  duration: number
  cost: number
  rating: number
}

/** 高德 POI -> 本地 PoiSeed；不合法（无坐标/黑名单/分店名）返回 null */
function toSeed(p: AmapPoiLike, type: PoiSeed['type'], opts: SeedOpts): PoiSeed | null {
  const name = (p.name || '').trim()
  if (!name || !p.lng || !p.lat) return null
  if (NAME_BLOCKLIST.some((w) => name.includes(w))) return null
  // 景点/商圈的分店名（「xxx(xx店)」）在陌生城市没有辨识度；餐饮保留（连锁小吃也有参考价值）
  if (type !== 'food' && /[（(].*[)）]$/.test(name)) return null
  const n = name
  let best: PoiSeed['best'] = 'any'
  if (/夜景|夜市|酒吧|宵夜|夜宵|不夜城|音乐喷泉|灯光秀|两江|日落/.test(n)) best = 'night'
  else if (/日出|观景台|观景|晨钟|早市|早茶/.test(n)) best = 'morning'
  if (type === 'food' && /烧烤|夜市|宵夜|火锅|小龙虾|江湖菜|大排档/.test(n)) best = 'night'
  if (type === 'food' && /早餐|粉|包子|豆浆|粥|面/.test(n) && best === 'any') best = 'morning'
  return {
    name,
    type,
    lng: p.lng,
    lat: p.lat,
    duration: opts.duration,
    cost: opts.cost,
    best,
    area: p.address || '',
    address: p.address || '',
    rating: opts.rating || undefined
  }
}

interface AmapPoiLike {
  name: string
  address?: string
  lng: number
  lat: number
  rating?: number
}

/** 名称主段去重（「岳麓书院」与「岳麓书院(东门)」算同一个），再按评分排序取头部 */
function pickTop(list: AmapPoiLike[], limit: number): AmapPoiLike[] {
  const seen = new Set<string>()
  const out: AmapPoiLike[] = []
  for (const p of list) {
    const key = p.name.replace(/[（(].*$/, '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(p)
    if (out.length >= limit) break
  }
  return out
}

function distanceKm(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const la1 = (a.lat * Math.PI) / 180
  const la2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * 拉取一个城市的高德候选池。
 * 返回 null = 高德不可用 / 该地名检索质量差 —— 调用方回退本地模板。
 */
export async function buildCityFromAmap(cityName: string): Promise<CitySeed | null> {
  if (!AMAP_ENABLED || !cityName.trim()) return null
  const city = cityName.trim()

  try {
    // 五路并发检索 + 市中心定位（geocode 失败不影响主体，只影响远郊标记）
    // 景点三路：国家级景点（硬核地标）+「风景名胜」「景区」关键词 ——
    // 纯类型翻页排序与质量无关，会漏掉橘子洲这类不带「寺庙」尾缀的大地标
    const [landmarkRaw, kwScenicRaw, kwSpotRaw, foodRaw, shopRaw, center] = await Promise.all([
      searchPoiWithTypes('', city, NATURAL_LANDMARK_TYPES),
      searchPoiWithTypes(SPOT_KEYWORD, city),
      searchPoiWithTypes(SCENIC_KEYWORD, city),
      searchPoiWithTypes('', city, FOOD_TYPES),
      searchPoiWithTypes('', city, SHOP_TYPES),
      geocode(city).catch(() => null)
    ])
    const spotRaw = [...landmarkRaw, ...kwScenicRaw, ...kwSpotRaw]

    const byRating = (l: AmapPoiLike[]) =>
      [...l].sort((a, b) => (b.rating || 0) - (a.rating || 0))

    // 三路并池后按「名称主段」去重（橘子洲风景名胜区 / 橘子洲头 → 各自保留，
    // 但「xxx(东门)」这类分店折叠进主名），再按评分取头部
    const spotSeeds = pickTop(byRating(spotRaw), SPOT_LIMIT)
      .map((p) =>
        toSeed(p, 'spot', { duration: (p.rating || 0) >= 4.5 ? 150 : 120, cost: 0, rating: p.rating || 0 })
      )
      .filter((s): s is PoiSeed => !!s)

    const foodSeeds = pickTop(byRating(foodRaw), FOOD_LIMIT)
      .map((p) => toSeed(p, 'food', { duration: 75, cost: 60, rating: p.rating || 0 }))
      .filter((s): s is PoiSeed => !!s)

    const shopSeeds = pickTop(byRating(shopRaw), SHOP_LIMIT)
      .map((p) => toSeed(p, 'spot', { duration: 90, cost: 0, rating: p.rating || 0 }))
      .filter((s): s is PoiSeed => !!s)

    // 景点少于 4 个：检索质量差（可能是县级地名/错别字），按失败处理走回退
    if (spotSeeds.length < 4) return null

    // 远郊标记：距市中心 > 30km 视为「一日游」，最多 3 个，其余降权（时间短、不再当远郊）
    if (center) {
      const c = { lng: center.longitude, lat: center.latitude }
      let dayTrips = 0
      for (const s of spotSeeds) {
        if (distanceKm(c, s) > DAY_TRIP_KM) {
          if (dayTrips < DAY_TRIP_MAX) {
            s.dayTrip = true
            s.duration = 300
            dayTrips += 1
          } else {
            s.duration = 60
          }
        }
      }
    }

    return {
      name: city,
      alias: [],
      intro: `高德在线点位库（景点 ${spotSeeds.length} · 商圈 ${shopSeeds.length} · 餐饮 ${foodSeeds.length}）`,
      pois: [...spotSeeds, ...shopSeeds, ...foodSeeds]
    }
  } catch {
    return null
  }
}
