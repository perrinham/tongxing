/**
 * 天气代理云函数 —— server/routes/weather.mjs 的云端移植。
 *
 * 为什么云函数里还要代理一层：小程序 request 合法域名要求 ICP 备案，Open-Meteo
 * 这类境外源配不进后台；云函数出网不受该限制，客户端只依赖云调用即可。
 *
 * 数据源：Open-Meteo（免 key，免费档逐日预报上限 16 天）。
 *   geocoding: geocoding-api.open-meteo.com/v1/search?name=..&count=1&language=zh
 *   forecast : api.open-meteo.com/v1/forecast?daily=weather_code,temperature_2m_max,
 *              temperature_2m_min&timezone=auto&start_date=..&end_date=..
 *
 * event：{ action:'weather', place, start, end }
 *   -> { place, resolved:{name,lat,lng}, days:[{date,code,tmax,tmin}], truncated?, source }
 *   - 400：place 为空 / 日期不合法 / start 晚于 end
 *   - 404：目的地解析不到坐标
 *   - 502：上游不可达（客户端静默降级，不显示天气即可）
 *
 * 天气码（WMO）→ 文案 / 图标 / 带伞提示的映射**只在客户端做**（src/utils/weather.ts），
 * 这里只透传原始 code —— 避免双端各存一份文案造成口径漂移。
 *
 * 缓存：模块级 Map（同一热实例内生效，冷启动即失效）。云函数无跨实例共享内存，
 * 所以这只是「尽力而为」的一层，与自托管的常驻内存缓存不同，但语义上只影响上游调用量。
 */

const { isoDate } = require('./_lib/util')

const GEO_URL = 'geocoding-api.open-meteo.com'
const FORECAST_URL = 'api.open-meteo.com'
/** Open-Meteo 免费档逐日预报上限；行程超过这段只覆盖前 16 天 */
const MAX_RANGE_DAYS = 16
const PLACE_MAX = 40
const FETCH_TIMEOUT_MS = 8000
/** 内存缓存 TTL：逐日预报一天更新几次，6 小时足够新鲜 */
const CACHE_TTL_MS = 6 * 3600 * 1000
/** 缓存条目上限；超出驱逐最旧（不 clear —— clear 会造成瞬时缓存击穿） */
const CACHE_MAX = 200

// key: `${place}|${start}|${end}` -> { at, payload }
const cache = new Map()

function cacheKey(place, start, end) {
  return `${place}|${start}|${end}`
}

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) return null
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

function fail(status, message) {
  return { e: { status, message } }
}

/**
 * 带超时的 JSON GET（用 node:https，兼容云函数 Node 16 运行时；不用全局 fetch）。
 * 非 2xx / 超时 / 非法 JSON 一律 reject（由调用方归一成 502）。
 */
function getJson(host, path) {
  const https = require('https')
  return new Promise((resolve, reject) => {
    const req = https.get({ host, path, timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        reject(new Error(`upstream ${res.statusCode}`))
        return
      }
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        raw += c
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw))
        } catch {
          reject(new Error('invalid json'))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

async function geocode(place) {
  const path = `/v1/search?name=${encodeURIComponent(place)}&count=1&language=zh&format=json`
  const data = await getJson(GEO_URL, path)
  const hit = data && data.results && data.results[0]
  if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') return null
  return { name: String(hit.name || place), lat: hit.latitude, lng: hit.longitude }
}

async function forecast(lat, lng, start, end) {
  const path =
    `/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto` +
    `&start_date=${start}&end_date=${end}`
  const data = await getJson(FORECAST_URL, path)
  const d = data && data.daily
  if (!d || !Array.isArray(d.time)) return []
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return d.time.map((date, i) => ({
    date: String(date),
    code: num(d.weather_code && d.weather_code[i]) ?? -1,
    tmax: num(d.temperature_2m_max && d.temperature_2m_max[i]),
    tmin: num(d.temperature_2m_min && d.temperature_2m_min[i])
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

exports.main = async (event) => {
  try {
    const place = String(event.place ?? '').trim().slice(0, PLACE_MAX)
    const start = isoDate(event.start ?? '', '')
    const end = isoDate(event.end ?? '', '')
    if (!place) return fail(400, 'place is required')
    if (!start || !end) return fail(400, 'start/end must be YYYY-MM-DD')
    if (start > end) return fail(400, 'start must not be after end')

    // 范围双重夹紧（客户端缺哪天就不显示哪天）：
    //   a) 行程长度 ≤ MAX_RANGE_DAYS（免费档单次范围上限）
    //   b) 结尾不得超出「今天 + MAX_RANGE_DAYS-1」的预报窗口 —— 否则 Open-Meteo 直接 400
    const mock = process.env.TX_WEATHER_MOCK === '1'
    const todayUTC = new Date().toISOString().slice(0, 10)
    const hardEnd = new Date(Date.parse(`${todayUTC}T00:00:00Z`) + (MAX_RANGE_DAYS - 1) * 86400_000)
      .toISOString()
      .slice(0, 10)
    const lenEnd = new Date(Date.parse(`${start}T00:00:00Z`) + (MAX_RANGE_DAYS - 1) * 86400_000)
      .toISOString()
      .slice(0, 10)
    const clampedEnd = [end, lenEnd, hardEnd].sort()[0]
    const truncated = clampedEnd !== end

    const key = cacheKey(place, start, end)
    const cached = cacheGet(key)
    if (cached) return cached

    // 行程完全在预报窗口之外（出发日比 hardEnd 还晚）：没有可预报的日子，直接回空 days
    if (clampedEnd < start) {
      const empty = {
        place,
        resolved: { name: place, lat: 0, lng: 0 },
        days: [],
        truncated: true,
        source: mock ? 'mock' : 'none'
      }
      cachePut(key, empty)
      return empty
    }

    let payload
    if (mock) {
      const n =
        Math.round(
          (Date.parse(`${clampedEnd}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400_000
        ) + 1
      payload = {
        place,
        resolved: { name: place, lat: 30.65, lng: 104.06 },
        days: mockDays(start, Math.max(n, 0)),
        ...(truncated ? { truncated: true } : {}),
        source: 'mock'
      }
    } else {
      const resolved = await geocode(place)
      if (!resolved) return fail(404, 'place not found')
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
    return payload
  } catch (e) {
    console.error('[weather:error]', String((e && e.message) || e))
    return fail(502, 'weather upstream unavailable')
  }
}