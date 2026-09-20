/**
 * 同行 · 共享后端
 *
 * 零依赖：仅用 Node 内置模块（http / fs / crypto / sqlite），规避当前环境 `npm install`
 * 被 broker 拦截无法装包的问题。数据落盘到 $DATA_DIR 下的 SQLite 库（默认 ./data/travel.sqlite3）。
 *
 * 提供两块能力：
 *   1. 城市攻略 / 评价共享 —— 按城市聚合，想去的人读去过的人写的内容。
 *   2. 行程空间同步 —— 一次旅行的 行程 + 成员 + 行程项 + 账单 在多人多端之间合并。
 *
 * ── 环境变量 ──
 *   PORT             监听端口，默认 8787
 *   DATA_DIR         数据目录，默认 ./data
 *   AUTH_TOKEN       共享密钥；配置后所有写/读接口需带 Authorization: Bearer / X-Api-Key
 *   ALLOW_ANONYMOUS  设为 1 时，即使配了 AUTH_TOKEN 也放行不带密钥的请求（仅内网探活用）
 *   ALLOWED_ORIGINS  CORS 白名单，逗号分隔；'*' 表示放开（仅开发用）
 *   MAX_BODY_BYTES   请求体大小上限，默认 2097152（2MB）
 *   RATE_LIMIT       每窗口每 IP 请求数上限，默认 300
 *   RATE_WINDOW_MS   限流窗口，默认 60000
 *   LOG_LEVEL        error | warn | info | debug，默认 info
 *   MAX_CLOCK_SKEW_MS 允许客户端时间戳超前服务端的上限，默认 60000；设 0 表示不夹紧
 *   NODE_ID          本实例的时钟节点标识，多实例部署时应各不相同
 *
 *   ── 账号体系（微信 openid，见 lib/identity.mjs）──
 *   WX_APPID         小程序 AppID；与 WX_SECRET 同时配置才启用真实 code2session
 *   WX_SECRET        小程序 AppSecret，**只放服务端**
 *   SESSION_SECRET   会话令牌签名密钥；不配则回落到 AUTH_TOKEN，再没有就随机生成
 *                    （随机 = 进程重启后所有已签发令牌失效，仅适合本地开发）
 *   SESSION_TTL_MS   会话有效期，默认 30 天
 *   WX_DEV_LOGIN     设为 1 时在未配置 AppID/Secret 的情况下用 code 推导假 openid，
 *                    **仅供本地与测试，生产绝不要开**
 *
 *   ── 实时同步（WebSocket，见 lib/ws.mjs / lib/hub.mjs / lib/realtime.mjs）──
 *   WS_ENABLED       设为 0 关闭实时通道（客户端会退回定时同步）
 *   WS_PATH          实时端点路径，默认 /api/ws
 *   WS_PING_MS       应用层心跳间隔，默认 25000；连续两个周期无消息即断开
 *   WS_AUTH_GRACE_MS 建连后多久内必须发 hello，默认 5000；超时关连接
 *   WS_COALESCE_MS   同一空间的变更通知合并窗口，默认 80
 *   WS_MAX_CONNS     实时连接数上限，默认 500
 *   WS_MAX_SUBS      单连接可订阅的空间数上限，默认 200
 *   WS_MAX_PAYLOAD   单条消息字节上限，默认 65536
 *
 * ⚠️ 两套凭据是正交的，别混：
 *   Authorization / X-Api-Key   = 共享密钥，回答「这个客户端被允许访问后端吗」
 *   X-Session-Token             = 会话令牌，回答「你是哪个用户」
 * 前者是部署级别的门禁，后者才是身份。只有身份才能做「这个行程归谁」的判定。
 *
 * 启动：node server/index.mjs   （或 npm run server）
 */

import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { log } from './lib/log.mjs'
import { createDb } from './lib/db.mjs'
import { createHub } from './lib/hub.mjs'
import { createHlc } from './lib/hlc.mjs'
import { createHttp } from './lib/http.mjs'
import { createAuth } from './lib/auth.mjs'
import { createIdentity } from './lib/identity.mjs'
import { createRateLimiter } from './lib/ratelimit.mjs'
import { createRealtime } from './lib/realtime.mjs'
import { createAuthRouter } from './routes/auth.mjs'
import { createGuidesRouter } from './routes/guides.mjs'
import { createTripsRouter } from './routes/trips.mjs'
import { createWeatherRouter } from './routes/weather.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const VERSION = '2.0.0'

// ───────────────────────── 配置 ─────────────────────────

