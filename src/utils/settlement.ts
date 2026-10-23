import type {
  Expense,
  Member,
  NetBalance,
  SettlementResult,
  Transfer,
  ExpenseCategory
} from '@/types'
import { CATEGORY_ORDER } from './format'

/** 转成分，规避浮点误差 */
const toCent = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100)
const toYuan = (c: number) => c / 100

/** 超过这个人数就不做零和子集 DP（3^n），直接贪心链 */
const MAX_DP_MEMBERS = 14
const pickMask = new Int32Array(1 << MAX_DP_MEMBERS)

/**
 * 计算一笔账里每个参与者的应付份额（单位：分）
 * 三种模式：均分 / 按权重 / 自定义金额
 */
export function splitAmount(expense: Expense): Map<string, number> {
  const result = new Map<string, number>()
  const total = toCent(expense.amount)
  const parts = expense.participants.filter((p) => p.memberId)

  if (!parts.length) return result

  if (expense.splitMode === 'custom') {
    const sum = parts.reduce((s, p) => s + toCent(p.share), 0)
    if (sum === 0) {
      // 自定义金额全为 0，退化为均分
      return splitEven(total, parts.map((p) => p.memberId))
    }
    if (sum === total) {
      parts.forEach((p) => result.set(p.memberId, toCent(p.share)))
      return result
    }
    // 自定义金额与总额不一致，按比例缩放后再抹平尾差
    const scaled = parts.map((p) => ({
      id: p.memberId,
      cent: Math.round((toCent(p.share) / sum) * total)
    }))
    return flatten(scaled, total)
  }

  if (expense.splitMode === 'weight') {
    const sumW = parts.reduce((s, p) => s + (p.share > 0 ? p.share : 1), 0)
    if (sumW === 0) return splitEven(total, parts.map((p) => p.memberId))
    const scaled = parts.map((p) => ({
      id: p.memberId,
      cent: Math.round(((p.share > 0 ? p.share : 1) / sumW) * total)
    }))
    return flatten(scaled, total)
  }

  return splitEven(total, parts.map((p) => p.memberId))
}

/** 均分，尾差补给前几个人，保证总和精确 */
function splitEven(totalCent: number, ids: string[]): Map<string, number> {
  const map = new Map<string, number>()
  if (!ids.length) return map
  const base = Math.floor(totalCent / ids.length)
  let rest = totalCent - base * ids.length
  ids.forEach((id) => {
    const extra = rest > 0 ? 1 : 0
    if (rest > 0) rest -= 1
    map.set(id, base + extra)
  })
  return map
}

/** 修正舍入尾差，确保份额之和 === 总额 */
function flatten(list: { id: string; cent: number }[], totalCent: number): Map<string, number> {
  const map = new Map<string, number>()
  let sum = 0
  list.forEach((x) => {
    map.set(x.id, x.cent)
    sum += x.cent
  })
  let diff = totalCent - sum
  if (diff !== 0) {
    const sorted = [...list].sort((a, b) => b.cent - a.cent)
    let i = 0
    while (diff !== 0 && sorted.length) {
      const step = diff > 0 ? 1 : -1
      const target = sorted[i % sorted.length]
      map.set(target.id, (map.get(target.id) || 0) + step)
      diff -= step
      i += 1
      if (i > sorted.length * 4) break
    }
  }
  return map
}

/** 计算每个人的净额。正数=应收，负数=应付 */
export function computeBalances(members: Member[], expenses: Expense[]): NetBalance[] {
  const paid = new Map<string, number>()
  const owed = new Map<string, number>()

  members.forEach((m) => {
    paid.set(m.id, 0)
    owed.set(m.id, 0)
  })

  expenses.forEach((e) => {
    if (!e.payerId) return
    paid.set(e.payerId, (paid.get(e.payerId) || 0) + toCent(e.amount))
    const shares = splitAmount(e)
    shares.forEach((cent, memberId) => {
      if (!paid.has(memberId)) return
      owed.set(memberId, (owed.get(memberId) || 0) + cent)
    })
  })

  return members.map((m) => {
    const p = paid.get(m.id) || 0
    const o = owed.get(m.id) || 0
    return {
      memberId: m.id,
      net: toYuan(p - o),
      paid: toYuan(p),
      shouldPay: toYuan(o)
    }
  })
}

/**
 * 贪心配对：把任意债务图压缩到最少转账笔数
 * 每轮让「最大债主」收「最大欠债人」的钱，抵消较小的一方
 */
