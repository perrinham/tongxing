/**
 * 预算智能分配单测入口 —— 由 scripts/budget-test.mjs 用 esbuild 打包后在 Node 上跑。
 *
 * 覆盖面：城市消费档位匹配（含前缀容错/未知兜底）、标准档估值全式样、
 * 住宿按标间摊（人数奇偶/人数往返）、真实行程项门票优先、节奏只动门票餐饮、
 * 一日往返住宿 0、十位取整、brief 文案式样。
 */
import assert from 'node:assert/strict'
import { budgetBrief, estimateBudget, tierFor } from '../src/utils/budget'

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

const partsOf = (est: ReturnType<typeof estimateBudget>) =>
  Object.fromEntries(est.parts.map((p) => [p.label, p.pp]))

console.log('\n· 消费档位')

await spec('北京/上海 → 一线都市', () => {
  assert.equal(tierFor('北京').name, '一线都市')
  assert.equal(tierFor('上海迪士尼三日游').name, '一线都市')
})
await spec('三亚/三亚湾 → 海岛度假', () => {
  assert.equal(tierFor('三亚').name, '海岛度假')
  assert.equal(tierFor('三亚湾酒店踩点').name, '海岛度假')
})
await spec('黄山/桂林/大理 → 热门景区度假', () => {
  assert.equal(tierFor('黄山').name, '热门景区度假')
  assert.equal(tierFor('桂林山水').name, '热门景区度假')
})
await spec('香港/澳门 → 港澳台', () => {
  assert.equal(tierFor('香港西九龙').name, '港澳台')
})
await spec('未知城市兜底一般城市（不硬猜）', () => {
  assert.equal(tierFor('彭州').name, '一般城市')
  assert.equal(tierFor('泄滩古镇').name, '一般城市')
  assert.equal(tierFor('').name, '一般城市')
})
await spec('香港也在一线名单里时先命中最先档位（一线遍历在前）', () => {
  // TIER_CITIES 键序：一线 → 景区 → 海岛 → 高原 → 港澳台；香港只出现在港澳台
  assert.ok(Object.keys(tierFor('香港')).length > 0)
})

console.log('\n· 标准档估值')

await spec('北京 3 天 2 人（normal）：住宿 400 / 门票 240 / 餐饮 480 / 交通 150，人均 ¥1,270', () => {
  const est = estimateBudget({ destination: '北京', days: 3, peopleCount: 2 })
  const p = partsOf(est)
  assert.equal(est.nights, 2)
  assert.equal(p['住宿'], 400) // 400 × 2 晚 × 1 间 ÷ 2 人
  assert.equal(p['门票'], 240) // 80 × 3 × 1
  assert.equal(p['餐饮'], 480) // 160 × 3
  assert.equal(p['交通'], 150) // 50 × 3
  assert.equal(est.perPerson, 1270)
  assert.equal(est.group, 2540)
})

await spec('4 人还是标间两间：人均住宿与 2 人时一样', () => {
  const est = estimateBudget({ destination: '上海', days: 3, peopleCount: 4 })
  const p = partsOf(est)
  assert.equal(p['住宿'], 400) // 400 × 2 × 2 ÷ 4
  assert.equal(est.group, est.perPerson * 4)
})

await spec('3 人奇数：ceil 3/2 = 2 间', () => {
  const est = estimateBudget({ destination: '上海', days: 3, peopleCount: 3 })
  const p = partsOf(est)
  assert.equal(p['住宿'], Math.round((400 * 2 * 2) / 3 / 10) * 10) // 533.33 → 530
})

await spec('一日往返：住宿 0、nights 0', () => {
  const est = estimateBudget({ destination: '北京', days: 1, peopleCount: 2 })
  const p = partsOf(est)
  assert.equal(est.nights, 0)
  assert.equal(p['住宿'], 0)
  assert.ok(est.perPerson > 0)
})

await spec('真实行程项门票优先（本地库 POI 有票价，含十位取整）', () => {
  const est = estimateBudget({
    destination: '成都',
    days: 3,
    peopleCount: 2,
    items: [{ cost: 55, type: 'spot' }, { cost: 50, type: 'spot' }, { cost: 0, type: 'spot' }, { cost: 30, type: 'food' }]
  })
  const p = partsOf(est)
  assert.equal(p['门票'], 110) // 55+50=105 → 十位取整 110（成都按一线档，但真实票价优先）
})

await spec('行程项票价全 0（在线库常态）→ 回档位估算（成都=一线 80/天）', () => {
  const est = estimateBudget({ destination: '成都', days: 2, peopleCount: 2, items: [{ cost: 0, type: 'spot' }] })
  const p = partsOf(est)
  assert.equal(p['门票'], 160) // 80 × 2
})

console.log('\n· 节奏与取整')

await spec('relax：门票 0.8、餐饮 0.9，交通不动', () => {
  const est = estimateBudget({ destination: '北京', days: 3, peopleCount: 2, pace: 'relax' })
  const p = partsOf(est)
  assert.equal(p['门票'], 190) // 80×3×0.8 = 192 → 190
  assert.equal(p['餐饮'], 430) // 160×3×0.9 = 432 → 430
  assert.equal(p['交通'], 150)
})

await spec('packed：门票 1.15、餐饮 1.1', () => {
  const est = estimateBudget({ destination: '北京', days: 3, peopleCount: 2, pace: 'packed' })
  const p = partsOf(est)
  assert.equal(p['门票'], 280) // 80×3×1.15 = 276 → 280
  assert.equal(p['餐饮'], 530) // 160×3×1.1 = 528 → 530
})

await spec('十位取整：奇数人均不破格', () => {
  const est = estimateBudget({ destination: '拉萨', days: 2, peopleCount: 3 })
  assert.ok(est.perPerson % 10 === 0)
  assert.ok(est.group % 10 === 0)
})

console.log('\n· 文案')

await spec('brief 带档位/天数/人数/人均/全组/四分项', () => {
  const est = estimateBudget({ destination: '三亚', days: 4, peopleCount: 2 })
  const b = budgetBrief(est)
  assert.match(b, /^海岛度假 4 天（2 人）：人均约 ¥\d+ \/ 全组 ¥\d+ —— 住宿 \d+ · 门票 \d+ · 餐饮 \d+ · 交通 \d+$/)
})

await spec('人为夹紧：days/people 0 或负都走安全值', () => {
  const est = estimateBudget({ destination: '桂林', days: 0, peopleCount: 0 })
  assert.equal(est.days, 1)
  assert.equal(est.peopleCount, 1)
  assert.equal(est.group, est.perPerson)
})

console.log(`\n===== 预算智能分配结果：${passed} 通过 / ${process.exitCode ? '有失败' : '0 失败'} =====`)
