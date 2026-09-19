/**
 * 客户端 HLC（混合逻辑时钟）。
 *
 * ── 为什么客户端也要有 ──
 *
 * 合并规则是「按记录比 LWW」，如果客户端只写 `Date.now()`，那服务端再聪明也只能
 * 拿到一个不可信的物理时间。客户端必须自己维护 HLC，才能表达出**因果关系**：
 *
 *   收到别人的改动时把本地时钟推进到对方之后（observe），
 *   于是「我看到了 A 才改的」这件事被编码进时间戳本身 ——
 *   哪怕我的手机慢 10 分钟，我的改动也一定排在 A 之后。
 *
 * 这是纯物理时钟给不了的能力，也是 Step 2 的意义所在。
 *
 * ⚠️ 这里踩过的坑（务必保留）：
 *
 *   此前 `stamp()` 只更新 `updatedAt`、不动 `hlc`，而 `applyServerDoc` 又把服务端下发的
 *   `doc.trip`（**含 hlc 字段**）整条存进本地。于是编辑后再推送，服务端 `normHlc(raw.hlc,
 *   updatedAt)` 优先采信了那个**从云端带回来的陈旧 hlc**，比较结果既不算更新也不算冲突，
 *   编辑被**静默丢弃**（`applied.conflicts === 0`，标题不变）。
 *
 *   修法是两手：客户端 stamp 时同时写 hlc（本文件），服务端再拿 `recordHlc()`
 *   取 max(hlc, updatedAt) 兜底 —— 老客户端 / 老记录也不会再被吞。
 *
 * ── 与服务端的一致性 ──
 *
 * 编码格式必须与 `server/lib/hlc.mjs` **逐字节一致**，否则两端对「谁更新」的判断会分叉。
 * 那边用 `node:crypto` 的 sha1 生成节点号；小程序里拿不到 crypto，
 * 这里用 Math.random 生成后持久化。节点号只用于「同刻同计数」时定序的兜底，不承载语义。
 *
 * `encodeHlc` 的输出长度/样式由 tests 双侧对齐（见 scripts/client-sync-test.mjs 的字面量断言）。
 */

import type { Hlc } from '@/types'

export type { Hlc }

const T_DIGITS = 15
const C_DIGITS = 6
const NODE_CHARS = 8

const MAX_T = 999_999_999_999_999
const MAX_C = 999_999

/**
 * 老记录的占位节点号。
 *
 * 在 HLC 之前落库的记录只有 `updatedAt`、没有 hlc。给它们补 `{t: updatedAt, c: 0, n: 全零}`，
 * 全零在字典序上最小，语义正好是「同刻同计数时，旧格式记录让位给新格式记录」。
 * 必须与服务端 `LEGACY_NODE` 取值相同。
 */
export const LEGACY_NODE = '00000000'

function clampInt(v: unknown, min: number, max: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return min
  return Math.min(Math.max(n, min), max)
}