function envInt(name, fallback, min, max) {
  // 空串视为未设置：Number('') === 0，否则 PORT='' 会绑到 1 端口、RATE_LIMIT='' 限流全命中
  const raw = String(process.env[name] ?? '').trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(__dirname, 'data')
const DB_FILE = join(DATA_DIR, 'travel.sqlite3')
/** 旧版单文件 JSON 存档；首次启动时若存在且库为空，会自动导入（见 lib/db.mjs） */
const LEGACY_JSON_FILE = join(DATA_DIR, 'db.json')
const PORT = envInt('PORT', 8787, 1, 65535)
const MAX_BODY_BYTES = envInt('MAX_BODY_BYTES', 2 * 1024 * 1024, 1024, 64 * 1024 * 1024)
const RATE_LIMIT = envInt('RATE_LIMIT', 300, 0, 100000)
const RATE_WINDOW_MS = envInt('RATE_WINDOW_MS', 60_000, 1000, 3600_000)
/** 允许客户端时间戳超前服务端的上限；超出即夹紧。设为 0 表示不夹紧 */
const MAX_CLOCK_SKEW_MS = envInt('MAX_CLOCK_SKEW_MS', 60_000, 0, 24 * 3600_000)

const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .length
  ? String(process.env.ALLOWED_ORIGINS)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:8787', 'http://127.0.0.1:8787']

// ───────────────────────── 组件 ─────────────────────────

const http1 = createHttp({ maxBodyBytes: MAX_BODY_BYTES, allowedOrigins: ALLOWED_ORIGINS })
const auth = createAuth({
  token: process.env.AUTH_TOKEN || '',
  allowAnonymous: process.env.ALLOW_ANONYMOUS === '1'
})
const limiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: RATE_LIMIT })

// 身份层：微信 openid + 无状态会话令牌。
// 与共享密钥（auth）是两码事 —— auth 回答「这个客户端能不能访问后端」，
// identity 回答「你是哪个用户」。行程/攻略的归属判定只用 identity。
const identity = createIdentity({
  appid: process.env.WX_APPID || '',
  secret: process.env.WX_SECRET || '',
  // 回落到 AUTH_TOKEN：多数部署只配一个密钥就够用，不必多记一个环境变量。
  // 两者都没有时 identity 会随机生成 —— 可用，但重启即失效，下面会在启动日志里警告。
  sessionSecret: process.env.SESSION_SECRET || process.env.AUTH_TOKEN || '',
  ttlMs: envInt('SESSION_TTL_MS', 30 * 24 * 3600 * 1000, 60_000, 365 * 24 * 3600 * 1000),
  devLogin: process.env.WX_DEV_LOGIN === '1'
})

// 服务端 HLC：给服务端自己产生的变更（如删除）盖章，并按允许偏差给明显超前的
// 客户端时间戳封顶。必须在 createDb 之前建好 —— 存储层的「已删判定」也要用同一套口径。
// NODE_ID 在多实例部署时应各不相同，否则同一毫秒同一计数下的定序会退化成随机。
const clock = createHlc({
  node: process.env.NODE_ID || `srv-${PORT}`,
  maxSkewMs: MAX_CLOCK_SKEW_MS
})

const db = createDb({ file: DB_FILE, legacyJsonFile: LEGACY_JSON_FILE, clock })

// 实时订阅中心：谁订阅了哪个空间 + 把变更通知扇出去（见 lib/hub.mjs）。
// 刻意**不放在 db 里** —— 它没有任何持久化状态，进程重启后由客户端重新订阅即可：
// 订阅关系是「这个连接此刻想要什么」，不是数据。
const hub = createHub({
  log,
  coalesceMs: envInt('WS_COALESCE_MS', 80, 0, 5000),
  maxSubsPerConn: envInt('WS_MAX_SUBS', 200, 1, 10000)
})

const WS_ENABLED = process.env.WS_ENABLED !== '0'
const WS_PATH = String(process.env.WS_PATH || '/api/ws')

const ctx = { http: http1, db, log, clock, identity, hub: WS_ENABLED ? hub : null }
const authRouter = createAuthRouter(ctx)
const guidesRouter = createGuidesRouter(ctx)
const tripsRouter = createTripsRouter(ctx)
const weatherRouter = createWeatherRouter(ctx)

// ───────────────────────── 请求管线 ─────────────────────────

const STARTED_AT = Date.now()
const sockets = new Set()
let served = 0
let rejected = 0

function clientIp(req) {
  // 若部署在反代之后，需要显式信任代理头；直连时一律用 socket 地址，避免伪造
  const fwd = process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '') : ''
  if (fwd) return fwd.split(',')[0].trim()
  return req.socket?.remoteAddress || 'unknown'
}

