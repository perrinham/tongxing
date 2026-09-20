/**
 * 行程天气（纯函数层，无 IO —— smoke 可直接测）。
 *
 * 数据链路：ItineraryPage → services/weather.ts（网络 + 本地缓存）
 *   → 后端 /api/weather（代理 Open-Meteo，见 server/routes/weather.mjs）
 *
 * ⚠️ WMO 天气码 → 文案 / emoji / 带伞提示的映射**只在这里存一份**：
 * server 只透传原始 code（双端各存一份文案迟早口径漂移）。
 */

import type { WeatherDay, WeatherCacheEntry, WeatherCache } from '@/types'

export type { WeatherDay, WeatherCacheEntry, WeatherCache }

/** 缓存新鲜窗口。逐日预报一天更新几次，6 小时足够 */
export const WEATHER_TTL_MS = 6 * 3600 * 1000
/** 本地缓存条目上限；超出驱逐最旧（容量淘汰，不做 TTL 清理 —— stale 值要留着兜底断网） */
export const WEATHER_CACHE_MAX = 50

// ───────────────────────── WMO 码映射 ─────────────────────────

/** WMO weather code → 中文短语。未知码回「—」 */
export function weatherText(code: number): string {
  if (code === 0) return '晴'
  if (code === 1) return '晴间多云'
  if (code === 2) return '多云'
  if (code === 3) return '阴'
  if (code === 45 || code === 48) return '雾'
  if (code === 51) return '小毛毛雨'
  if (code === 53) return '毛毛雨'
  if (code === 55) return '密毛毛雨'
  if (code === 56 || code === 57) return '冻毛毛雨'
  if (code === 61) return '小雨'
  if (code === 63) return '中雨'
  if (code === 65) return '大雨'
  if (code === 66 || code === 67) return '冻雨'
  if (code === 71) return '小雪'
  if (code === 73) return '中雪'
  if (code === 75) return '大雪'
  if (code === 77) return '雪粒'
  if (code === 80) return '小阵雨'
  if (code === 81) return '阵雨'
  if (code === 82) return '强阵雨'
  if (code === 85 || code === 86) return '阵雪'
  if (code === 95) return '雷阵雨'
  if (code === 96 || code === 99) return '雷雨伴冰雹'
  return '—'
}

/** WMO weather code → emoji（小程序 text / H5 均原生渲染，不走 AppIcon） */
export function weatherEmoji(code: number): string {
  if (code === 0) return '☀️'
  if (code === 1) return '🌤'
  if (code === 2) return '⛅'
  if (code === 3) return '☁️'
  if (code === 45 || code === 48) return '🌫'
  if (code >= 51 && code <= 57) return '🌦'
  if (code >= 61 && code <= 67) return '🌧'
  if (code >= 71 && code <= 77) return '❄️'
  if (code >= 80 && code <= 82) return '🌦'
  if (code >= 85 && code <= 86) return '🌨'
  if (code >= 95 && code <= 99) return '⛈'
  return '🌤'
}

/** 是否降雨（毛毛雨/雨/冻雨/阵雨/雷雨都算 —— 「带伞」以它为准；雪不算） */
export function isRainy(code: number): boolean {
  return (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || (code >= 95 && code <= 99)
}

// ───────────────────────── 本地缓存（离线可用） ─────────────────────────

/** 缓存键。place 归一小写去空格，避免「成都 」和「成都」各存一份 */
export function weatherCacheKey(place: string, start: string, end: string): string {
  return `${place.trim().toLowerCase()}|${start}|${end}`
}

/** 解析本地缓存字符串；任何形状损坏都整体回 {}（宁可重新拉，不用脏数据） */
export function loadWeatherCache(raw: string | undefined | null): WeatherCache {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: WeatherCache = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const e = v as Partial<WeatherCacheEntry>
      if (typeof e.at !== 'number' || !Number.isFinite(e.at)) continue
      if (!Array.isArray(e.days)) continue
      const days: WeatherDay[] = []
      for (const d of e.days) {
        if (!d || typeof d !== 'object') continue
        const w = d as Partial<WeatherDay>
        if (typeof w.date !== 'string' || !w.date) continue
        days.push({
          date: w.date,
          code: typeof w.code === 'number' ? w.code : -1,
          tmax: typeof w.tmax === 'number' ? w.tmax : null,
          tmin: typeof w.tmin === 'number' ? w.tmin : null
        })
      }
      out[k] = { at: e.at, days }
    }
    return out
  } catch {
    return {}
  }
}

export interface PickedCache {
  days: WeatherDay[]
  /** true = 数据过期（TTL 外），仅作断网降级用 */
  stale: boolean
}

/** 取缓存。TTL 内返回新鲜值；过期返回 stale 值；没有该 key 返回 null */
export function pickCachedWeather(
  cache: WeatherCache,
  key: string,
  now: number
): PickedCache | null {
  const hit = cache[key]
  if (!hit || !Array.isArray(hit.days)) return null
  return { days: hit.days, stale: now - hit.at > WEATHER_TTL_MS }
}

/**
 * 容量裁剪：条目超过 max 时按抓取时间驱逐最旧。
 * 刻意**不按 TTL 清理** —— 过期值要留着做断网降级，只有容量压力才驱逐。
 */
export function pruneWeatherCache(cache: WeatherCache, max = WEATHER_CACHE_MAX): WeatherCache {
  const keys = Object.keys(cache)
  if (keys.length <= max) return cache
  const sorted = keys.sort((a, b) => (cache[a]?.at ?? 0) - (cache[b]?.at ?? 0))
  const out: WeatherCache = {}
  for (const k of sorted.slice(keys.length - max)) out[k] = cache[k]
  return out
}

/** WeatherDay[] → 日期索引 Map（页面按天 O(1) 查） */
export function weatherDayMap(days: WeatherDay[] | undefined | null): Map<string, WeatherDay> {
  const m = new Map<string, WeatherDay>()
  if (Array.isArray(days)) for (const d of days) if (d && d.date) m.set(d.date, d)
  return m
}

/** 单日展示短语：「🌧 中雨 18-24°」；无温度时退「🌧 中雨」 */
export function weatherBrief(d: WeatherDay): string {
  const t =
    typeof d.tmin === 'number' && typeof d.tmax === 'number'
      ? ` ${Math.round(d.tmin)}-${Math.round(d.tmax)}°`
      : ''
  const rain = isRainy(d.code) ? ' · 记得带伞' : ''
  return `${weatherEmoji(d.code)} ${weatherText(d.code)}${t}${rain}`
}
