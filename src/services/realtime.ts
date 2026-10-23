/**
 * 实时同步客户端（WebSocket）。
 *
 * ── 它解决的是什么 ──
 *
 * 在这一步之前，同步是**拉模型**：本机改完推上去、冷启动拉一遍、回到前台拉一遍。
 * 于是「同行的人在另一个手机上改了账单」这件事，只有等到我这边正好发起同步
 * 才会被看到 —— 两人同时对着同一次旅行记账时，体验是「我改完你才知道」。
 *
 * 服务端推送的是一条**通知**（`{t:'update', id, rev}`），不带文档体。
 * 收到之后由 store 去拉那一个空间 —— 合并逻辑因此仍然只有一份
 * （见 server/lib/hub.mjs 的文件头，那里写了为什么不做「推内容」）。
 *
 * ── 为什么是工厂而不是单例 ──
 *
 * 与 store 里的 HLC / 定时器同一个理由：**模块级单例在多实例场景下会串台**。
 * 测试里同时跑三台「设备」（三个 store 实例），单例会让它们共用一条连接、
 * 共用一份订阅列表，而且 A 的令牌会顺手作用到 B 上 —— 于是「B 登录前收不到推送」
 * 这类断言永远是绿的，什么都没验到。
 *
 * 所以这里导出的是 `createRealtime()`，由调用方（store）按实例持有。
 *
 * ── 它是加速层，不是可靠层 ──
 *
 * 断线、漏消息、服务端重启都不影响最终一致性：订阅响应会带每个空间当前的 rev，
 * 客户端比对本地 rev 就能发现「我错过了什么」并补拉。所以这里的所有失败路径
 * 都选择**静默退避重连**，从不抛错、从不阻塞 UI。
 */

import { hasCloud } from '@/services/cloud'

/** 连接状态（给人看 / 给断言用） */
export type RealtimeStatus = 'disabled' | 'idle' | 'connecting' | 'online' | 'offline' | 'stopped'

export interface RealtimeUpdate {
  id: string
  rev: number
  deleted: boolean
  updatedBy: string
  at: number
}

export interface RealtimeSubInfo {
  id: string
  exists: boolean
  rev: number
  deleted: boolean
}

export interface RealtimeDenied {
  id: string
  reason: string
}

export interface RealtimeTiming {
  retryBaseMs: number
  retryMaxMs: number
  helloTimeoutMs: number
  idleTimeoutMs: number
  idleCheckMs: number
}

export interface RealtimeDeps {
  /** ws:// 或 wss:// 完整地址 */
  url: string
  /** 当前会话令牌（每次 hello 时现取，避免持有过期副本） */
  token: () => string
  /** 共享密钥（对应服务端 AUTH_TOKEN），可选 */
  key?: () => string
  /** 本机标识，仅用于服务端审计 */
  deviceId: () => string
  onStatus?: (status: RealtimeStatus, detail: string) => void
  onUpdate?: (u: RealtimeUpdate) => void
  /** 订阅结果：`accepted` 里带服务端当前 rev（用于补拉），`denied` 表示服务端不给订 */
  onSubscribed?: (accepted: RealtimeSubInfo[], denied: RealtimeDenied[]) => void
  timing?: Partial<RealtimeTiming>
}

/** 小程序 / H5 的 SocketTask 最小接口（不依赖 UniApp 命名空间类型，方便 Node 里跑） */
interface SocketTaskLike {
  onOpen(cb: (res?: unknown) => void): void
  onMessage(cb: (res: { data: unknown }) => void): void
  onClose(cb: (res: { code?: number; reason?: string }) => void): void
  onError(cb: (err: { errMsg?: string }) => void): void
  send(opts: { data: string }): void
  close(opts?: { code?: number; reason?: string }): void
}

const DEFAULT_TIMING: Required<RealtimeTiming> = {
  retryBaseMs: 1_000,
  retryMaxMs: 30_000,
  helloTimeoutMs: 8_000,
  idleTimeoutMs: 55_000,
  idleCheckMs: 10_000
}

/** `http://a` → `ws://a`、`https://a` → `wss://a` */
export function toWsUrl(base: string, path: string): string {
  const trimmed = String(base || '').replace(/\/+$/, '')
  if (/^wss?:\/\//i.test(trimmed)) return trimmed + path
  return trimmed.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:') + path
}

/** 退避延迟：指数增长 + ±20% 抖动（抖动是为了避免多端同时重连撞成同步波） */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, rand = Math.random): number {
  const raw = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt)))
  const jitter = raw * 0.2 * (rand() * 2 - 1)
  return Math.max(baseMs / 2, Math.round(raw + jitter))
}

