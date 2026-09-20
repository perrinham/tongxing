/**
 * 按 key（一般取客户端 IP）的滑动窗口限流。
 *
 * 零依赖实现，内存态。单实例部署足够；多实例需换成 Redis 之类的共享计数。
 */

export function createRateLimiter({ windowMs = 60_000, max = 300, maxKeys = 8000 } = {}) {
  /** key -> 命中时间戳数组（升序） */
  const hits = new Map()
  let lastSweep = Date.now()

  function sweep(now) {
    if (now - lastSweep < windowMs) return
    lastSweep = now
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => now - t < windowMs)
      if (kept.length) hits.set(k, kept)
      else hits.delete(k)
    }
    // 极端情况下（大量不同 IP）防止内存膨胀：按插入序淘汰最旧 key（Map 迭代序即
    // 插入序），不清零幸存 key —— 全量 clear 会被攻击者周期性洗掉限流记录。
    if (hits.size > maxKeys) {
      for (const k of hits.keys()) {
        if (hits.size <= maxKeys) break
        hits.delete(k)
      }
    }
  }

  return {
    /** 返回 { ok, remaining, limit, retryAfter, reset } */
    check(key, now = Date.now()) {
      sweep(now)
      let arr = hits.get(key)
      if (!arr) {
        arr = []
        hits.set(key, arr)
      }
      while (arr.length && now - arr[0] >= windowMs) arr.shift()

      if (arr.length >= max) {
        const retryAfter = Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000))
        return { ok: false, remaining: 0, limit: max, retryAfter, reset: Math.ceil((arr[0] + windowMs) / 1000) }
      }
      arr.push(now)
      return {
        ok: true,
        remaining: max - arr.length,
        limit: max,
        retryAfter: 0,
        reset: Math.ceil((now + windowMs) / 1000)
      }
    },
    size: () => hits.size
  }
}