/**
 * 最少转账：把净额之间的欠款收敛到最少的转账笔数。
 *
 * 之前是纯贪心（双方各排序后顺次对冲），贪心的转账数可能不是最少——
 * 例：净额 [+998, +709, −540, −709, +122, −580]（分）贪心要 5 笔，
 * 但按零和子集拆成 {998, −540, −580, +122} 与 {709, −709} 两组只要 4 笔。
 * 这是 Splitwise「债务简化」的经典问题：转账下限 = 非零人数 − 最多可拆出的
 * 互斥零和子集数。
 *
 * 实现（借鉴 split-pro/spliit 的思路，MIT 正好允许）：
 *  · 位掩码 DP（3^n）求最大零和子集拆分，n ≤ 14 全量求解；
 *  · 每个零和组内 k 人用贪心配对出 k−1 笔（组内已是最优）；
 *  · n > 14（同团就算大家吵翻了也到不了这个规模）或只有两人 → 直接贪心链。
 */
export function minimizeTransfers(balances: NetBalance[]): Transfer[] {
  const nonzero = balances.filter((b) => toCent(b.net) !== 0)
  if (nonzero.length <= 1) return []
  if (nonzero.length > MAX_DP_MEMBERS) return pairMatching(nonzero)

  const cents = nonzero.map((b) => toCent(b.net))
  const n = nonzero.length
  const FULL = (1 << n) - 1

  // sum[mask]：mask 内净额之和（分）。增量计算避免每个 mask 都重扫
  const sum = new Int32Array(1 << n)
  for (let m = 1; m <= FULL; m += 1) {
    const low = m & -m
    sum[m] = sum[m ^ low] + cents[Math.log2(low)]
  }

  // dp[mask]：mask 内最多拆出几个互斥零和子集
  // pick[mask]：拆走的那组子集（0 = 最低位成员不进任何子集，留给残组）
  const dp = new Int8Array(1 << n)
  for (let m = 1; m <= FULL; m += 1) {
    const low = m & -m
    let best = dp[m ^ low]
    let use = 0
    let s = m
    while (s) {
      if (s & low && sum[s] === 0) {
        const cand = dp[m ^ s] + 1
        if (cand > best) {
          best = cand
          use = s
        }
      }
      s = (s - 1) & m
    }
    dp[m] = best
    pickMask[m] = use
  }

  // 重建分区：每组人数 ≥ 2（单人净额 ≠ 0），残组（全体和为零）必 ≥ 2 人
  const masksOf = (mask: number): number[] => {
    const out: number[] = []
    for (let i = mask; i; i &= i - 1) out.push(Math.log2(i & -i))
    return out
  }
  let consumed = 0
  let m = FULL
  const groups: number[][] = []
  while (m) {
    const use = pickMask[m]
    if (use) {
      groups.push(masksOf(use))
      m ^= use
      consumed |= use
    } else {
      m ^= m & -m
    }
  }
  const residual = FULL ^ consumed
  if (residual) groups.push(masksOf(residual))

  const out: Transfer[] = []
  for (const idxs of groups) {
    out.push(...pairMatching(idxs.map((i) => nonzero[i])))
  }
  return out
}

/** 贪心对冲：应收/应付各降序后顺次对冲（组内、降级路径共用） */
function pairMatching(list: NetBalance[]): Transfer[] {
  const creditors = list
    .filter((b) => toCent(b.net) > 0)
    .map((b) => ({ id: b.memberId, cent: toCent(b.net) }))
    .sort((a, b) => b.cent - a.cent)

  const debtors = list
    .filter((b) => toCent(b.net) < 0)
    .map((b) => ({ id: b.memberId, cent: -toCent(b.net) }))
    .sort((a, b) => b.cent - a.cent)

  const transfers: Transfer[] = []
  let i = 0
  let j = 0

  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i]
    const c = creditors[j]
    const amt = Math.min(d.cent, c.cent)

    if (amt > 0) {
      transfers.push({
        fromId: d.id,
        toId: c.id,
        amount: toYuan(amt)
      })
    }

    d.cent -= amt
    c.cent -= amt
    if (d.cent <= 0) i += 1
    if (c.cent <= 0) j += 1
  }

  return transfers
}

/** 完整结算：总额、人均、净额、最少转账、分类汇总 */
export function settle(members: Member[], expenses: Expense[]): SettlementResult {
  const totalCent = expenses.reduce((s, e) => s + toCent(e.amount), 0)
  const total = toYuan(totalCent)
  const balances = computeBalances(members, expenses)

  // 人均 = 参与过任一笔账单的成员均值（没参与的人不该被算进去稀释人均）
  const personCount = balances.filter((b) => b.paid > 0 || b.shouldPay > 0).length || 1
  const perCapita = total / personCount

  const catMap = new Map<ExpenseCategory, number>()
  CATEGORY_ORDER.forEach((c) => catMap.set(c, 0))
  expenses.forEach((e) => {
    catMap.set(e.category, (catMap.get(e.category) || 0) + toCent(e.amount))
  })

  const byCategory = CATEGORY_ORDER.map((c) => ({
    category: c,
    amount: toYuan(catMap.get(c) || 0)
  })).filter((x) => x.amount > 0)

  return {
    total,
    perCapita,
    balances,
    transfers: minimizeTransfers(balances),
    byCategory
  }
}
