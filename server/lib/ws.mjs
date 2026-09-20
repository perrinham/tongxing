/**
 * 极简 WebSocket（RFC 6455）服务端实现 —— 零依赖。
 *
 * ── 为什么自己写 ──
 *
 * 本环境 `npm install` 被沙箱 broker 拦截，装不了 `ws`。而 Node 内置只有
 * `http` / `net`，**没有** WebSocket 服务端。所以这里手写协议里真正需要的那一小块：
 * 握手（Sec-WebSocket-Accept）+ 帧编解码 + 关闭握手。
 *
 * 砍掉了什么（都在注释里写明，不要误以为「已经支持」）：
 *   · 不做 permessage-deflate 扩展协商（握手时忽略 Sec-WebSocket-Extensions）；
 *   · 不做子协议协商（Sec-WebSocket-Protocol 一律不回）；
 *   · 不做分片的**流式**处理：分片会被攒齐后一次性交给上层（我们的消息很小）。
 *
 * ⚠️ 客户端 → 服务端的帧**必须**带掩码（RFC 6455 §5.1），不带就是协议错误。
 * 这不是可选的严格性：掩码是为了防「代理缓存投毒」——不校验就意味着任何中间
 * 代理都可能把一段看起来合法的帧缓存下来重放。所以这里一律拒绝并回 1002。
 *
 * ── 本模块的边界 ──
 *
 * 只做协议，不做业务：不知道什么是「空间」、什么是「身份」、什么是「订阅」。
 * 应用语义在 lib/realtime.mjs。
 *
 * ⚠️ 解析器 `createFrameParser` 刻意做成**纯状态机**（喂 Buffer 进、吐事件出），
 * 不碰 socket —— 这样才能在测试里逐字节喂入，把「TCP 分片切在帧中间」这类
 * 真实但难复现的情况变成确定性断言。
 */

import { createHash, randomBytes } from 'node:crypto'

/** RFC 6455 规定的握手魔数 */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const OPCODE = {
  CONT: 0x0,
  TEXT: 0x1,
  BIN: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa
}

/** 关闭码（RFC 6455 §7.4.1 + §11.7） */
export const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  POLICY_VIOLATION: 1008,
  TOO_BIG: 1009,
  INTERNAL: 1011,
  /** 应用层自定义：首帧迟迟不来 / 鉴权失败 */
  NO_AUTH: 4001,
  REPLACED: 4002
}

/** 控制帧载荷上限（RFC 6455 §5.5，硬性规定 125） */
const MAX_CONTROL_PAYLOAD = 125

/** 默认单条消息上限。我们的消息都是小 JSON，64KB 已经非常宽松 */
export const DEFAULT_MAX_PAYLOAD = 64 * 1024

/**
 * 发送缓冲上限（慢消费者保护）。
 *
 * 客户端停止读 TCP（切后台 / 弱网 / 恶意）时，`socket.write` 的数据会**无限堆积**
 * 在 Node 用户态缓冲里 —— 内存悄悄涨，而且应用层心跳杀不掉它：
 * 心跳判活看的是「对端有没有发帧回来」，而慢的是「读」方向，对端照样能回 pong。
 * 唯一可靠的信号是 `socket.writableLength`；超限就把连接踢掉。
 * 通知模型天然自愈：客户端重连后按 rev 重拉，不丢内容。
 */
export const DEFAULT_MAX_SEND_BUFFER = 1024 * 1024

// ───────────────────────── 握手 ─────────────────────────

/** 由 Sec-WebSocket-Key 算出 Sec-WebSocket-Accept */
export function acceptKey(key) {
  return createHash('sha1')
    .update(String(key) + WS_GUID)
    .digest('base64')
}

/**
 * 校验 upgrade 请求是否是一个合法的 WebSocket 握手。
 * @returns {{ ok: true, key: string } | { ok: false, status: number, error: string }}
 */
export function checkHandshake(req) {
  const upgrade = String(req.headers.upgrade || '').toLowerCase()
  if (upgrade !== 'websocket') return { ok: false, status: 400, error: 'expected Upgrade: websocket' }

  // Connection 头可能是 "keep-alive, Upgrade" 这种列表形式
  const conn = String(req.headers.connection || '').toLowerCase()
  if (!conn.split(',').some((s) => s.trim() === 'upgrade')) {
    return { ok: false, status: 400, error: 'expected Connection: Upgrade' }
  }

  const version = String(req.headers['sec-websocket-version'] || '')
  if (version !== '13') return { ok: false, status: 426, error: 'unsupported websocket version' }

  const key = String(req.headers['sec-websocket-key'] || '').trim()
  // 规范要求是 16 字节的 base64（24 字符，含 '='）。这里只做长度与字符集粗校验：
  // accept 的计算不受 key 内容影响，过严的校验只会把合法客户端挡在外面。
  if (key.length < 16 || key.length > 64) {
    return { ok: false, status: 400, error: 'missing sec-websocket-key' }
  }
  return { ok: true, key }
}

