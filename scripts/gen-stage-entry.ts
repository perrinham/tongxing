/**
 * 行程生成「阶段播报」（流式渐显锚点）单测入口 —— 由 scripts/gen-stage-test.mjs 打包执行。
 *
 * 只喂本地库城市（同步、不触网）：断言阶段顺序、载荷语义，以及播报不改变生成结果。
 */
import assert from 'node:assert/strict'
import { generateItinerary, type GenStage, type GenStageInfo } from '../src/utils/itinerary'

let passed = 0
const failures: string[] = []

async function spec(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(name)
    console.log(`  ✗ ${name}`)
    console.log(`    ${e instanceof Error ? e.message : e}`)
  }
}

const input = {
  destination: '成都',
  startDate: '2026-10-01',
  endDate: '2026-10-03',
  peopleCount: 2,
  prefs: ['food', 'history'],
  pace: 'normal' as const
}

console.log('\n· 阶段播报')

await spec('阶段顺序：score → plan → timeline（无 fetch，本地库不触网）', () => {
  const codes: GenStage[] = []
  generateItinerary(input, (stage) => codes.push(stage))
  assert.deepEqual(codes, ['score', 'plan', 'timeline'])
})

await spec('载荷语义：score=候选数、plan=天数、timeline=安排数（与产物一致）', () => {
  const info: Partial<Record<GenStage, GenStageInfo>> = {}
  const out = generateItinerary(input, (stage, i) => (info[stage] = i))
  assert.ok((info.score?.count ?? 0) > 0, 'score.count > 0')
  assert.equal(info.plan?.days, 3, 'plan.days = 天数')
  assert.ok(info.score && info.plan && info.timeline)
  assert.equal(info.timeline?.count, out.items.length, 'timeline.count = 行程项数')
})

await spec('无播报回调的调用照常返回（可选参数向后兼容）', () => {
  const out = generateItinerary(input)
  assert.ok(out.items.length > 0 && out.summary.length > 0)
})

await spec('播报回调不改变生成结果（同一输入两次，产物逐字段一致）', () => {
  const a = generateItinerary(input)
  const b = generateItinerary(input, () => {})
  // uid 每次都从头造新 id —— 只比结构与内容，比 id
  assert.equal(a.days.length, b.days.length)
  assert.equal(a.items.length, b.items.length)
  assert.equal(a.summary, b.summary)
  assert.deepEqual(
    a.items.map((i) => [i.title, i.type, i.order]),
    b.items.map((i) => [i.title, i.type, i.order])
  )
})

await spec('天数夹紧仍生效（1 天行程也播 plan）', () => {
  const codes: GenStage[] = []
  const out = generateItinerary({ ...input, endDate: '2026-10-01' }, (s) => codes.push(s))
  assert.deepEqual(codes, ['score', 'plan', 'timeline'])
  assert.equal(out.days.length, 1)
})

console.log(`\n===== 阶段播报结果：${passed} 通过 / ${failures.length} 失败 =====`)
if (failures.length) {
  console.error('失败用例：', failures.join('；'))
  process.exitCode = 1
}
