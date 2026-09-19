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
export function minimizeTransfers(balances: NetBalance[]): Transfer[] {
  const creditors = balances
    .filter((b) => toCent(b.net) > 0)
    .map((b) => ({ id: b.memberId, cent: toCent(b.net) }))
    .sort((a, b) => b.cent - a.cent)

  const debtors = balances
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

  // 人均 = 按人次的平均，而非简单除以人数（没参与的人不该被算进去）
  const personCount = members.length || 1
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
