/**
 * 实时订阅中心。
 *
 * 职责很窄：记住「哪个连接订阅了哪个空间」，并在空间变化时把通知扇出去。
 * 它**不认识** WebSocket / HTTP / 身份 —— 只认「连接」这个抽象
 * （只要对象有 `id` 和一个 `send(obj)`）。这样它可以被纯粹地单测。
 *
 * ── 推送的是「通知」不是「内容」 ──
 *
 * 服务端只发 `{t:'update', id, rev, ...}`，**不带文档体**。客户端收到后自己去
 * `GET /api/trips/:id` 拉那一个空间。
 *
 * 这不是偷懒，是刻意的：
 *   · 合并逻辑只有一份（已有的 pull → applyServerDoc 逐字段合并），
 *     再在推送里塞一份文档就等于开了第二条合并路径，两边迟早不一致；
 *   · 断线期间错过的消息不需要补偿机制 —— rev 对不上就重拉，天然自愈；
 *   · 大行程（几千条记录）不会因为改一个字段就全量广播。
 * 代价是多一次往返（局域网 ~10ms 量级），对这个场景完全可接受。
 *
 * ── 合并通知（coalesce）──
 *
 * 连续编辑会触发连续推送，每次推送都是一次 HTTP 请求。若每次都立刻广播，
 * 同行的人会收到一串通知然后拉一串（内容几乎相同）的文档。
 * 所以这里按空间攒一个很短的窗口（默认 80ms），窗口内合成**一条**通知，
 * 取最新的 rev。窗口很小是为了不牺牲「实时」的感觉。
 *
 * ── 为什么排除的是「连接」而不是「设备」──
 *
 * 发起推送的那台设备不需要收到自己触发的通知（它已经从推送响应里拿到合并结果了）。
 * 看起来按 `deviceId` 排除更简单，但同一个 `deviceId` 在同一台机器的多个标签页 /
 * 多个页面实例间是共享的（都读同一份本地存储）——
 * 按设备排除会让「我开了两个标签页，另一个不动」，这是个能被用户看见的 bug。
 * 连接 id 是精确的，排除它就只排除了真正发起的那一个。
 */

/** 单条通知的合并窗口 */
const DEFAULT_COALESCE_MS = 80

