/**
 * 天气代理路由（行程日期 × 目的地天气）。
 *
 * 为什么走服务端代理、而不是小程序直连天气源：
 *  - 微信小程序 request 合法域名要求 ICP 备案，Open-Meteo 这类境外源配不进后台；
 *    走自家后端转发，客户端只依赖一个已配置的后端域名。
 *  - 服务端内存缓存一层：同一目的地 × 日期范围的重复请求不对外打（省额度 + 防刷）。
 *
 * 数据源：Open-Meteo（免 key，免费档逐日预报上限 16 天）。
 *   geocoding: GET geocoding-api.open-meteo.com/v1/search?name=..&count=1&language=zh
 *   forecast : GET api.open-meteo.com/v1/forecast?daily=weather_code,temperature_2m_max,
 *              temperature_2m_min&timezone=auto&start_date=..&end_date=..
 *
 *   GET /api/weather?place=成都&start=2026-09-20&end=2026-09-22
 *     -> 200 { place, resolved:{name,lat,lng}, days:[{date,code,tmax,tmin}], truncated?, source }
 *     - 400：place 为空 / 日期不合法 / start 晚于 end
 *     - 404：目的地解析不到坐标
 *     - 502：上游不可达（客户端静默降级，不显示天气即可）
 *
 * 天气码（WMO）→ 文案 / 图标 / 带伞提示的映射**只在客户端做**（src/utils/weather.ts），
 * server 只透传原始 code —— 避免双端各存一份文案造成口径漂移。
 *
 * 天气数据无用户隐私，匿名可用；仍受全局限流保护（index.mjs 统一 check）。
 * 测试：TX_WEATHER_MOCK=1 时返回固定样例，server smoke 全程不依赖外网。
 */

import { isoDate } from '../lib/util.mjs'

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
/** Open-Meteo 免费档逐日预报上限；行程超过这段只覆盖前 16 天 */
const MAX_RANGE_DAYS = 16
const PLACE_MAX = 40
const FETCH_TIMEOUT_MS = 8000
/** 内存缓存 TTL：逐日预报一天更新几次，6 小时足够新鲜 */
const CACHE_TTL_MS = 6 * 3600 * 1000
/** 缓存条目上限；超出驱逐最旧（不 clear —— clear 会造成瞬时缓存击穿） */
const CACHE_MAX = 200

export function createWeatherRouter({ http, log, env = process.env }) {
  // key: `${place}|${start}|${end}` -> { at, payload }
  const cache = new Map()

  function cacheKey(place, start, end) {
    return `${place}|${start}|${end}`
  }

  function cacheGet(key) {
    const hit = cache.get(key)
    if (!hit) return null
    if (Date.now() - hit.at > CACHE_TTL_MS) return null
    // 触碰式 LRU：命中即重插到 Map 尾部（Map 迭代按插入序，最旧在头）
    cache.delete(key)
    cache.set(key, hit)
    return hit.payload
  }

  function cachePut(key, payload) {
    cache.delete(key)
    cache.set(key, { at: Date.now(), payload })
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value
      cache.delete(oldest)
    }
  }

  /** 带超时的 JSON GET；非 2xx / 超时 / 非法 JSON 一律抛错（由调用方归一成 502） */
  async function getJson(url) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, { signal: ctrl.signal })
      if (!res.ok) throw new Error(`upstream ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  async function geocode(place) {
    const url =
      `${GEO_URL}?name=${encodeURIComponent(place)}&count=1&language=zh&format=json`
    const data = await getJson(url)
    const hit = data?.results?.[0]
    if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') return null
    return { name: String(hit.name || place), lat: hit.latitude, lng: hit.longitude }
  }

  async function forecast(lat, lng, start, end) {
    const url =
      `${FORECAST_URL}?latitude=${lat}&longitude=${lng}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto` +
      `&start_date=${start}&end_date=${end}`
    const data = await getJson(url)
    const d = data?.daily
    if (!Array.isArray(d?.time)) return []
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    return d.time.map((date, i) => ({
      date: String(date),
      code: num(d.weather_code?.[i]) ?? -1,
      tmax: num(d.temperature_2m_max?.[i]),
      tmin: num(d.temperature_2m_min?.[i])
    }))
  }

  /** mock 样例：序列里必现雨天（63 大雨），让「带伞」链路可断言 */
  function mockDays(start, n) {
    const codes = [1, 63, 2, 61, 3, 95, 0]
    const out = []
    const base = new Date(`${start}T00:00:00Z`)
    for (let i = 0; i < n; i += 1) {
      const date = new Date(base.getTime() + i * 86400_000).toISOString().slice(0, 10)
      out.push({ date, code: codes[i % codes.length], tmax: 26 + (i % 3), tmin: 17 + (i % 2) })
    }
    return out
  }

  async function handle(req, res, url) {
    if (url.pathname !== '/api/weather') return false
    if (req.method !== 'GET') {
      http.methodNotAllowed(req, res, ['GET', 'OPTIONS'])
      return true
    }

    const place = String(url.searchParams.get('place') ?? '').trim().slice(0, PLACE_MAX)
    const start = isoDate(url.searchParams.get('start') ?? '', '')
    const end = isoDate(url.searchParams.get('end') ?? '', '')
    if (!place) {
      http.fail(req, res, 400, 'place is required')
      return true
    }
    if (!start || !end) {
      http.fail(req, res, 400, 'start/end must be YYYY-MM-DD')
      return true
    }
    if (start > end) {
      http.fail(req, res, 400, 'start must not be after end')
      return true
    }

    // 范围截断：超出预报上限的部分直接不返回（客户端缺哪天就不显示哪天）
    const spanDays =
      Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400_000) + 1
    const clampedEnd =
      spanDays > MAX_RANGE_DAYS
        ? new Date(Date.parse(`${start}T00:00:00Z`) + (MAX_RANGE_DAYS - 1) * 86400_000)
            .toISOString()
            .slice(0, 10)
        : end
    const truncated = clampedEnd !== end

    const key = cacheKey(place, start, end)
    const cached = cacheGet(key)
    if (cached) {
      http.send(req, res, 200, cached)
      return true
    }

    const mock = env.TX_WEATHER_MOCK === '1'
    try {
      let payload
      if (mock) {
        payload = {
          place,
          resolved: { name: place, lat: 30.65, lng: 104.06 },
          days: mockDays(start, Math.min(spanDays, MAX_RANGE_DAYS)),
          ...(truncated ? { truncated: true } : {}),
          source: 'mock'
        }
      } else {
        const resolved = await geocode(place)
        if (!resolved) {
          http.fail(req, res, 404, 'place not found')
          return true
        }
        const days = await forecast(resolved.lat, resolved.lng, start, clampedEnd)
        payload = {
          place,
          resolved,
          days,
          ...(truncated ? { truncated: true } : {}),
          source: 'open-meteo'
        }
      }
      cachePut(key, payload)
      log.info('天气返回', { place, start, end: clampedEnd, days: payload.days.length, mock })
      http.send(req, res, 200, payload)
    } catch (e) {
      log.warn('天气上游失败', { place, start, end, err: String(e?.message || e) })
      http.fail(req, res, 502, 'weather upstream unavailable')
    }
    return true
  }

  return { handle }
}
