/**
 * 混合逻辑时钟（HLC, Hybrid Logical Clock）。
 *
 * ── 为什么需要它 ──
 *
 * 合并规则是「按记录做 LWW」，比的就是「谁更新」。而在此之前「谁更新」用的是
 * 各设备自己的 `Date.now()`，这有两个真实的坑：
 *
 *   1. **设备时钟偏快的人永远赢**。手机时钟快 5 分钟，他三天前的旧内容也会压过
 *      别人刚改的新内容，而且对方怎么改都改不回来。
 *   2. **因果丢失**。A 改了 → B 看到后又改，但因为 B 的手机慢，B 的改动看起来「更早」，
 *      于是 A 的旧值反而赢了 —— 明明 B 是看到了 A 才改的。
 *
 * HLC 用「物理时间 + 逻辑计数」解决第 2 点：收到别人的时间戳时，本地时钟至少推进到
 * 对方之后，于是因果关系被编码进时间戳里，不再依赖两台机器的钟准不准。
 *
 * 第 1 点 HLC 本身解决不了（它的 t 仍以物理时钟为主），所以额外加一道**上界封顶**：
 * 比较时把超前服务端 `now + maxSkewMs` 的时间戳压到上界，把「时钟快 3 小时」的设备
 * 拉回到 1 分钟量级的偏差。
 *
 * ⚠️ 封顶**只作用于比较，不改写存储**。原因见 capHlc 的注释：改写会让同一条超前记录
 * 每次推送都「看起来变了」，rev 无限增长、所有客户端被迫反复重拉。
 *
 * ── 编码 ──
 *
 * HLC = { t: 毫秒, c: 同毫秒内自增计数, n: 节点 id }
 * 比较顺序：先 t，再 c，最后 n（n 用于同 t 同 c 时定胜负，保证全序）。
 *
 * 这里把三元组编码成**定长字符串**：`TTTTTTTTTTTTTTT-CCCCCC-NNNNNNNN`
 * （t 15 位、c 6 位、n 8 位，全部零填充）。好处是字符串字典序 == 三元组序，
 * 于是 JS 里的 `cmpHlc` 和 SQL 里的 `MAX()` / `>=` 给出完全一致的结果，
 * 不用在 SQL 里手写 `(a.t, a.c, a.n) >= (b.t, b.c, b.n)` 那种三段 OR 判断。
 */

import { createHash } from 'node:crypto'

const T_DIGITS = 15
const C_DIGITS = 6
const NODE_CHARS = 8

const MAX_T = 999_999_999_999_999
const MAX_C = 999_999

/**
 * 老记录的占位节点号。
 *
 * 在 HLC 之前落库的记录只有 `updatedAt`，没有 hlc。给它们补 `{t: updatedAt, c: 0, n: 全零}`，
 * 全零节点在字典序上排最前，语义正好是「同毫秒同计数时，旧格式记录让位给新格式记录」。
 */
export const LEGACY_NODE = '00000000'

/** 把任意节点标识映射成定长的 8 位十六进制，保证比较长度一致 */
export function nodeKey(nodeId) {
  return createHash('sha1')
    .update(String(nodeId ?? ''))
    .digest('hex')
    .slice(0, NODE_CHARS)
}

function normalizeNode(n) {
  const s = String(n ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase()
    .slice(0, NODE_CHARS)
  return s.padEnd(NODE_CHARS, '0')
}

function clampInt(v, min, max) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return min
  return Math.min(Math.max(n, min), max)
}

/** 由纯毫秒时间戳造一个 HLC（用于补老数据） */
export function hlcFromTs(ts) {
  return { t: clampInt(ts, 0, MAX_T), c: 0, n: LEGACY_NODE }
}

/**
 * 归一化任意输入为合法 HLC。
 * @param raw 期望 {t,c,n}；不是对象或没有有限 t 时退回 fallbackTs
 * @param fallbackTs 兜底毫秒时间戳（通常是记录自己的 updatedAt）
 */
export function normHlc(raw, fallbackTs = 0) {
  if (raw && typeof raw === 'object' && Number.isFinite(Number(raw.t))) {
    return {
      t: clampInt(raw.t, 0, MAX_T),
      c: clampInt(raw.c ?? 0, 0, MAX_C),
      n: normalizeNode(raw.n)
    }
  }
  return hlcFromTs(fallbackTs)
}

/** 编码成可比较的定长字符串 */
export function encodeHlc(h) {
  const t = clampInt(h?.t, 0, MAX_T)
  const c = clampInt(h?.c ?? 0, 0, MAX_C)
  return `${String(t).padStart(T_DIGITS, '0')}-${String(c).padStart(C_DIGITS, '0')}-${normalizeNode(h?.n)}`
}

/** 从编码字符串还原 */
export function decodeHlc(key) {
  const m = /^(\d+)-(\d+)-([0-9a-f]{8})$/.exec(String(key ?? ''))
  if (!m) return hlcFromTs(0)
  return { t: Number(m[1]), c: Number(m[2]), n: m[3] }
}

/** 三元组比较：a 晚于 b 返回 1，早于返回 -1，相等返回 0 */
export function cmpHlc(a, b) {
  const x = normHlc(a, 0)
  const y = normHlc(b, 0)
  if (x.t !== y.t) return x.t < y.t ? -1 : 1
  if (x.c !== y.c) return x.c < y.c ? -1 : 1
  if (x.n === y.n) return 0
  return x.n < y.n ? -1 : 1
}

/** a 是否严格晚于 b */
export function hlcAfter(a, b) {
  return cmpHlc(a, b) > 0
}