export function createHub({ log = null, coalesceMs = DEFAULT_COALESCE_MS, maxSubsPerConn = 200 } = {}) {
  /** id -> conn（连接对象只需有 id 与 send） */
  const conns = new Map()
  /** spaceId -> Set<conn> */
  const bySpace = new Map()
  /** spaceId -> { timer, rev, deleted, updatedBy, at, except: Set|null }，合并窗口内累积的通知 */
  const pending = new Map()

  let totalNotified = 0
  let totalCoalesced = 0

  function spaceSet(spaceId) {
    let s = bySpace.get(spaceId)
    if (!s) {
      s = new Set()
      bySpace.set(spaceId, s)
    }
    return s
  }

  /** 登记一个连接 */
  function add(conn) {
    conns.set(conn.id, conn)
  }

  /** 注销连接：连同它的所有订阅一起清掉（否则空间表里会留一堆死连接） */
  function remove(conn) {
    conns.delete(conn.id)
    const subs = conn.subscriptions
    if (subs) {
      for (const spaceId of subs) {
        const set = bySpace.get(spaceId)
        if (!set) continue
        set.delete(conn)
        // 空集合要删掉，否则「没人订阅的空间」会无限累积
        if (set.size === 0) bySpace.delete(spaceId)
      }
      subs.clear()
    }
  }

  /**
   * 订阅。
   * @returns {{ ok: boolean, reason?: string }}
   */
  function subscribe(conn, spaceId) {
    if (!conns.has(conn.id)) return { ok: false, reason: 'unknown-connection' }
    if (!conn.subscriptions) conn.subscriptions = new Set()
    if (conn.subscriptions.has(spaceId)) return { ok: true, reason: 'already' }
    if (conn.subscriptions.size >= maxSubsPerConn) {
      return { ok: false, reason: 'too-many-subscriptions' }
    }
    conn.subscriptions.add(spaceId)
    spaceSet(spaceId).add(conn)
    return { ok: true }
  }

  function unsubscribe(conn, spaceId) {
    if (!conn.subscriptions?.has(spaceId)) return false
    conn.subscriptions.delete(spaceId)
    const set = bySpace.get(spaceId)
    if (set) {
      set.delete(conn)
      if (set.size === 0) bySpace.delete(spaceId)
    }
    return true
  }

  /**
   * 重新审视某空间的订阅者，把不再有资格的踢掉。
   *
   * 为什么需要它：订阅是一次性授权。**授权之后权限变了**（最典型的是
   * `/claim` —— 一个无主空间被人认领，权限模型从「谁知道码谁能写」切换成
   * 「只有成员能写」），已经建立的订阅不会自动失效。于是「认领之前随手订阅过的人」
   * 会继续收到这个空间的变更通知 —— 典型的「授权变更了、会话还留着」缺口。
   *
   * 会在服务端重新判定归属时调用（见 routes/trips.mjs 的 claim）。
   *
   * @param {(conn: object) => boolean} keep 返回 true 表示保留
   * @returns {number} 被踢掉的订阅数
   */
  function dropSubscribers(spaceId, keep) {
    const set = bySpace.get(spaceId)
    if (!set) return 0
    let n = 0
    for (const conn of [...set]) {
      if (keep(conn)) continue
      unsubscribe(conn, spaceId)
      // 明确告诉客户端「你不是被断网了，是没权限了」，否则它会在重连后用同一份
      // 订阅列表再订一次 —— 反复被踢，界面表现为「一直闪烁」。
      try {
        conn.send({ t: 'unsubscribed', ids: [spaceId], reason: 'access-revoked' })
      } catch {
        /* 连接可能已经死了，忽略 */
      }
      n += 1
    }
    return n
  }

  /**
   * 通知某空间发生了变化。
   *
   * @param {string} spaceId
   * @param {{rev:number, deleted?:boolean, updatedBy?:string, at?:number}} info
   * @param {{exceptConnId?: string}} opts  发起这次变化的连接（它不需要收到自己的通知）
   */
  function notify(spaceId, info, opts = {}) {
    const except = opts.exceptConnId ? [opts.exceptConnId] : []
    const cur = pending.get(spaceId)
    if (cur) {
      // 窗口内已有待发通知：合并。rev 取最大（单调递增，取最大即最新）
      cur.rev = Math.max(cur.rev, info.rev)
      cur.deleted = cur.deleted || !!info.deleted
      cur.updatedBy = info.updatedBy || cur.updatedBy
      cur.at = Math.max(cur.at, info.at || 0)
      // except 取**交集**：两次变化分别由 A、B 发起时，A 需要知道 B 的那次、B 需要知道 A 的那次，
      // 所以此时谁都不能排除。只有「窗口内所有变化都来自同一个连接」才真的能排除它。
      //
      // ⚠️ 必须**原地**删元素，不能 `cur.except = newSet`：flush 的闭包捕获的是这个对象，
      // 换引用等于把改动丢在另一个对象上，排除会静默失效（通知照发给发起者，界面闪一下）。
      if (cur.except.size) {
        for (const id of [...cur.except]) if (!except.includes(id)) cur.except.delete(id)
      }
      totalCoalesced += 1
      return
    }

    const entry = {
      rev: info.rev || 0,
      deleted: !!info.deleted,
      updatedBy: info.updatedBy || '',
      at: info.at || Date.now(),
      except: new Set(except),
      timer: null
    }
    entry.timer = setTimeout(() => {
      pending.delete(spaceId)
      flush(spaceId, entry)
    }, coalesceMs)
    // 别让这个定时器拖住进程退出（测试里的 node 会等所有句柄结束）
    entry.timer.unref?.()
    pending.set(spaceId, entry)
  }

  function flush(spaceId, entry) {
    const set = bySpace.get(spaceId)
    if (!set || set.size === 0) return
    let sent = 0
    for (const conn of set) {
      if (entry.except.has(conn.id)) continue
      try {
        conn.send({
          t: 'update',
          id: spaceId,
          rev: entry.rev,
          deleted: entry.deleted,
          updatedBy: entry.updatedBy,
          at: entry.at
        })
        sent += 1
      } catch (err) {
        log?.warn?.('实时通知发送失败', { conn: conn.id, id: spaceId, err: String(err?.message || err) })
      }
    }
    totalNotified += sent
    log?.debug?.('实时通知已扇出', {
      id: spaceId,
      rev: entry.rev,
      subscribers: set.size,
      sent,
      excluded: entry.except.size
    })
  }

  /** 某个连接当前订阅的空间 id 列表（诊断 / 测试用） */
  function subscriptionsOf(conn) {
    return [...(conn.subscriptions || [])]
  }

  /** 当前所有存活连接（心跳巡检用） */
  function connections() {
    return [...conns.values()]
  }

  /** 某空间的订阅者数量（测试用） */
  function subscriberCount(spaceId) {
    return bySpace.get(spaceId)?.size || 0
  }

  function stats() {
    return {
      connections: conns.size,
      spaces: bySpace.size,
      pending: pending.size,
      notified: totalNotified,
      coalesced: totalCoalesced
    }
  }

  /** 关闭：清掉所有挂起的定时器，避免进程退出被拖住 */
  function closeAll() {
    for (const [, entry] of pending) clearTimeout(entry.timer)
    pending.clear()
    for (const conn of conns.values()) conn.subscriptions?.clear()
    conns.clear()
    bySpace.clear()
  }

  return {
    add,
    remove,
    subscribe,
    unsubscribe,
    dropSubscribers,
    notify,
    subscriptionsOf,
    connections,
    subscriberCount,
    stats,
    closeAll,
    coalesceMs
  }
}