/**
 * 把 101 响应写到裸 socket 上。
 *
 * ⚠️ 必须用 `socket.write` 手写响应，不能走 `res.writeHead` ——
 * `upgrade` 事件拿到的连接已经脱离了 http 响应生命周期，
 * 用 ServerResponse 会走成普通 HTTP 响应而不是协议切换。
 */
export function writeHandshake(socket, key, extraHeaders = {}) {
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`
  ]
  for (const [k, v] of Object.entries(extraHeaders)) lines.push(`${k}: ${v}`)
  socket.write(lines.join('\r\n') + '\r\n\r\n')
}

/** 握手之前就失败时，回一个普通 HTTP 响应再关连接（浏览器才能看到状态码） */
export function rejectHandshake(socket, status, message) {
  const body = JSON.stringify({ error: message })
  socket.write(
    `HTTP/1.1 ${status} ${httpStatusText(status)}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n' +
      '\r\n' +
      body
  )
  socket.destroy()
}

function httpStatusText(status) {
  const map = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    426: 'Upgrade Required',
    429: 'Too Many Requests',
    503: 'Service Unavailable'
  }
  return map[status] || 'Error'
}

// ───────────────────────── 帧编码 ─────────────────────────

/**
 * 编一个帧。
 * @param {number} opcode
 * @param {Buffer|string} payload
 * @param {{fin?: boolean, mask?: boolean}} opts  mask=true 用于客户端/测试
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf-8')
  const len = data.length

  let extLen = 0
  let lenField = len
  if (len >= 126 && len < 65536) {
    extLen = 2
    lenField = 126
  } else if (len >= 65536) {
    extLen = 8
    lenField = 127
  }

  const headerLen = 2 + extLen + (mask ? 4 : 0)
  const header = Buffer.alloc(headerLen)
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
  header[1] = lenField | (mask ? 0x80 : 0x00)

  let off = 2
  if (extLen === 2) {
    header.writeUInt16BE(len, off)
    off += 2
  } else if (extLen === 8) {
    // 高 32 位恒为 0 —— 我们不可能发送 4GB 的消息
    header.writeUInt32BE(0, off)
    header.writeUInt32BE(len, off + 4)
    off += 8
  }

  if (!mask) return Buffer.concat([header, data])

  const key = randomBytes(4)
  key.copy(header, off)
  const masked = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i += 1) masked[i] = data[i] ^ key[i & 3]
  return Buffer.concat([header, masked])
}

/** 文本帧（内部自动 JSON.stringify） */
export function encodeText(obj, opts) {
  return encodeFrame(OPCODE.TEXT, JSON.stringify(obj), opts)
}

/** 关闭帧：2 字节大端状态码 + UTF-8 原因（原因会被截到 123 字节内） */
export function encodeClose(code = CLOSE.NORMAL, reason = '', opts) {
  const text = Buffer.from(String(reason).slice(0, 100), 'utf-8').subarray(0, 123)
  const body = Buffer.allocUnsafe(2 + text.length)
  body.writeUInt16BE(code, 0)
  text.copy(body, 2)
  return encodeFrame(OPCODE.CLOSE, body, opts)
}

// ───────────────────────── 帧解析 ─────────────────────────

/**
 * 增量帧解析器（纯状态机）。
 *
 * 用法：
 *   const p = createFrameParser({ onMessage, onPing, onPong, onClose, onError })
 *   p.push(chunk)   // 可以任意切分，包括切在帧头中间
 *
 * `onMessage(opcode, payload)`：TEXT / BIN 的完整消息（分片已攒齐）。
 * `onError({ reason, code })`：协议错误；**调用方负责关连接**，解析器之后会停止工作。
 * 一旦出错，后续 push 一律被忽略 —— 已经流错位了，继续解析只会产生垃圾事件。
 */
