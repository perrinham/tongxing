/**
 * 实时网关：把 lib/ws.mjs 的协议、lib/hub.mjs 的订阅表接到 http server 上。
 *
 * ── 鉴权为什么放在「首帧」而不是握手 ──
 *
 * 浏览器的 `new WebSocket(url)` **不能自定义请求头**，所以会话令牌只能塞进 URL
 * 查询串 —— 而 URL 会进访问日志、Referer、浏览器历史，令牌放在那里等于定期泄漏。
 * 微信小程序的 `uni.connectSocket` 虽然支持自定义头，但 H5 侧不行，
 * 两条通道用两套鉴权方式必然会有一条被漏掉。
 *
 * 所以统一走**首帧鉴权**：
 *   1. 握手阶段只做「同源校验」（浏览器必发 Origin，非浏览器客户端没有 Origin）。
 *   2. 连接建立后，客户端必须在 `authGraceMs` 内发 `{t:'hello', key, token}`。
 *   3. 超时没等到 hello → 关掉（4001）。
 *
 * 这样令牌既不出现在 URL 里，也不需要两套代码路径。
 *
 * ⚠️ 握手成功**不等于**已授权：在收到合法 hello 之前连接只是一个「还没开口的哑巴」，
 * 它发不出订阅、也收不到任何广播。所有订阅都要求 `helloReceived === true`。
 *
 * ── 两套凭据仍然正交 ──
 *
 *   key   = 共享密钥（AUTH_TOKEN），回答「这个客户端被允许访问后端吗」
 *   token = 会话令牌，回答「你是哪个用户」
 * 前者在 hello 里校验一次即可；后者决定 openid，进而决定能订阅哪些空间。
 */

import { isSafeId } from './util.mjs'
import { isSpaceDeleted } from './db.mjs'
import { accessVerdict } from './acl.mjs'
import {
  CLOSE,
  DEFAULT_MAX_PAYLOAD,
  DEFAULT_MAX_SEND_BUFFER,
  checkHandshake,
  createWsConnection,
  rejectHandshake,
  writeHandshake
} from './ws.mjs'

/** 单帧里最多带多少个空间 id（防止有人一帧塞 10 万个） */
const MAX_IDS_PER_FRAME = 500

