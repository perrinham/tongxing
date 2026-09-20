/**
 * 行程天气服务：目的地 × 行程日期 的逐日预报（网络 + 本地缓存）。
 *
 * - 后端代理 Open-Meteo（客户端不直连境外源，理由见 server/routes/weather.mjs 头注释）
 * - 本地缓存（uni storage，key WEATHER_STORAGE_KEY）：TTL 内直接用 → **离线可显示**
 * - 拉取失败时回退 stale 缓存（标 stale 返回，页面可自行决定是否显示）
 * - 任何失败都**静默降级**（返回 null / 缺日期），天气只是行程页的锦上添花，
 *   绝不能让它变成一个用户要处理的报错。
 *
 * 页面用法（见 ItineraryPage）：
 *   const weather = await fetchTripWeather(place, start, end)
 *   → Map<date, WeatherDay>，缺哪天就不显示哪天（含服务端 16 天截断的情况）。
 */
import { BACKEND_ENABLED } from '@/config'
import { createBackend } from '@/services/backend'
import {
  loadWeatherCache,
  pickCachedWeather,
  pruneWeatherCache,
  weatherCacheKey,
  weatherDayMap,
  type WeatherCache,
  type WeatherDay
} from '@/utils/weather'

const WEATHER_STORAGE_KEY = 'tx_weather_v1'

/** 注入式存储后端（生产用 uni 同步存储；测试可换成内存实现） */
export interface WeatherStore {
  get(): string
  set(raw: string): void
}

const uniStore: WeatherStore = {
  get: () => {
    try {
      return uni.getStorageSync(WEATHER_STORAGE_KEY) as string
    } catch {
      return ''
    }
  },
  set: (raw) => {
    try {
      uni.setStorageSync(WEATHER_STORAGE_KEY, raw)
    } catch (e) {
      console.warn('[weather] 缓存写入失败', e)
    }
  }
}

export interface TripWeather {
  /** 日期 → 天气。行程超出预报上限（16 天）或部分日期缺数据时，对应日期不在 Map 里 */
  byDate: Map<string, WeatherDay>
  /** true = 来自过期缓存（网络拉取失败时的断网降级） */
  stale: boolean
}

/** 主入口。永远 resolve（失败降级为 null），页面不需要 try/catch */
export async function fetchTripWeather(
  place: string,
  start: string,
  end: string,
  opts: {
    backend?: ReturnType<typeof createBackend>
    store?: WeatherStore
  } = {}
): Promise<TripWeather | null> {
  const clean = String(place || '').trim()
  if (!clean || !start || !end) return null
  const store = opts.store || uniStore
  const key = weatherCacheKey(clean, start, end)

  const cache: WeatherCache = loadWeatherCache(store.get())
  const hit = pickCachedWeather(cache, key, Date.now())
  if (hit && !hit.stale) return { byDate: weatherDayMap(hit.days), stale: false }

  if (!BACKEND_ENABLED) {
    // 纯本地模式：有旧缓存就凑合显示（stale），没有就算了
    return hit ? { byDate: weatherDayMap(hit.days), stale: true } : null
  }

  try {
    const backend = opts.backend || createBackend()
    const reply = await backend.getWeather(clean, start, end)
    const next = pruneWeatherCache({ ...cache, [key]: { at: Date.now(), days: reply.days || [] } })
    store.set(JSON.stringify(next))
    return { byDate: weatherDayMap(reply.days), stale: false }
  } catch (e) {
    // 静默降级：网络失败时 stale 缓存也比空白强 —— 但要让调用方知道它不新鲜。
    // 只打 message 不打堆栈：降级是预期路径（断网/后端不可达），堆栈只会制造噪音
    console.warn('[weather] 拉取失败，回退缓存:', e instanceof Error ? e.message : e)
    return hit ? { byDate: weatherDayMap(hit.days), stale: true } : null
  }
}