function healthPayload() {
  return {
    ok: true,
    name: 'travel-shared-backend',
    version: VERSION,
    uptimeMs: Date.now() - STARTED_AT,
    now: new Date().toISOString(),
    authRequired: auth.enabled,
    storage: 'sqlite',
    // 只暴露布尔状态，绝不回显 appid / secret
    identity: {
      wxConfigured: identity.wxConfigured,
      devLogin: identity.devLogin,
      sessionTtlMs: identity.ttlMs,
      ephemeralSecret: identity.ephemeralSecret
    },
    limits: { maxBodyBytes: MAX_BODY_BYTES, rateLimit: RATE_LIMIT, rateWindowMs: RATE_WINDOW_MS },
    // 实时通道状态。连接数这类指标放在这里是因为它没有别的观测面 ——
    // 实时连接不进 access 日志（否则一次长连接会话会刷爆日志）。
    realtime: realtime ? realtime.stats() : { enabled: false },
    counts: db.counts()
  }
}

async function route(req, res, url) {
  // 健康检查：不限流、不鉴权（给监控探活用），但只暴露非敏感聚合信息
  if (url.pathname === '/api/health') {
    if (req.method !== 'GET') return http1.methodNotAllowed(req, res, ['GET', 'OPTIONS'])
    return http1.send(req, res, 200, healthPayload())
  }

  // 鉴权
  const verdict = auth.check(req)
  if (!verdict.ok) {
    rejected += 1
    log.warn('鉴权失败', { reason: verdict.reason, ip: clientIp(req), path: url.pathname })
    return http1.fail(req, res, 401, 'unauthorized', { reason: verdict.reason })
  }

  // 身份（可选）：解析 X-Session-Token。**校验失败一律当作匿名**，不在这里回 401 ——
  // 因为大量接口本来就允许匿名（只读列表、公共攻略），把无效令牌当致命错误会让
  // 「令牌过期」直接变成一个功能不可用的报错，而不是「以匿名身份继续」。
  // 需要身份的接口自己判定（见 trips.writeVerdict / auth.me）。
  req.identity = identity.fromRequest(req)

  if (await authRouter.handle(req, res, url)) return true
  if (await tripsRouter.handle(req, res, url)) return true
  if (await guidesRouter.handle(req, res, url)) return true
  if (await weatherRouter.handle(req, res, url)) return true

  return http1.fail(req, res, 404, 'not found')
}

const server = http.createServer((req, res) => {
  const started = Date.now()
  req.requestId =
    String(req.headers['x-request-id'] || '').slice(0, 64) || Math.random().toString(36).slice(2, 12)
  served += 1

  // URL 解析本身就可能因畸形请求行抛错
  let url
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  } catch {
    rejected += 1
    return http1.fail(req, res, 400, 'malformed request url')
  }

  if (req.method === 'OPTIONS') {
    // 预检：白名单不命中时不下发 ACAO，浏览器自然拦截
    if (!http1.resolveOrigin(req.headers.origin)) rejected += 1
    return http1.send(req, res, 204, {})
  }

  // 限流（健康检查已在 route 内部提前返回，这里对 /api/health 放行）
  if (url.pathname !== '/api/health' && RATE_LIMIT > 0) {
    const rl = limiter.check(clientIp(req))
    if (!rl.ok) {
      rejected += 1
      log.warn('限流命中', { ip: clientIp(req), path: url.pathname, retryAfter: rl.retryAfter })
      return http1.send(
        req,
        res,
        429,
        { error: 'too many requests', retryAfter: rl.retryAfter },
        { 'Retry-After': String(rl.retryAfter) }
      )
    }
    res.setHeader('X-RateLimit-Limit', String(rl.limit))
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining))
    res.setHeader('X-RateLimit-Reset', String(rl.reset))
  }

  Promise.resolve(route(req, res, url))
    .catch((err) => {
      log.error('请求处理异常', { path: url.pathname, err: String(err?.stack || err) })
      if (!res.headersSent) http1.fail(req, res, 500, 'internal error')
      else res.end()
    })
    .finally(() => {
      const ms = Date.now() - started
      const line = {
        m: req.method,
        p: url.pathname,
        s: res.statusCode,
        ms,
        ip: clientIp(req),
        rid: req.requestId
      }
      if (ms > 500) log.warn('慢请求', line)
      else log.info('access', line)
    })
})

server.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})