export function createFrameParser({
  maxPayload = DEFAULT_MAX_PAYLOAD,
  onMessage,
  onPing,
  onPong,
  onClose,
  onError
} = {}) {
  let buf = Buffer.alloc(0)
  let errored = false

  // 分片状态：opcode 0 是「延续帧」，要靠记住首帧的 opcode 才知道整个消息是什么类型
  let fragOp = 0
  let fragParts = []
  let fragLen = 0

  function fail(reason, code = CLOSE.PROTOCOL_ERROR) {
    if (errored) return
    errored = true
    onError?.({ reason, code })
  }

  function push(chunk) {
    if (errored) return
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk

    // 一个 chunk 里可能挤着多个帧（尤其小消息），所以循环到「数据不够」为止
    for (;;) {
      if (buf.length < 2) return

      const b0 = buf[0]
      const b1 = buf[1]
      const fin = (b0 & 0x80) !== 0
      const rsv = b0 & 0x70
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f

      // RSV 位非 0 说明对端在用一个我们没协商的扩展（比如 permessage-deflate）。
      // 静默当成数据解析会把压缩后的字节当 JSON，所以必须报协议错误。
      if (rsv !== 0) return fail('reserved bits set without an extension')

      let off = 2
      if (len === 126) {
        if (buf.length < off + 2) return
        len = buf.readUInt16BE(off)
        off += 2
      } else if (len === 127) {
        if (buf.length < off + 8) return
        const hi = buf.readUInt32BE(off)
        const lo = buf.readUInt32BE(off + 4)
        // 高 32 位非 0 = 4GB 以上，直接按超限处理，免得 Number 精度出问题
        if (hi !== 0) return fail('payload too large', CLOSE.TOO_BIG)
        len = lo
        off += 8
      }

      const isControl = opcode >= 0x8
      if (isControl) {
        // 控制帧不允许分片、载荷 ≤125（RFC 6455 §5.5），违反即协议错误
        if (!fin) return fail('fragmented control frame')
        if (len > MAX_CONTROL_PAYLOAD) return fail('control frame payload too long')
      }

      if (!masked) return fail('client frame must be masked')

      if (!isControl) {
        if (len > maxPayload) return fail('payload too large', CLOSE.TOO_BIG)
        if (fragLen + len > maxPayload) return fail('fragmented payload too large', CLOSE.TOO_BIG)
      }

      const need = off + 4 + len
      if (buf.length < need) return

      const key = buf.subarray(off, off + 4)
      off += 4
      const payload = Buffer.allocUnsafe(len)
      for (let i = 0; i < len; i += 1) payload[i] = buf[off + i] ^ key[i & 3]
      buf = buf.subarray(off + len)

      switch (opcode) {
        case OPCODE.TEXT:
        case OPCODE.BIN: {
          if (fragOp !== 0) return fail('new data frame while a fragmented message is open')
          if (fin) {
            onMessage?.(opcode, payload)
          } else {
            fragOp = opcode
            fragParts = [payload]
            fragLen = len
          }
          break
        }
        case OPCODE.CONT: {
          if (fragOp === 0) return fail('continuation frame without a preceding data frame')
          fragParts.push(payload)
          fragLen += len
          if (fin) {
            const whole = Buffer.concat(fragParts, fragLen)
            const op = fragOp
            fragOp = 0
            fragParts = []
            fragLen = 0
            onMessage?.(op, whole)
          }
          break
        }
        case OPCODE.PING:
          onPing?.(payload)
          break
        case OPCODE.PONG:
          onPong?.(payload)
          break
        case OPCODE.CLOSE: {
          let code = CLOSE.NORMAL
          let reason = ''
          if (payload.length >= 2) {
            code = payload.readUInt16BE(0)
            reason = payload.subarray(2).toString('utf-8')
          } else if (payload.length === 1) {
            // 1 字节的关闭帧是非法的（码要么 0 字节要么 ≥2 字节）
            return fail('malformed close frame')
          }
          onClose?.({ code, reason })
          break
        }
        default:
          // 3-7 / 11-15 都是保留 opcode，未协商扩展时不许出现
          return fail(`unknown opcode ${opcode}`, CLOSE.UNSUPPORTED_DATA)
      }
    }
  }

  return {
    push,
    get errored() {
      return errored
    },
    /** 还有多少字节积压在缓冲区（诊断用） */
    get buffered() {
      return buf.length
    }
  }
}

// ───────────────────────── 连接封装 ─────────────────────────