/** 取较晚的一个 */
export function maxHlc(a, b) {
  return cmpHlc(a, b) >= 0 ? normHlc(a, 0) : normHlc(b, 0)
}

/** HLC 对应的物理毫秒（用于展示 / 调试，不参与比较） */
export function hlcTimeOf(h) {
  return clampInt(h?.t, 0, MAX_T)
}

/**
 * 记录级时间戳：客户端带来的 hlc 与记录自己的 `updatedAt` **取较晚者**。
 *
 * ── 为什么需要这道兜底 ──
 *
 * 客户端可能手里攥着一个**从云端带回来的陈旧 hlc**：applyServerDoc 把服务端下发的
 * `doc.trip`（含 hlc 字段）整条存进本地，之后本地编辑只更新了 `updatedAt`、没动 hlc。
 * 此时若直接采信 raw.hlc，比较结果既不是「更新」也不是「冲突」，
 * 编辑会被**静默丢弃** —— 现象是 `applied.conflicts === 0` 且内容纹丝不动，
 * 排查时极具迷惑性（隔离复现能过、真实客户端流程过不了）。
 *
 * 取较晚者则两边都不吃亏：陈旧 hlc 不再越权，真实的后改也不会被吃掉。
 * `hlcFromTs` 用的是 LEGACY_NODE（字典序最小），所以同 t 时它一定让位于真 HLC，
 * 不会凭空赢过一条合法的同刻记录。
 *
 * ⚠️ 这个函数**只读不写**，返回的是比较用的值，绝不回写存储 —— 回写会破坏幂等性，
 * 理由见 capHlc 的注释。
 *
 * @param raw        客户端提交的 hlc（可能缺失 / 可能陈旧）
 * @param updatedAt  记录自己的修改时间
 */
export function recordHlc(raw, updatedAt) {
  return maxHlc(normHlc(raw, updatedAt), hlcFromTs(updatedAt))
}

/**
 * 按允许偏差给 HLC 封顶（纯函数，只用于比较）。
 *
 * 针对「设备时钟快几小时」：这类设备的时间戳永远压过别人，而且是**不可恢复**的 ——
 * 别人怎么改都赢不回来。封顶之后它的排序权重最多到 `now + skewMs`，
 * 剩下的偏差在 1 分钟量级，正常时钟很快就能追上并超过它。
 *
 * 只压 `t`、**保留 `c` 与 `n`**：这样两条都超前的并发记录仍有明确先后
 * （同 t 时比 c，再比 n），而不是塌成同一个值导致「后改的赢不了」。
 *
 * ⚠️ 为什么只改比较、不把封顶结果写进存储：
 *
 *   封顶值依赖 `now`，而 `now` 每次请求都在变。如果把封顶后的值存下来，
 *   同一条超前记录每次推送都会被封到一个**更大的**值，服务端每次都判定
 *   「有变化」→ rev 单调上涨 → 所有客户端被迫反复全量拉取，
 *   幂等性（重复推同一份数据应当 changed:false）直接失效。
 *
 *   保持原值存储 + 比较时封顶，则「同一输入 ⇒ 同一判定」，幂等性成立。
 *   代价是库里存着一个不可信的时间戳 —— 但它只是一个排序用的数字，
 *   真正的「谁更新」由封顶后的比较结果决定，不再由它单独说了算。
 */
export function capHlc(h, now, skewMs) {
  const x = normHlc(h, 0)
  const upper = now + skewMs
  if (x.t <= upper) return x
  return { t: upper, c: x.c, n: x.n }
}

/**
 * 服务端 HLC 实例。
 *
 * @param node        节点标识（多实例部署时应各不相同，会 hash 成 8 位）
 * @param maxSkewMs   允许客户端时间戳超前服务端的上限，超出即夹紧
 */
export function createHlc({ node = 'server', maxSkewMs = 60_000 } = {}) {
  const selfNode = nodeKey(node)
  let lastT = 0
  let lastC = 0

  /** 按当前时刻封顶（只用于比较，不改写任何数据） */
  function cap(h) {
    return capHlc(h, Date.now(), maxSkewMs)
  }

  /**
   * 收下客户端时间戳：判断是否明显超前，并**推进本节点时钟**。
   *
   * 注意这里不再改写传入的时间戳 —— 这是刻意的，见 capHlc 的注释（改写会破坏幂等）。
   * 但必须推进 (lastT, lastC)：否则随后 stamp() 出来的戳可能只因为节点号小
   * 就输给客户端记录，典型后果是「服务端删了行程」被判成「删后又改」，删除传播不出去。
   *
   * @returns {{skewed: boolean}} 是否明显超前（回给客户端，便于提示「设备时间可能不准」）
   */
  function observe(raw, fallbackTs = 0) {
    const h = normHlc(raw, fallbackTs)
    const upper = Date.now() + maxSkewMs
    const skewed = h.t > upper
    const t = skewed ? upper : h.t
    if (t > lastT) {
      lastT = t
      lastC = h.c
    } else if (t === lastT && h.c > lastC) {
      lastC = h.c
    }
    return { skewed }
  }

  /** 本节点自己产生变更（例如 DELETE）时取下一个时间戳，保证晚于所有已接受记录 */
  function stamp() {
    const phys = Date.now()
    if (phys > lastT) {
      lastT = phys
      lastC = 0
    } else {
      lastC += 1
      if (lastC > MAX_C) {
        lastT += 1
        lastC = 0
      }
    }
    return { t: lastT, c: lastC, n: selfNode }
  }

  return {
    node: selfNode,
    maxSkewMs,
    cap,
    observe,
    stamp,
    peek: () => ({ t: lastT, c: lastC, n: selfNode })
  }
}