export interface RealtimeController {
  readonly status: RealtimeStatus
  /** 服务端分配的连接 id（推送时用 X-Conn-Id 带上，好让服务端别把通知发回给自己） */
  readonly connId: string
  /** 最近一次失败原因（给人看） */
  readonly lastError: string
  /** 启动（幂等） */
  start(): void
  /** 停止并关闭连接（不再自动重连） */
  stop(): void
  /** 用当前令牌重连（登录 / 登出后调用） */
  restart(): void
  /** 设置想订阅的空间集合（差量下发，幂等） */
  setSpaces(ids: string[]): void
  /** 当前订阅集合 */
  spaces(): string[]
}

export function createRealtime(deps: RealtimeDeps): RealtimeController {
  // 云开发通道下没有自托管的长连接端点（REALTIME_PATH 指向 server/ 的 WS）：
  // 云函数是请求-响应模型，没有服务端主动推送。此时返回一个「disabled」控制器，
  // 让调用方（trip store）零改动即可——它本来就把 disabled 当作合法状态。
  // 一致性不受影响：推送后回拉 + 回到前台 syncAll 仍会收敛（实时本就是加速层）。
  if (hasCloud()) {
    return {
      get status() {
        return 'disabled' as RealtimeStatus
      },
      get connId() {
        return ''
      },
      get lastError() {
        return ''
      },
      start() {},
      stop() {},
      restart() {},
      setSpaces() {},
      spaces() {
        return []
      }
    }
  }

  const timing: Required<RealtimeTiming> = { ...DEFAULT_TIMING, ...(deps.timing || {}) }

  /** 想订阅的空间（即使还没连上也记着，连上后一次性下发） */
  const wanted = new Set<string>()
  /** 已经成功订阅、且服务端明确拒绝过的：不再重试，免得每次重连都撞一遍 */
  const blocked = new Map<string, string>()

  let task: SocketTaskLike | null = null
  let status: RealtimeStatus = 'disabled'
  let connId = ''
  let lastError = ''
  let attempt = 0
  /**
   * 连接代数：每次 connect() 递增。
   *
   * restart / stop 会强拆旧连接，但旧 socket 的 onClose / onError 可能**晚到**
   * （事件循环里排队中的那一批）。回调闭包各自捕获自己的代数，处理事件前先比对：
   * 不校验的话，旧连接的 onDown 会把新连接的 task 引用清掉、再排一次重连 ——
   * 表现为双开连接，两条连接都收同一批推送，界面「每次改动闪两下」。
   */
  let generation = 0
  let stopped = true
  let helloDone = false
  let lastFrameAt = 0
  /**
   * 鉴权被服务端拒绝。
   *
   * 与「网络断了」必须区分开：网络问题要一直退避重连（总会好的），
   * 而鉴权失败是**重连一万次也一样失败** —— 继续重连只是把服务端日志刷满，
   * 用户那边则表现为「一直转圈」。所以置位后停止重连，等登录/登出把它清掉。
   */
  let authFailed = false

  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let helloTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimer: ReturnType<typeof setInterval> | null = null

  function setStatus(next: RealtimeStatus, detail = ''): void {
    status = next
    if (detail) lastError = detail
    deps.onStatus?.(next, detail)
  }

  function clearTimers(): void {
    if (retryTimer) clearTimeout(retryTimer)
    if (helloTimer) clearTimeout(helloTimer)
    if (idleTimer) clearInterval(idleTimer)
    retryTimer = null
    helloTimer = null
    idleTimer = null
  }

  function sendMsg(obj: Record<string, unknown>): boolean {
    if (!task) return false
    try {
      task.send({ data: JSON.stringify(obj) })
      return true
    } catch (e) {
      // 发送失败通常意味着连接已经死了但还没触发 onClose。
      // 这里不主动重连 —— onClose / 空闲看门狗会在几十毫秒内接手，重复触发只会双开连接。
      lastError = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  /** 把想订阅的集合下发：连上之后全量发一次，之后只发增量 */
  function flushSubscriptions(): void {
    if (!helloDone) return
    const ids = [...wanted].filter((id) => !blocked.has(id))
    if (!ids.length) return
    sendMsg({ t: 'sub', ids })
  }

  function onDown(reason: string): void {
    connId = ''
    helloDone = false
    task = null
    if (idleTimer) {
      clearInterval(idleTimer)
      idleTimer = null
    }
    if (helloTimer) {
      clearTimeout(helloTimer)
      helloTimer = null
    }
    if (stopped) {
      setStatus('stopped')
      return
    }
    setStatus('offline', reason)
    scheduleRetry()
  }

  function scheduleRetry(): void {
    if (stopped || retryTimer) return
    // 鉴权被拒就不重连了（见 authFailed 的说明）。等调用方 restart()。
    if (authFailed) {
      setStatus('offline', 'unauthorized')
      return
    }
    const delay = backoffDelay(attempt, timing.retryBaseMs, timing.retryMaxMs)
    attempt += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, delay)
  }

  function handleMessage(raw: unknown): void {
    lastFrameAt = Date.now()
    const text = typeof raw === 'string' ? raw : ''
    if (!text) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(text) as Record<string, unknown>
    } catch {
      return // 服务端发来的东西一律当不可信：解析不了就丢，不能让它把同步链路带崩
    }

    switch (String(msg.t || '')) {
      case 'ready': {
        connId = String(msg.conn || '')
        helloDone = true
        attempt = 0
        authFailed = false
        if (helloTimer) {
          clearTimeout(helloTimer)
          helloTimer = null
        }
        if (idleTimer) clearInterval(idleTimer)
        // 空闲看门狗：对端进程被 kill、NAT 表项超时这类「连接看起来还在、其实已经死了」
        // 的情况下不会触发 onClose。只靠 `onClose` 会一直挂在那里不重连。
        idleTimer = setInterval(() => {
          if (stopped) return
          if (Date.now() - lastFrameAt <= timing.idleTimeoutMs) return
          setStatus('offline', 'idle-timeout')
          forceClose()
          onDown('idle-timeout')
        }, timing.idleCheckMs)
        setStatus('online')
        flushSubscriptions()
        return
      }
      case 'ping':
        sendMsg({ t: 'pong', ts: msg.ts })
        return
      case 'pong':
        return
      case 'subscribed': {
        const accepted = Array.isArray(msg.accepted) ? (msg.accepted as RealtimeSubInfo[]) : []
        const denied = Array.isArray(msg.denied) ? (msg.denied as RealtimeDenied[]) : []
        // 服务端明确拒绝的（不是成员 / id 非法）记下来，之后重连不再白试一遍
        for (const d of denied) if (d?.id) blocked.set(String(d.id), String(d.reason || 'denied'))
        deps.onSubscribed?.(accepted, denied)
        return
      }
      case 'unsubscribed': {
        const ids = Array.isArray(msg.ids) ? (msg.ids as string[]) : []
        const revoked = String(msg.reason || '') === 'access-revoked'
        for (const id of ids) {
          if (revoked) {
            // 权限被收回（典型场景：一个无主行程被别人认领了）。
            // **必须从 wanted 里摘掉**，否则下次重连会再订一次、再被踢一次，
            // 客户端表现为「不停地闪」。
            wanted.delete(String(id))
            blocked.set(String(id), 'access-revoked')
          }
        }
        if (ids.length) {
          deps.onSubscribed?.(
            [],
            ids.map((id) => ({ id: String(id), reason: revoked ? 'access-revoked' : 'unsubscribed' }))
          )
        }
        return
      }
      case 'update': {
        const id = String(msg.id || '')
        if (!id) return
        deps.onUpdate?.({
          id,
          rev: Number(msg.rev) || 0,
          deleted: !!msg.deleted,
          updatedBy: String(msg.updatedBy || ''),
          at: Number(msg.at) || 0
        })
        return
      }
      case 'error': {
        lastError = String(msg.message || 'realtime error')
        // 共享密钥不对时服务端会先回一条 error 再关连接。这类失败重连无意义 ——
        // 与「网络断了」不同，它是配置问题，要让人在界面上看见。
        if (lastError === 'unauthorized') {
          authFailed = true
          forceClose()
          setStatus('offline', 'unauthorized')
        }
        return
      }
      default:
        return
    }
  }

  function forceClose(): void {
    const t = task
    task = null
    try {
      t?.close({ code: 1000, reason: 'client-reset' })
    } catch {
      /* 已经关掉的连接再关会抛，忽略 */
    }
  }

  function connect(): void {
    if (stopped) return
    if (task) return
    setStatus('connecting')
    lastFrameAt = Date.now()

    let next: SocketTaskLike | null = null
    try {
      // ⚠️ 必须显式传 success / fail / complete 这三个回调。
      //
      // uni-app 的 API 有个约定：**不传回调就把接口 Promise 化**，返回值是 Promise
      // 而不是平台的 SocketTask。于是 `next.onOpen` 是 undefined，下面注册监听时抛
      // `TypeError: next.onOpen is not a function`，异常会一路穿出 connect() → start()
      // → startRealtime() → onLaunch，表现为「小程序启动被截断、实时永远停在
      // connecting」，而且**没有任何报错线索**。
      //
      // 只在真机上暴露：H5 与测试里的 mock 都直接返回 SocketTask，所以单测全绿也照样漏。
      // 传了回调之后 uni-app 才把 wx.connectSocket 的 SocketTask 原样返回。
      //
      // 另一件事：刻意**不传 header** —— 会话令牌走首帧 hello，不放 URL 也不依赖自定义头
      // （浏览器 WebSocket 不支持自定义头，依赖它就只能在小程序里生效）。
      next = uni.connectSocket({
        url: deps.url,
        success: () => {},
        fail: () => {},
        complete: () => {}
      }) as unknown as SocketTaskLike
    } catch (e) {
      setStatus('offline', e instanceof Error ? e.message : String(e))
      scheduleRetry()
      return
    }

    // 形状校验：拿到的不是 SocketTask 就立刻报清楚，别让它在下一行炸成「启动被截断」。
    // 值也得对：Promise 化时 hasTask 为真但 onOpen 是 undefined —— 只判空是不够的。
    if (!next || typeof next.onOpen !== 'function') {
      setStatus('offline', 'connectSocket 未返回 SocketTask（uni-app 回调参数缺失？）')
      scheduleRetry()
      return
    }

    // 本轮连接的代数（见 generation 的说明）。必须在注册回调**之前**确定，
    // 让下面四个闭包都捕获同一个值。
    const gen = ++generation
    task = next
    let opened = false

    next.onOpen(() => {
      if (gen !== generation) return // 旧连接的迟到事件：这一代已被 restart/stop 作废
      opened = true
      sendMsg({
        t: 'hello',
        token: deps.token(),
        key: deps.key?.() || '',
        deviceId: deps.deviceId()
      })
      // 服务端要求 authGraceMs 内发 hello；这里只是**客户端侧**兜底，
      // 防止「连接开了但服务端没回 ready」时永久卡在 connecting。
      helloTimer = setTimeout(() => {
        if (helloDone || stopped) return
        lastError = 'hello timeout'
        forceClose()
        onDown('hello-timeout')
      }, timing.helloTimeoutMs)
    })
    next.onMessage((res) => {
      if (gen !== generation) return
      handleMessage(res?.data)
    })
    next.onError((err) => {
      if (gen !== generation) return
      if (stopped) return
      lastError = err?.errMsg || 'socket error'
      // 连都没连上就直接失败：手动推进状态机，不等 onClose
      if (!opened) {
        forceClose()
        onDown(lastError)
      }
    })
    next.onClose((res) => {
      if (gen !== generation) return
      if (stopped) {
        setStatus('stopped')
        return
      }
      if (helloDone || opened) {
        lastError = `closed ${res?.code ?? ''}`.trim()
      }
      onDown(lastError || 'closed')
    })
  }

  return {
    get status() {
      return status
    },
    get connId() {
      return connId
    },
    get lastError() {
      return lastError
    },
    start() {
      // 幂等：已经在连 / 已连上，就都不要再插一脚 ——
      // 重复 connect 会双开连接，两个连接都会收到同一批推送，界面表现为「每次改动闪两下」。
      if (!stopped && (status === 'online' || status === 'connecting')) return
      // 有排定中的重试也立即重连：start 的语义是「现在就要通」（回前台 resume 靠它），
      // 不该等退避计时走完。清掉计时器再连，不会双开 —— 计时器是当时唯一挂起中的动作。
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      stopped = false
      attempt = 0
      authFailed = false
      connect()
    },
    stop() {
      stopped = true
      clearTimers()
      connId = ''
      helloDone = false
      forceClose()
      setStatus('stopped')
    },
    restart() {
      const wasRunning = !stopped
      stopped = true
      clearTimers()
      connId = ''
      helloDone = false
      attempt = 0
      // 登录 / 登出会改变能看到的范围，之前被拒的空间要重新试一次
      blocked.clear()
      authFailed = false
      forceClose()
      if (!wasRunning) {
        setStatus('idle')
        return
      }
      stopped = false
      connect()
    },
    setSpaces(ids) {
      const next = new Set<string>()
      for (const id of ids) if (id) next.add(String(id))
      // 集合没变就什么都不做：这个方法会在每次本地改动后被调用，
      // 每次重发一遍 sub 会让服务端反复走一遍权限判定。
      let changed = next.size !== wanted.size
      if (!changed) {
        for (const id of next) {
          if (!wanted.has(id)) {
            changed = true
            break
          }
        }
      }
      if (!changed) return
      // 移除的差集要**显式退订**：只发 sub 不发 unsub 的话，服务端订阅只增不减，
      // 已 drop 的空间一直占着权限通道，后续 update 元通知还会继续推过来。
      // hello 之前不用发 —— 连上后 flushSubscriptions 全量对齐，服务端没订过的无所谓。
      const removed = [...wanted].filter((id) => !next.has(id))
      // 之前被拒绝过的空间，重新出现在集合里时给它一次机会：
      // 场景是「我凭分享码加进去了，现在应该有权限了」。
      for (const id of next) if (!wanted.has(id)) blocked.delete(id)
      wanted.clear()
      for (const id of next) wanted.add(id)
      if (removed.length && helloDone) sendMsg({ t: 'unsub', ids: removed })
      flushSubscriptions()
    },
    spaces() {
      return [...wanted]
    }
  }
}