// 实时网关：挂在 http server 的 `upgrade` 事件上（同一个端口，不需要额外的监听）。
// 必须在 server.listen 之前注册 —— Node 对「有 upgrade 请求但没人监听」的处理是
// 直接销毁连接，客户端只会看到握手莫名失败。
const realtime = WS_ENABLED
  ? createRealtime({
      server,
      hub,
      db,
      clock,
      identity,
      auth,
      log,
      allowedOrigins: ALLOWED_ORIGINS,
      // 握手（upgrade）不经过 request 处理器，得单独过 IP 限流。
      // 用**独立实例**（同配置同风格）：HTTP 洪泛不应连带锁死实时重连，
      // 两条通道各自有各自的每 IP 预算。RATE_LIMIT=0 表示限流关闭，传 null 保持一致口径。
      limiter: RATE_LIMIT > 0 ? createRateLimiter({ windowMs: RATE_WINDOW_MS, max: RATE_LIMIT }) : null,
      clientIpOf: clientIp,
      path: WS_PATH,
      pingMs: envInt('WS_PING_MS', 25_000, 1000, 600_000),
      authGraceMs: envInt('WS_AUTH_GRACE_MS', 5_000, 500, 60_000),
      maxPayload: envInt('WS_MAX_PAYLOAD', 64 * 1024, 1024, 1024 * 1024),
      maxConns: envInt('WS_MAX_CONNS', 500, 1, 100_000),
      maxSubsPerConn: envInt('WS_MAX_SUBS', 200, 1, 10_000),
      // 发送缓冲上限（KB）：慢消费者保护，0 表示不设限（不建议）
      maxSendBufferBytes: envInt('WS_SEND_BUFFER_KB', 1024, 0, 16 * 1024) * 1024
    })
  : null

// 畸形请求（非法请求行 / 超大头）由 Node 抛到这里，别让它把连接挂死
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  log.warn('clientError', { code: err.code })
})

server.headersTimeout = 20_000
server.requestTimeout = 30_000
server.keepAliveTimeout = 10_000

// ───────────────────────── 生命周期 ─────────────────────────

process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { err: String(reason?.stack || reason) })
})

process.on('uncaughtException', (err) => {
  log.error('uncaughtException，进程即将退出', { err: String(err?.stack || err) })
  shutdown('uncaughtException', 1)
})

let closing = false
function shutdown(signal, code = 0) {
  if (closing) return
  closing = true
  log.info('开始优雅关闭', { signal })
  server.close(() => {
    db.close()
    log.info('已安全退出', { served, rejected })
    process.exit(code)
  })
  // 实时连接是长连接，先明确告诉它们「服务端要走了」再断，
  // 否则客户端只能看到「连接异常中断」并立刻重连（而这时服务端正在重启）。
  realtime?.close()
  // 主动断开 keep-alive 长连接，否则 close() 会一直等
  for (const s of sockets) s.end()
  setTimeout(() => {
    db.close()
    log.warn('关闭超时，强制退出')
    process.exit(code || 1)
  }, 5000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// listen 失败（典型：端口被占 EADDRINUSE）若没人监听 error，会以误导性的
// uncaughtException 堆栈收场；这里给一句明确原因再退出，方便排障。
server.on('error', (err) => {
  log.error('服务出错，进程退出', { code: err?.code, message: err?.message, port: PORT })
  process.exit(1)
})

server.listen(PORT, () => {
  log.info('服务已启动', {
    url: `http://localhost:${PORT}`,
    version: VERSION,
    dataDir: DATA_DIR,
    dbFile: DB_FILE,
    migrated: db.migrated || undefined,
    authRequired: auth.enabled,
    wxLogin: identity.wxConfigured ? 'configured' : identity.devLogin ? 'DEV-LOGIN' : 'off',
    realtime: realtime ? `ws://…${WS_PATH}` : 'off',
    rateLimit: RATE_LIMIT,
    maxBodyBytes: MAX_BODY_BYTES,
    allowedOrigins: ALLOWED_ORIGINS
  })
  if (realtime) {
    log.info('实时同步已启用', {
      path: WS_PATH,
      pingMs: envInt('WS_PING_MS', 25_000, 1000, 600_000),
      coalesceMs: envInt('WS_COALESCE_MS', 80, 0, 5000)
    })
  }
  if (identity.devLogin) {
    log.warn('WX_DEV_LOGIN=1：未配置 WX_APPID/WX_SECRET，登录接口会用 code 推导假 openid —— 等于「自己声明自己是谁」，仅限本地与测试')
  }
  if (!identity.wxConfigured && !identity.devLogin) {
    log.warn('未配置 WX_APPID/WX_SECRET：/api/auth/wx 会返回 503，账号体系未启用（行程仍可按分享码协作）')
  }
  if (identity.ephemeralSecret) {
    log.warn('未配置 SESSION_SECRET / AUTH_TOKEN：会话签名密钥是随机生成的，进程重启后所有已登录用户需要重新登录')
  }
  if (auth.enabled && process.env.ALLOW_ANONYMOUS === '1') {
    log.warn('ALLOW_ANONYMOUS=1：已配置 AUTH_TOKEN 但仍放行匿名请求，仅建议内网临时使用')
  }
  if (!auth.enabled) {
    log.warn('未配置 AUTH_TOKEN：任何能访问该端口的人都能读写数据，上线前务必配置')
  }
  if (ALLOWED_ORIGINS.includes('*')) {
    log.warn("ALLOWED_ORIGINS 含 '*'：已放开的跨域来源，仅建议本地开发使用")
  }
})