export function createRealtime({
  server,
  hub,
  db,
  clock,
  identity,
  auth,
  log,
  allowedOrigins = [],
  /** 握手专用 IP 限流器（与 HTTP 同配置但独立计数；RATE_LIMIT=0 时传 null） */
  limiter = null,
  /** 从 upgrade 请求取客户端 IP（与 REST 侧同一口径，含 TRUST_PROXY 处理） */
  clientIpOf = null,
  path = '/api/ws',
  pingMs = 25_000,
  authGraceMs = 5_000,
  maxPayload = DEFAULT_MAX_PAYLOAD,
  maxConns = 500,
  maxSubsPerConn = 200,
  /** 每连接发送缓冲上限（慢消费者保护，见 lib/ws.mjs 的 DEFAULT_MAX_SEND_BUFFER） */
  maxSendBufferBytes = DEFAULT_MAX_SEND_BUFFER,
  /** 每连接消息限速：桶容量与每秒回填 */
  msgBurst = 60,
  msgPerSec = 20
}) {
  const wildcardOrigin = allowedOrigins.includes('*')
  const cap = (h) => clock.cap(h)
  let connSeq = 0
  /** 被拒绝的握手数（诊断用；实时连接不出一条 access 日志，否则日志会被刷爆） */
  let rejectedHandshakes = 0
  let rejectedMessages = 0

  function originAllowed(origin) {
    if (!origin) return true // 非浏览器客户端（小程序 / Node / 服务器间）不发 Origin
    if (wildcardOrigin) return true
    return allowedOrigins.includes(origin)
  }

  /** 用共享密钥拼一个假请求喂给 createAuth.check —— 免得把校验逻辑抄第二份 */
  function keyVerdict(key) {
    const k = String(key || '').trim()
    return auth.check({
      headers: k ? { authorization: `Bearer ${k}`, 'x-api-key': k } : {}
    })
  }

  function spaceInfo(id) {
    const space = db.loadSpace(id)
    if (!space) return null
    return { rev: space.rev, deleted: isSpaceDeleted(space, cap), code: space.code }
  }

  /**
   * 逐个判定能否订阅。
   *
   * 规则与 REST 的写权限**同一份**（lib/acl.mjs）：有主空间只认 owner / 成员，
   * 无主空间保持开放。空间不存在时**允许**订阅 —— 它可能是本机刚建、还没推上来的行程，
   * 等它出现时正好能收到第一条通知；而且此时没有任何内容可泄漏。
   */
  function trySubscribe(conn, ids) {
    const accepted = []
    const denied = []
    for (const id of ids) {
      if (!isSafeId(id)) {
        denied.push({ id: String(id).slice(0, 32), reason: 'invalid-id' })
        continue
      }
      const space = db.loadSpace(id)
      if (space) {
        const verdict = accessVerdict(db, space, conn.openid)
        if (!verdict.ok) {
          denied.push({ id, reason: verdict.reason })
          continue
        }
      }
      const r = hub.subscribe(conn, id)
      if (!r.ok) {
        denied.push({ id, reason: r.reason })
        continue
      }
      const info = spaceInfo(id)
      accepted.push({ id, exists: !!info, rev: info?.rev ?? 0, deleted: info?.deleted ?? false })
    }
    return { accepted, denied }
  }

  // ───────────────────────── 消息处理 ─────────────────────────

  function onMessage(msg, conn) {
    // 限速：令牌桶。超出就丢弃并记账 —— 不关连接，因为一条多余的消息不值得
    // 让用户掉线重连（那才是真正的体验损伤）。
    if (!takeToken(conn)) {
      rejectedMessages += 1
      return
    }

    const t = String(msg.t || '')

    if (t === 'hello') {
      if (conn.helloReceived) {
        // 重复 hello：直接更新身份（客户端可能在登录后重发以刷新身份），
        // 但不清空已有订阅 —— 清空会让客户端「登录之后实时同步突然断了」。
        applyIdentity(conn, msg)
        conn.send(readyFrame(conn))
        return
      }

      const kv = keyVerdict(msg.key)
      if (!kv.ok) {
        log?.warn?.('实时连接鉴权失败', { conn: conn.id, reason: kv.reason })
        conn.send({ t: 'error', message: 'unauthorized', reason: kv.reason })
        conn.close(CLOSE.POLICY_VIOLATION, 'unauthorized')
        return
      }
      applyIdentity(conn, msg)
      conn.helloReceived = true
      if (conn.authTimer) {
        clearTimeout(conn.authTimer)
        conn.authTimer = null
      }
      conn.send(readyFrame(conn))
      return
    }

    // 以下全部要求已鉴权。用 hello 之前的连接能做的最坏的事是占一个 fd，
    // 而 authGraceMs 一到就会被踢掉。
    if (!conn.helloReceived) {
      conn.send({ t: 'error', message: 'hello first' })
      return
    }

    if (t === 'sub') {
      const ids = normIds(msg.ids)
      if (!ids) {
        conn.send({ t: 'error', message: 'ids must be an array' })
        return
      }
      const { accepted, denied } = trySubscribe(conn, ids)
      if (denied.length) {
        log?.debug?.('实时订阅被拒', { conn: conn.id, denied })
      }
      conn.send({ t: 'subscribed', accepted, denied })
      return
    }

    if (t === 'unsub') {
      const ids = normIds(msg.ids)
      if (!ids) {
        conn.send({ t: 'error', message: 'ids must be an array' })
        return
      }
      const gone = []
      for (const id of ids) if (hub.unsubscribe(conn, id)) gone.push(id)
      conn.send({ t: 'unsubscribed', ids: gone })
      return
    }

    if (t === 'ping') {
      conn.send({ t: 'pong', ts: Number(msg.ts) || 0 })
      return
    }

    if (t === 'pong') return

    // 不认识的消息类型：回一条错误但**不关连接**，这样老服务端遇到新客户端
    // 多发的字段/消息时不会把用户踢下线。
    conn.send({ t: 'error', message: `unknown message type: ${t.slice(0, 24)}` })
  }

  function applyIdentity(conn, msg) {
    const token = Array.isArray(msg.token) ? msg.token[0] : msg.token
    const v = identity.verify(typeof token === 'string' ? token : '')
    const prev = conn.openid
    conn.openid = v.ok ? v.openid : ''
    conn.authReason = v.reason
    conn.deviceId = String(msg.deviceId || '').slice(0, 64)
    // 重复 hello 换人 / 掉身份（令牌失效 openid 被清空）：按新身份复核已有订阅，
    // 无权读的空间即时退订 —— 否则旧身份留下的订阅会继续收到私有空间的更新通知。
    if (conn.helloReceived && prev !== conn.openid) {
      const dropped = []
      for (const id of conn.subscriptions || []) {
        const space = db.loadSpace(id)
        // 空间不存在（可能本机刚建还没推上来）：保持订阅，与 trySubscribe 口径一致
        if (!space) continue
        if (!accessVerdict(db, space, conn.openid).ok) {
          hub.unsubscribe(conn, id)
          dropped.push(id)
        }
      }
      if (dropped.length) {
        log?.info?.('身份变更，回收无权订阅', { conn: conn.id, count: dropped.length })
      }
    }
  }

  function readyFrame(conn) {
    return {
      t: 'ready',
      conn: conn.id,
      // 只回「有没有身份」，不回 openid —— 与 REST 侧「身份标识不进响应体」的约定一致
      authed: !!conn.openid,
      authReason: conn.authReason,
      pingMs,
      now: Date.now(),
      maxSubs: maxSubsPerConn,
      coalesceMs: hub.coalesceMs
    }
  }

  function normIds(raw) {
    if (!Array.isArray(raw)) return null
    const out = []
    const seen = new Set()
    for (const v of raw.slice(0, MAX_IDS_PER_FRAME)) {
      const s = typeof v === 'string' ? v : ''
      if (!s || seen.has(s)) continue
      seen.add(s)
      out.push(s)
    }
    return out
  }

  /** 令牌桶，桶挂在连接对象上（连接一走就随之回收） */
  function takeToken(conn) {
    const now = Date.now()
    if (!conn.bucket) conn.bucket = { tokens: msgBurst, at: now }
    const b = conn.bucket
    const elapsed = Math.max(0, now - b.at) / 1000
    if (elapsed > 0) {
      b.tokens = Math.min(msgBurst, b.tokens + elapsed * msgPerSec)
      b.at = now
    }
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }

  // ───────────────────────── 握手 ─────────────────────────

  function onUpgrade(req, socket, head) {
    let url
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    } catch {
      rejectedHandshakes += 1
      return rejectHandshake(socket, 400, 'malformed request url')
    }

    if (url.pathname !== path) {
      rejectedHandshakes += 1
      return rejectHandshake(socket, 404, 'no websocket endpoint here')
    }

    // 握手也过 IP 限流：upgrade 走独立的 'upgrade' 事件，不经过 HTTP 侧的 request
    // 处理器，不限流的话海量握手可以绕过 REST 的限流预算。与 HTTP 共用同一份
    // 每 IP 计数（握手占一个名额），超限直接拒握手。
    if (limiter) {
      const ip = clientIpOf ? clientIpOf(req) : ''
      const rl = limiter.check(ip)
      if (!rl.ok) {
        rejectedHandshakes += 1
        log?.warn?.('实时握手被拒（IP 限流）', { ip })
        return rejectHandshake(socket, 429, 'too many requests')
      }
    }

    // 同源校验。浏览器发起 WS 一定会带 Origin，非浏览器客户端不带 ——
    // 所以「有 Origin 就必须在白名单里」既能挡住恶意网页，又不会误伤小程序 / 脚本。
    const origin = req.headers.origin
    if (!originAllowed(origin)) {
      rejectedHandshakes += 1
      log?.warn?.('实时握手被拒（来源不在白名单）', { origin: String(origin).slice(0, 80) })
      return rejectHandshake(socket, 403, 'origin not allowed')
    }

    const hs = checkHandshake(req)
    if (!hs.ok) {
      rejectedHandshakes += 1
      return rejectHandshake(socket, hs.status, hs.error)
    }

    // ⚠️ 连接数上限必须在**发 101 之前**判：一旦升级成功，这就是一条长连接，
    // 再想拒绝就变成「连上又被踢」，客户端会立刻重连 —— 反而放大压力。
    if (hub.stats().connections >= maxConns) {
      rejectedHandshakes += 1
      log?.warn?.('实时连接数已达上限，拒绝新连接', { maxConns })
      return rejectHandshake(socket, 503, 'too many realtime connections')
    }

    writeHandshake(socket, hs.key)
    // Node 默认会对小包做 Nagle 合并：一条几十字节的通知被攒 40ms 才发出去，
    // 「实时」就没了一半。实时通道必须关掉。
    socket.setNoDelay?.(true)
    // 关掉 socket 空闲超时：判活由应用层心跳负责（间隔可配、且能区分「慢」与「死」）
    socket.setTimeout?.(0)

    connSeq += 1
    const id = `ws-${connSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`

    // 用 `let` 而不是 `const`：`createWsConnection` 在构造期就会把 upgrade 带出来的
    // 首个数据块喂给解析器（客户端可以在握手请求里把 close 帧一起 pipeline 过来），
    // 那条路径可能**同步**触发 onClose —— 此时 conn 还没赋值。用 const 会直接
    // 抛 TDZ 的 ReferenceError，把一个畸形请求变成一次进程异常。
    let conn = null

    conn = createWsConnection(socket, {
      id,
      maxPayload,
      maxBufferedBytes: maxSendBufferBytes,
      peek: head,
      onMessage: (msg, c) => onMessage(msg, c),
      onError: (info) => {
        if (info?.reason !== 'socket-error') {
          log?.debug?.('实时连接协议错误', { conn: id, ...info })
        }
      },
      onClose: (info) => {
        if (!conn) return // 构造期同步关闭：还没进 hub，无需清理
        hub.remove(conn)
        if (conn.authTimer) clearTimeout(conn.authTimer)
        if (conn.helloReceived) {
          log?.info?.('实时连接断开', {
            conn: id,
            openid: conn.openid ? conn.openid.slice(0, 8) : '',
            subs: conn.subscriptions?.size || 0,
            reason: info?.reason || info?.code
          })
        }
      }
    })

    if (conn.closed) return

    // 网关自己挂在 conn 上的字段（协议层不认识这些）
    conn.openid = ''
    conn.authReason = 'missing-session'
    conn.deviceId = ''
    conn.helloReceived = false
    conn.subscriptions = new Set()
    conn.remoteAddress = socket.remoteAddress || ''
    conn.authTimer = setTimeout(() => {
      if (conn.helloReceived) return
      log?.debug?.('实时连接首帧超时（未发 hello）', { conn: id })
      conn.send({ t: 'error', message: 'hello timeout' })
      conn.close(CLOSE.NO_AUTH, 'hello timeout')
    }, authGraceMs)
    conn.authTimer.unref?.()

    hub.add(conn)
  }

  server.on('upgrade', onUpgrade)

  // ───────────────────────── 心跳 ─────────────────────────

  /**
   * 应用层心跳（而不是协议层 ping）。
   *
   * 用协议层 ping 更省字节，但小程序侧的 `SocketTask` 不保证把 pong 暴露给业务代码，
   * 也没法从业务侧观察到底有没有回。用一条 `{t:'ping'}` 文本消息 + 客户端回 `{t:'pong'}`，
   * 则在三端（小程序 / H5 / Node 测试）行为完全一致，且判活依据就是「有没有回过消息」。
   *
   * 连续两个周期没有任何消息（任何帧都算）就判定为死连接。**不能只判 pong** ——
   * 一个正在正常推送数据的连接不该被心跳误杀。
   */
  const heartbeat = setInterval(() => {
    const now = Date.now()
    const limit = pingMs * 2
    for (const conn of hub.connections()) {
      if (now - conn.lastSeenAt > limit) {
        log?.info?.('实时连接心跳超时，断开', { conn: conn.id, idleMs: now - conn.lastSeenAt })
        conn.close(CLOSE.GOING_AWAY, 'heartbeat timeout')
        continue
      }
      conn.send({ t: 'ping', ts: now })
    }
  }, pingMs)
  heartbeat.unref?.()

  /**
   * 优雅关闭。
   *
   * 先给每条实时连接发一个**正常的关闭帧**（1001 going away），再清订阅表。
   * 直接 destroy 会让客户端只看到「连接断了」，于是立刻进入重连退避 ——
   * 而服务端正在重启，客户端会白连几轮。发出关闭帧后，客户端能识别出
   * 「这是服务端主动关的」，按「稍后重连」处理。
   */
  function close() {
    clearInterval(heartbeat)
    server.off?.('upgrade', onUpgrade)
    for (const conn of hub.connections()) {
      try {
        conn.close(CLOSE.GOING_AWAY, 'server shutting down')
      } catch {
        /* 连接可能已经死了 */
      }
    }
    hub.closeAll()
  }

  function stats() {
    return {
      enabled: true,
      path,
      pingMs,
      authGraceMs,
      coalesceMs: hub.coalesceMs,
      maxConns,
      maxPayload,
      maxSendBufferBytes,
      rejectedHandshakes,
      rejectedMessages,
      ...hub.stats()
    }
  }

  return { close, stats, onUpgrade }
}