/**
 * 把裸 socket 包成一个「能收发 JSON 的连接」。
 *
 * 职责：帧 ↔ 对象、关闭握手、协议级 ping/pong。**不含心跳定时器** ——
 * 心跳是应用语义（间隔可配、错过几次算死），放在 realtime.mjs 里。
 *
 * @param {import('node:net').Socket} socket  已发过 101 的裸 socket
 * @param {object} opts
 * @param {string} opts.id                     连接 id（日志与「排除发起者」用）
 * @param {number} [opts.maxPayload]
 * @param {number} [opts.maxBufferedBytes]     发送缓冲上限，超过即踢（0 = 不设限）
 * @param {(msg: object, conn: object) => void} [opts.onMessage]
 * @param {(info: {code:number, reason:string}) => void} [opts.onClose]
 * @param {(err: any) => void} [opts.onError]
 * @param {string} [opts.peek]  首个数据块（upgrade 事件里带出来的 head）
 */
export function createWsConnection(socket, opts = {}) {
  const { id = 'conn', maxPayload = DEFAULT_MAX_PAYLOAD } = opts
  const maxBufferedBytes = opts.maxBufferedBytes ?? DEFAULT_MAX_SEND_BUFFER

  /** 对端是否已经发过关闭帧（区分「对端先关」与「网络断了」） */
  let peerClosed = false
  /**
   * onClose 只能通知一次。
   *
   * 走完关闭握手的连接会**先后**触发两条路径：解析器收到 close 帧、以及
   * socket 的 'close' 事件。两条都通知的话，上层（hub / 订阅表）会被要求
   * 清理同一个连接两次，日志里也会出现两条「连接断开」——掩盖真正的断开原因。
   */
  let closeNotified = false

  function notifyClose(info) {
    if (closeNotified) return
    closeNotified = true
    opts.onClose?.(info)
  }

  const conn = {
    id,
    socket,
    /** 建连时刻 */
    openedAt: Date.now(),
    /** 最后一次收到任何帧的时刻（应用层心跳判活只看它） */
    lastSeenAt: Date.now(),
    /** 已发送的帧数（诊断用） */
    sentFrames: 0,
    /** 收到的消息数（限流用） */
    recvMessages: 0,
    /**
     * 是否已关闭（服务端主动关或对端关）。
     *
     * ⚠️ 这是**唯一**的关闭状态。早先还额外有一个闭包变量 `closed`，
     * 两处必须手工同步 —— 而 `close()` 里「先置位再发关闭帧」的顺序一旦写反，
     * 关闭帧就发不出去（对端只看到连接被强拆）。一个状态只留一份。
     */
    closed: false
  }

  /**
   * 裸写：只看 socket 还在不在。
   * ⚠️ 不能在这里判 `conn.closed` —— 关闭帧正是在置位之后才发出去的，
   * 判了就会「想关却关不掉」，对端只能看到连接被强拆。
   */
  function rawSend(buf) {
    if (socket.destroyed) return false
    conn.sentFrames += 1
    try {
      return socket.write(buf)
    } catch {
      return false
    }
  }

  /**
   * 发一个 JSON 文本帧；序列化失败只记日志、不抛出（不能因为一条消息没发出去就把连接搞挂）。
   *
   * 发送背压在这里检查（而不是 rawSend）：协议级 ping/pong/close 必须**永远出得去** ——
   * 连接正是因为「发不动」才被踢的，如果踢它之前的那条关闭帧也被挡住，对端只能看到
   * 连接被强拆（这正是 close() 注释里「想关却关不掉」的老课）。数据帧才是堆积的大头，只对它设限。
   */
  function send(obj) {
    if (conn.closed) return false
    let text
    try {
      text = JSON.stringify(obj)
    } catch (err) {
      opts.onError?.({ reason: 'serialize-failed', err: String(err?.message || err) })
      return false
    }
    if (maxBufferedBytes > 0 && socket.writableLength > maxBufferedBytes) {
      opts.onError?.({
        reason: 'send-buffer-overflow',
        buffered: socket.writableLength,
        limit: maxBufferedBytes
      })
      close(CLOSE.POLICY_VIOLATION, 'slow consumer')
      return false
    }
    return rawSend(encodeFrame(OPCODE.TEXT, text))
  }

  /** 协议级 ping（保活探测；与「应用层 ping 消息」并存，各管一段） */
  function ping(payload = Buffer.alloc(0)) {
    return rawSend(encodeFrame(OPCODE.PING, payload))
  }

  function pong(payload = Buffer.alloc(0)) {
    return rawSend(encodeFrame(OPCODE.PONG, payload))
  }

  /**
   * 主动关闭：发关闭帧 → 等对端回 close 或超时 → destroy。
   *
   * 直接 `destroy()` 会让对端只看到「连接断了」，客户端无法区分
   * 「服务端有理由地关我」和「网络抖动」—— 前者不该立刻重连
   * （比如鉴权失败、被新连接顶替），后者必须重连。
   */
  function close(code = CLOSE.NORMAL, reason = '') {
    if (conn.closed) return
    conn.closed = true
    rawSend(encodeClose(code, reason))
    // 给对端的关闭帧一点时间过来；到点就强拆，避免半开连接占着 fd
    const t = setTimeout(() => {
      if (!socket.destroyed) socket.destroy()
    }, 1000)
    t.unref?.()
  }
  function destroy() {
    conn.closed = true
    if (!socket.destroyed) socket.destroy()
  }

  const parser = createFrameParser({
    maxPayload,
    onMessage: (opcode, payload) => {
      conn.lastSeenAt = Date.now()
      conn.recvMessages += 1
      if (opcode === OPCODE.BIN) {
        // 业务只用文本；收到二进制按「不支持」处理（RFC 6455 §7.4.1 1003）
        close(CLOSE.UNSUPPORTED_DATA, 'binary frames are not supported')
        return
      }
      let msg
      try {
        msg = JSON.parse(payload.toString('utf-8'))
      } catch {
        send({ t: 'error', message: 'invalid json' })
        return
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        send({ t: 'error', message: 'message must be an object' })
        return
      }
      opts.onMessage?.(msg, conn)
    },
    onPing: (payload) => {
      conn.lastSeenAt = Date.now()
      pong(payload)
    },
    onPong: () => {
      conn.lastSeenAt = Date.now()
    },
    onClose: ({ code, reason }) => {
      conn.lastSeenAt = Date.now()
      peerClosed = true
      // 回一个关闭帧完成握手（1005/1006 是「本地合成」的码，不允许出现在线上帧里）
      rawSend(encodeClose(code === 1005 || code === 1006 ? CLOSE.NORMAL : code))
      conn.closed = true
      notifyClose({ code, reason, initiatedBy: 'peer' })
      socket.end()
      // end() 之后正常对端会立刻回 FIN，但半开对端（发完 close 就装死）永远不会 ——
      // 不强拆的话 fd 永久泄漏，而 notifyClose 已把它从 hub 摘掉，心跳与连接
      // 上限都看不见它，未认证就能无限占 fd。给 5s 收尾，到点硬销毁。
      const t = setTimeout(() => {
        if (!socket.destroyed) socket.destroy()
      }, 5000)
      t.unref?.()
    },
    onError: ({ reason, code }) => {
      opts.onError?.({ reason, code })
      close(code, reason)
    }
  })

  socket.on('data', (chunk) => parser.push(chunk))
  socket.on('error', (err) => {
    opts.onError?.({ reason: 'socket-error', err: String(err?.message || err) })
    destroy()
  })
  socket.on('close', () => {
    const wasClosed = conn.closed
    conn.closed = true
    // 没走关闭握手就断了 = 异常断开（网络问题 / 对端被杀）。
    // 上层需要这个区别来决定「要不要通知应用层做清理」。
    notifyClose({
      code: peerClosed ? CLOSE.NORMAL : CLOSE.GOING_AWAY,
      reason: wasClosed ? 'closed-by-server' : 'socket-closed',
      initiatedBy: peerClosed ? 'peer' : 'network'
    })
  })

  // upgrade 事件里可能已经带出了第一个数据块（客户端很可能在 101 之后立刻发 hello）
  if (opts.peek && opts.peek.length) parser.push(opts.peek)

  /**
   * ⚠️ 方法**挂回 conn 自身**，不另建一个返回对象。
   *
   * 曾经返回过一个新对象（带 send/close 的包装），而 onMessage 回调里传的是内部
   * 描述符 —— 于是「同一个连接」在网关眼里是两个不同的对象：网关往返回对象上挂
   * `openid` / `helloReceived`，回调里拿到的那个却没有；反过来往回调对象上挂的字段
   * 网关也看不见。第一版就是这么炸的（`conn.send is not a function`）。
   * 一个连接只能有一个对象。
   */
  conn.lastSeenAt = Date.now()
  conn.send = send
  conn.ping = ping
  conn.pong = pong
  conn.close = close
  conn.destroy = destroy

  return conn
}
