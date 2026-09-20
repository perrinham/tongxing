import { AMAP_WEB_KEY, AMAP_ENABLED } from '@/config'

/**
 * 高德开放平台「Web 服务」接口封装。
 * 小程序不能用网页版 JS API（依赖 DOM），只能用 REST 接口 + wx/uni.request。
 * 所有坐标均为高德 gcj-02，与微信 <map> 组件默认坐标系一致，可直接打点/画路线。
 */

export interface AmapPoi {
  id: string
  name: string
  address: string
  lng: number
  lat: number
  city?: string
  /** 高德评分（biz_ext.rating），无评分时不带 */
  rating?: number
}

export interface LatLng {
  latitude: number
  longitude: number
}

export interface RouteResult {
  /** 距离（米） */
  distance: number
  /** 预计耗时（秒） */
  duration: number
  /** 路线轨迹点（gcj-02） */
  points: LatLng[]
}

const BASE = 'https://restapi.amap.com'

function req<T>(path: string, params: Record<string, string>): Promise<T> {
  return new Promise((resolve, reject) => {
    uni.request({
      url: BASE + path,
      data: { key: AMAP_WEB_KEY, ...params },
      method: 'GET',
      success: (res) => {
        const data = res.data as { status?: string; info?: string } & Record<string, unknown>
        if (data && data.status === '1') resolve(data as unknown as T)
        else reject(new Error(data?.info || '高德接口返回异常'))
      },
      fail: (err: { errMsg?: string }) => reject(new Error(err?.errMsg || '网络请求失败'))
    })
  })
}

/**
 * 解析高德 "lng,lat"。缺失 / NaN / 0,0 占位一律返回 null ——
 * 没有这层守卫，无坐标 POI（公交线路等）会静默变成 0,0 或 NaN 打进地图。
 */
function parseLngLat(loc: string | undefined): { lng: number; lat: number } | null {
  if (!loc) return null
  const [lng, lat] = loc.split(',').map(Number)
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || (lng === 0 && lat === 0)) return null
  return { lng, lat }
}

/** POI 搜索（关键词 + 可选城市） */
export async function searchPoi(keyword: string, city?: string): Promise<AmapPoi[]> {
  return searchPoiWithTypes(keyword, city)
}

/**
 * POI 检索（可指定高德类型码，如 110200 风景名胜 / 050000 餐饮 / 060101 商场）。
 * keywords 与 types 至少一个非空；两者都为空直接返回空数组。
 * page 从 1 起，每页 25 条。
 */
export async function searchPoiWithTypes(
  keyword: string,
  city?: string,
  types?: string,
  page = 1
): Promise<AmapPoi[]> {
  if (!AMAP_ENABLED) return []
  if (!keyword.trim() && !types?.trim()) return []
  const params: Record<string, string> = { offset: '25', page: String(Math.max(1, page)), extensions: 'all' }
  if (keyword.trim()) params.keywords = keyword
  if (types?.trim()) params.types = types
  if (city) params.city = city
  try {
    const data = await req<{ pois: any[] }>('/v3/place/text', params)
    return (data.pois || [])
      .map((p) => {
        const pos = parseLngLat(p.location)
        if (!pos) return null
        const biz = p.biz_ext && typeof p.biz_ext === 'object' ? p.biz_ext : {}
        const rating = Number(biz.rating)
        return {
          id: p.id || p.name,
          name: p.name,
          address: p.address || [p.pname, p.cityname, p.adname].filter(Boolean).join(''),
          lng: pos.lng,
          lat: pos.lat,
          city: p.cityname,
          rating: Number.isFinite(rating) && rating > 0 ? rating : undefined
        } as AmapPoi
      })
      .filter(Boolean) as AmapPoi[]
  } catch {
    return []
  }
}

/** 输入提示（用于目的地搜索框的联想） */
export async function inputTips(keyword: string, city?: string): Promise<AmapPoi[]> {
  if (!AMAP_ENABLED) return []
  const params: Record<string, string> = { keywords: keyword }
  if (city) params.city = city
  try {
    const data = await req<{ tips: any[] }>('/v3/assistant/inputtips', params)
    return (data.tips || [])
      .filter((t) => t.location && t.location !== '[]')
      .map((t) => {
        const pos = parseLngLat(t.location)
        if (!pos) return null
        return { id: t.id || t.name, name: t.name, address: t.district || '', lng: pos.lng, lat: pos.lat, city: t.district }
      })
      .filter(Boolean) as AmapPoi[]
  } catch {
    return []
  }
}

/** 地理编码：城市名 / 详细地址 -> 坐标 */
export async function geocode(address: string, city?: string): Promise<LatLng | null> {
  if (!AMAP_ENABLED) return null
  const params: Record<string, string> = { address }
  if (city) params.city = city
  try {
    const data = await req<{ geocodes: any[] }>('/v3/geocode/geo', params)
    if (!data.geocodes || !data.geocodes.length) return null
    const pos = parseLngLat(data.geocodes[0].location)
    return pos ? { latitude: pos.lat, longitude: pos.lng } : null
  } catch {
    return null
  }
}

function parsePolyline(steps: any[]): LatLng[] {
  const pts: LatLng[] = []
  ;(steps || []).forEach((s) => {
    ;(s.polyline || '')
      .split(';')
      .forEach((seg: string) => {
        const [lng, lat] = seg.split(',').map(Number)
        if (!Number.isNaN(lng) && !Number.isNaN(lat)) pts.push({ latitude: lat, longitude: lng })
      })
  })
  return pts
}

/** 步行路线规划 */
export async function walkingRoute(origin: LatLng, destination: LatLng): Promise<RouteResult | null> {
  if (!AMAP_ENABLED) return null
  try {
    const data = await req<{ route: any }>('/v3/direction/walking', {
      origin: `${origin.longitude},${origin.latitude}`,
      destination: `${destination.longitude},${destination.latitude}`
    })
    const path = data.route?.paths?.[0]
    if (!path) return null
    return {
      distance: Number(path.distance) || 0,
      duration: Number(path.duration) || 0,
      points: parsePolyline(path.steps)
    }
  } catch {
    return null
  }
}

/** 驾车路线规划 */
export async function drivingRoute(origin: LatLng, destination: LatLng): Promise<RouteResult | null> {
  if (!AMAP_ENABLED) return null
  try {
    const data = await req<{ route: any }>('/v3/direction/driving', {
      origin: `${origin.longitude},${origin.latitude}`,
      destination: `${destination.longitude},${destination.latitude}`,
      strategy: '2'
    })
    const path = data.route?.paths?.[0]
    if (!path) return null
    return {
      distance: Number(path.distance) || 0,
      duration: Number(path.duration) || 0,
      points: parsePolyline(path.steps)
    }
  } catch {
    return null
  }
}
