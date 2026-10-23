/**
 * 结算算法单测入口 —— 由 scripts/settle-test.mjs 用 esbuild 打包后在 Node 上跑。
 *
 * 覆盖面：零和子集分解的「最优转账数」（贪心会多转的实锤反例）、转账后的
 * 净额完全配平、零额成员不出场、中间零额不动、人数超限降级贪心、
 * 正常小团体结果与贪心一样好不劣化、金额分位精确。
 */
import assert from 'node:assert/strict'
import { computeBalances, minimizeTransfers } from '../src/utils/settlement'
import type { Member, NetBalance } from '../src/types'

let passed = 0
async function spec(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e instanceof Error ? e.message : e}`)
    process.exitCode = 1
  }
}

const nb = (id: string, net: number): NetBalance => ({
  memberId: id,
  net,
  paid: 0,
  shouldPay: 0
})

/** 转账能否把净额清零：模拟执行并对整数分断言（应收为正：收款即减、付款即加） */
function applyTransfers(nets: NetBalance[], transfers: ReturnType<typeof minimizeTransfers>): void {
  const cent = new Map<string, number>(nets.map((n) => [n.memberId, Math.round(n.net * 100)]))
  transfers.forEach((t) => {
    cent.set(t.fromId, (cent.get(t.fromId) || 0) + Math.round(t.amount * 100))
    cent.set(t.toId, (cent.get(t.toId) || 0) - Math.round(t.amount * 100))
  })
  cent.forEach((v, id) => {
    assert.equal(v, 0, `${id} 未配平（余 ${v} 分）`)
  })
}

console.log('\n· 最优转账数')

await spec('实锤反例：[+9.98,+7.09,−5.40,−7.09,+1.22,−5.80]（元）贪心 5 笔 → 最优 4 笔', () => {
  const nets = [
    nb('a', 9.98), nb('b', 7.09), nb('c', -5.40), nb('d', -7.09), nb('e', 1.22), nb('f', -5.80)
  ]
  const tr = minimizeTransfers(nets)
  assert.equal(tr.length, 4)
  applyTransfers(nets, tr)
})

await spec('两个零和组：{+10,−6,−4} 与 {+7,+3,−5,−5} → 2+3 = 5 笔', () => {
  const nets = [
    nb('a', 10), nb('b', -6), nb('c', -4), nb('d', 7), nb('e', 3), nb('f', -5), nb('g', -5)
  ]
  const tr = minimizeTransfers(nets)
  assert.equal(tr.length, 5)
  applyTransfers(nets, tr)
})

await spec('单人零额不出场；两人一趟打平', () => {
  const tr = minimizeTransfers([nb('z', 0), nb('a', 50), nb('b', -50)])
  assert.equal(tr.length, 1)
  assert.equal(tr[0].amount, 50)
  applyTransfers([nb('a', 50), nb('b', -50)], tr)
})

await spec('中间零额（净 0.00 的成员）不参与转账', () => {
  const tr = minimizeTransfers([nb('a', 30), nb('b', -10), nb('c', -20), nb('z', 0)])
  assert.ok(tr.every((t) => t.fromId !== 'z' && t.toId !== 'z'))
})

await spec('分位精确：3 人均摊尾差走分', () => {
  const m: Member[] = [
    { id: 'a', tripId: 't', name: 'A', colorIndex: 0, weight: 1 },
    { id: 'b', tripId: 't', name: 'B', colorIndex: 1, weight: 1 },
    { id: 'c', tripId: 't', name: 'C', colorIndex: 2, weight: 1 }
  ]
  const expenses = [
    {
      id: 'e1', tripId: 't', title: '午饭', amount: 10, category: 'food' as const,
      payerId: 'a', splitMode: 'even' as const, date: '2026-01-01',
      participants: [
        { memberId: 'a', share: 1 }, { memberId: 'b', share: 1 }, { memberId: 'c', share: 1 }
      ],
      note: '', createdAt: 0
    }
  ]
  const balances = computeBalances(m, expenses)
  const tr = minimizeTransfers(balances)
  assert.ok(tr.length >= 1 && tr.length <= 2)
  applyTransfers(balances, tr)
  // 总转账额 = A 之外两人应付之和（分位精确）：10 元 − 3.34（A 自付）= 6.66
  const totalMoved = tr.reduce((s, t) => s + Math.round(t.amount * 100), 0)
  assert.equal(totalMoved, 666)
})

await spec('正常小团体不劣化（≤ 人-1 笔上限）', () => {
  const nets = [nb('a', 250), nb('b', 50), nb('c', -175), nb('d', -125)]
  const tr = minimizeTransfers(nets)
  assert.ok(tr.length <= 3)
  applyTransfers(nets, tr)
})

await spec('人数超限（>14 非零）降级贪心链，仍配平', () => {
  const nets = Array.from({ length: 16 }, (_, i) => nb(`m${i}`, (i % 2 === 0 ? 300 : -300)))
  const tr = minimizeTransfers(nets)
  assert.ok(tr.length <= 15)
  applyTransfers(nets, tr)
})

await spec('全零净额 → 无转账', () => {
  assert.equal(minimizeTransfers([nb('a', 0), nb('b', 0)]).length, 0)
})

console.log(`\n===== 结算算法结果：${passed} 通过 / ${process.exitCode ? '有失败' : '0 失败'} =====`)
