/**
 * 行李清单生成器单测入口 —— 由 scripts/packing-test.mjs 用 esbuild 打包后在 Node 上跑。
 *
 * 覆盖面：天数折算衣物件数、季节/温度分支、目的地关键词（港澳/海岛）、
 * 交通与住宿信号、分组顺序连续、条数上限与输入夹紧。
 */
import assert from 'node:assert/strict'
import { buildPackingList, PACKING_GROUPS, PACKING_MAX_ITEMS, packGroupLabel } from '../src/utils/packing'

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

const titlesOf = (list: ReturnType<typeof buildPackingList>) => list.map((i) => i.title)
const groupsOf = (list: ReturnType<typeof buildPackingList>) => list.map((i) => i.group)

console.log('\n· 生成规则')

await spec('基础：身份证/洗护/电子兜底在场，天数驱动衣物件数', () => {
  const out = buildPackingList({ destination: '成都', days: 3, startDate: '2026-10-01' })
  const t = titlesOf(out)
  assert.ok(t.includes('身份证'), '身份证')
  assert.ok(t.includes('牙刷牙膏'), '洗护')
  assert.ok(t.includes('充电宝（≤2万毫安）'), '充电宝')
  assert.ok(t.some((x) => x.startsWith('内衣裤')), JSON.stringify(t))
  assert.ok(t.includes('外套 1 件'), '秋温 ≤16 → 外套')
})

await spec('冬春季厚外套+围巾，夏季短袖+防晒+驱蚊', () => {
  const winter = buildPackingList({ destination: '成都', days: 4, startDate: '2026-12-05' })
  assert.ok(titlesOf(winter).includes('羽绒服 / 厚外套'), '冬 → 厚外套')
  assert.ok(titlesOf(winter).includes('围巾手套'), '冬 → 围巾手套')
  assert.ok(!titlesOf(winter).some((x) => x.startsWith('短袖')), '冬不产短袖')
  assert.ok(titlesOf(winter).includes('感冒药'), '常备药')

  const summer = buildPackingList({ destination: '成都', days: 4, startDate: '2026-07-10' })
  assert.ok(titlesOf(summer).some((x) => x.startsWith('短袖')))
  assert.ok(titlesOf(summer).includes('防晒衣'))
  assert.ok(titlesOf(summer).includes('驱蚊液'))
  assert.ok(titlesOf(summer).includes('折叠伞'), '夏默认 rain≥1 → 折叠伞')
})

await spec('显式温度覆盖季节推断', () => {
  const snow = buildPackingList({ destination: '哈尔滨', days: 3, startDate: '2026-07-10', tempLow: -12 })
  assert.ok(titlesOf(snow).includes('羽绒服 / 厚外套'), '显式 tempLow=-12 → 厚外套')
  assert.ok(titlesOf(snow).includes('围巾手套'))
  const heat = buildPackingList({ destination: '吐鲁番', days: 3, startDate: '2026-12-05', tempHigh: 38 })
  assert.ok(titlesOf(heat).some((x) => x.startsWith('短袖')), '显式 tempHigh=38 → 短袖')
  assert.ok(titlesOf(heat).includes('防晒霜（SPF50）'))
})

await spec('交通/住宿信号 → 订单与晕车药/拖鞋', () => {
  const out = buildPackingList({
    destination: '成都',
    days: 3,
    startDate: '2026-10-01',
    hasStay: true,
    hasTransit: true
  })
  const t = titlesOf(out)
  assert.ok(t.includes('酒店订单'))
  assert.ok(t.includes('车票 / 机票订单'))
  assert.ok(t.includes('晕车药'))
  assert.ok(t.includes('一次性拖鞋'))
})

await spec('目的地关键词：港澳 → 通行证；海岛 → 泳装', () => {
  assert.ok(titlesOf(buildPackingList({ destination: '香港', days: 3 })).some((x) => x.includes('港澳通行证')))
  assert.ok(titlesOf(buildPackingList({ destination: '三亚亚龙湾', days: 5, startDate: '2026-07-01' })).includes('泳装 / 沙滩鞋'))
  assert.ok(!titlesOf(buildPackingList({ destination: '成都', days: 3 })).some((x) => x.includes('泳装')))
})

await spec('分组按 PACKING_GROUPS 顺序连续产出，页面可直接按相邻变化分组', () => {
  const out = buildPackingList({ destination: '三亚', days: 6, startDate: '2026-07-01', hasStay: true, hasTransit: true })
  const order = []
  for (const g of groupsOf(out)) {
    if (order[order.length - 1] !== g) order.push(g)
  }
  assert.deepEqual(order, PACKING_GROUPS.map((g) => g.key), '组序列不应来回跳')
})

await spec('夹紧：days=0 → 1 天模板；超大 days 不溢出', () => {
  const one = buildPackingList({ destination: '成都', days: 0, startDate: '2026-10-01' })
  assert.ok(one.length > 0)
  assert.ok(titlesOf(one).some((x) => x.startsWith('内衣裤')))
  const big = buildPackingList({ destination: '三亚', days: 400, startDate: '2026-07-01', hasStay: true, hasTransit: true })
  assert.ok(titlesOf(big).every((x) => !x.includes('×400')), '衣物件数封顶')
})

await spec('条数上限 40（与服务端裁剪孪生一致）', () => {
  const worst = buildPackingList({
    destination: '三亚海岛游',
    days: 30,
    startDate: '2026-07-01',
    hasStay: true,
    hasTransit: true,
    rainDays: 5,
    tempHigh: 35
  })
  assert.ok(worst.length <= PACKING_MAX_ITEMS, `最多 ${worst.length}`)
  assert.ok(worst.every((i) => i.title && PACKING_GROUPS.some((g) => g.key === i.group)))
})

await spec('无起始日期（手建行程）也能出平季模板', () => {
  const out = buildPackingList({ destination: '成都', days: 2 })
  assert.ok(titlesOf(out).includes('身份证'))
  assert.ok(!titlesOf(out).includes('防晒霜（SPF50）'), '平季 24° 不出防晒')
})

await spec('packGroupLabel：key → 中文，未知 key 原样返回', () => {
  assert.equal(packGroupLabel('wear'), '衣物')
  assert.equal(packGroupLabel('docs'), '证件票单')
  assert.equal(packGroupLabel('unknown'), 'unknown')
})

console.log(`\n===== 行李清单结果：${passed} 通过 / ${failures.length} 失败 =====`)
if (failures.length) {
  console.error('失败用例：', failures.join('；'))
  process.exitCode = 1
}