function normalizeNode(n: unknown): string {
  const s = String(n ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase()
    .slice(0, NODE_CHARS)
  return s.padEnd(NODE_CHARS, '0')
}

/** 由纯毫秒时间戳造一个 HLC（用于补老数据 / 兜底） */
export function hlcFromTs(ts: unknown): Hlc {
  return { t: clampInt(ts, 0, MAX_T), c: 0, n: LEGACY_NODE }
}

/**
 * 归一化任意输入为合法 HLC。
 * @param raw 期望 {t,c,n}；不是对象或没有有限 t 时退回 fallbackTs
 * @param fallbackTs 兜底毫秒时间戳（通常是记录自己的 updatedAt）
 */
export function normHlc(raw: unknown, fallbackTs: unknown = 0): Hlc {
  const r = raw as Partial<Hlc> | null | undefined
  if (r && typeof r === 'object' && Number.isFinite(Number(r.t))) {
    return {
      t: clampInt(r.t, 0, MAX_T),
      c: clampInt(r.c ?? 0, 0, MAX_C),
      n: normalizeNode(r.n)
    }
  }
  return hlcFromTs(fallbackTs)
}

/** 三元组比较：a 晚于 b 返回 1，早于返回 -1，相等返回 0 */
export function cmpHlc(a: unknown, b: unknown): number {
  const x = normHlc(a, 0)
  const y = normHlc(b, 0)
  if (x.t !== y.t) return x.t < y.t ? -1 : 1
  if (x.c !== y.c) return x.c < y.c ? -1 : 1
  if (x.n === y.n) return 0
  return x.n < y.n ? -1 : 1
}

/** a 是否严格晚于 b */
export function hlcAfter(a: unknown, b: unknown): boolean {
  return cmpHlc(a, b) > 0
}

/** 取较晚的一个 */
export function maxHlc(a: unknown, b: unknown): Hlc {
  return cmpHlc(a, b) >= 0 ? normHlc(a, 0) : normHlc(b, 0)
}

/**
 * 记录级时间戳：客户端带来的 hlc 与记录自己的 updatedAt **取较晚者**。
 *
 * 这是防「编辑被静默吞掉」的那道兜底 —— 客户端手里可能攥着一个从云端带回来的陈旧 hlc，
 * 而 updatedAt 才是它真正想表达的「我什么时候改的」。取较晚者，
 * 既不吃掉真实的后改，也不让陈旧 hlc 越权。
 *
 * 与服务端 `hlc.mjs` 的 `recordHlc` 语义完全一致。
 */
export function recordHlc(raw: unknown, updatedAt: unknown): Hlc {
  return maxHlc(normHlc(raw, updatedAt), hlcFromTs(updatedAt))
}

/** 编码成定长字符串：`TTTTTTTTTTTTTTT-CCCCCC-NNNNNNNN`（字典序 == 三元组序） */
export function encodeHlc(h: unknown): string {
  const x = normHlc(h, 0)
  return `${String(x.t).padStart(T_DIGITS, '0')}-${String(x.c).padStart(C_DIGITS, '0')}-${x.n}`
}

/** HLC 对应的物理毫秒（用于展示 / 推导 updatedAt，不参与比较） */
export function hlcTimeOf(h: unknown): number {
  return normHlc(h, 0).t
}

/** 生成一个节点号（首次使用时生成一次，然后持久化 —— 不要每次启动都换） */
export function newHlcNode(): string {
  let s = ''
  for (let i = 0; i < NODE_CHARS; i += 1) {
    s += Math.floor(Math.random() * 16).toString(16)
  }
  return normalizeNode(s)
}

/** 需要持久化的 HLC 状态 */
export type HlcState = Hlc

/**
 * 按允许偏差给 HLC 封顶（纯函数，只用于比较 / 收下别家的戳）。
 *
 * 与 `server/lib/hlc.mjs` 的 `capHlc` 逐字一致：**只压 `t`，保留 `c` 与 `n`**。
 * 若把整个三元组塌成同一个上界值，两条都超前的记录就无法分先后
 * （「后改的赢不了」），所以必须留住 c/n 作为同一上界内的定序依据。
 */
export function capHlc(h: unknown, now: number, skewMs: number): Hlc {
  const x = normHlc(h, 0)
  const upper = now + skewMs
  if (x.t <= upper) return x
  return { t: upper, c: x.c, n: x.n }
}

/**
 * 客户端 HLC 实例。
 *
 * `state` 必须持久化（存进 SyncMeta），否则每次冷启动都从 `lastT = 0` 起步：
 * 手机时钟若落后于「上次见过的服务端时间戳」，冷启动后的第一次编辑会拿到一个
 * **更小**的 hlc，因果关系当场断裂，编辑推上去会被判成落后。
 *
 * @param opts.state      上次持久化的状态（缺失则从当前时间起步）
 * @param opts.save       状态变化时的回写钩子（同步调用，不要在里面做异步活）
 * @param opts.maxSkewMs  允许别家戳超前本机的上限，超出即封顶（默认 60s，与服务端一致）
 * @param opts.now        取当前物理毫秒，测试可注入
 */
export function createHlc(opts: {
  state?: Partial<HlcState> | null
  save?: (s: HlcState) => void
  maxSkewMs?: number
  now?: () => number
} = {}) {
  const now = opts.now ?? (() => Date.now())
  const maxSkewMs = opts.maxSkewMs ?? 60_000
  const prev = opts.state
  const selfNode = normalizeNode(prev?.n) === LEGACY_NODE ? newHlcNode() : normalizeNode(prev?.n)

  let lastT = clampInt(prev?.t, 0, MAX_T)
  let lastC = clampInt(prev?.c ?? 0, 0, MAX_C)

  function flush() {
    opts.save?.({ t: lastT, c: lastC, n: selfNode })
  }

  /**
   * 收下外部（服务端 / 别台设备）的时间戳，把本地时钟推到**不早于**对方。
   *
   * 两件事必须同时成立：
   *   1. **推进**——「见过就不能再往回走」，这是因果性的全部来源。
   *   2. **封顶**——收下之前先按 `now + maxSkewMs` 压一道。
   *
   * 第 2 点容易被忽略：服务端返回的是**原样入库的原始戳**（未封顶，见 capHlc 的注释），
   * 若客户端直接照单全收，一台「时钟快 3 小时」的同伴就能把本机逻辑时钟一把拽到 3 小时后，
   * 而且此后 3 小时内本机所有编辑都带着虚高的戳。封顶之后，坏钟的影响被限制在 1 分钟量级。
   */
  function observe(raw: unknown, fallbackTs: unknown = 0): Hlc {
    const h = capHlc(normHlc(raw, fallbackTs), now(), maxSkewMs)
    let changed = false
    if (h.t > lastT) {
      lastT = h.t
      lastC = h.c
      changed = true
    } else if (h.t === lastT && h.c > lastC) {
      lastC = h.c
      changed = true
    }
    if (changed) flush()
    return h
  }

  /** 本机产生一次变更，取下一个时间戳（严格晚于所有已见过的戳） */
  function stamp(): Hlc {
    const phys = now()
    if (phys > lastT) {
      lastT = phys
      lastC = 0
    } else {
      // 物理时钟没往前走（同毫秒，或本机钟比逻辑时钟慢）→ 靠计数递增保持全序
      lastC += 1
      if (lastC > MAX_C) {
        lastT += 1
        lastC = 0
      }
    }
    flush()
    return { t: lastT, c: lastC, n: selfNode }
  }

  // 刻意不提供 stampAll 这类「顺手把记录一起写了」的便捷方法：
  // 它必须决定 `updatedAt` 到底写物理时间还是写 hlc.t，而这个选择
  // store 的 stamp() 已经定了（写物理时间，hlc.t 另存）。两处各写一套必然发散。
  return {
    node: selfNode,
    observe,
    stamp,
    peek: (): HlcState => ({ t: lastT, c: lastC, n: selfNode })
  }
}
