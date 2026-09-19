/**
 * 客户端同步逻辑验证（真实 store + 真实后端）。
 *
 * 由 scripts/client-sync-test.mjs 用 esbuild 打包后在 Node 上跑：
 * 模拟三台独立设备（各自一份本地存储），走完「A 建行程 → B 凭码加入 →
 * 双方互相改 → 删条目 → 离线改 → 并发改 → 删整个行程」的全流程。
 *
 * 之所以要单独测客户端：服务端的合并规则再好，只要 store 漏打一次
 * updatedAt、或删除忘了记墓碑，用户看到的现象就是「改完同步后变回去了」——
 * 这类 bug 靠服务端测试根本发现不了，也无法在微信开发者工具里手动重现。
 */
import { mock } from './uni-mock'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPinia } from 'pinia'
import { useTripStore } from '../src/stores/trip'
import { storage } from '../src/repository/storage'
import type { SyncMeta } from '../src/types'
import { encodeHlc, cmpHlc, recordHlc, createHlc } from '../src/services/hlc'
import { MERGE_META_KEYS, mergeRecord } from '../src/services/lww'
import { identityValid, loginErrorText } from '../src/services/identity'
import { backoffDelay, toWsUrl } from '../src/services/realtime'

type Device = 'A' | 'B' | 'C'

let pass = 0
let fail = 0

function ok(cond: unknown, label: string, extra?: unknown) {
  if (cond) {
    pass += 1
    console.log('  ✓', label)
  } else {
    fail += 1
    console.log('  ✗', label, extra === undefined ? '' : JSON.stringify(extra))
  }
}

function section(title: string) {
  console.log('\n' + title)
}

const A = useTripStore(createPinia())
const B = useTripStore(createPinia())
const C = useTripStore(createPinia())

/**
 * 把某个 store 实例的读写绑定到它自己的「设备存储」。
 *
 * 否则自动同步的去抖定时器可能在切换到别的设备之后才触发，
 * 把 A 的状态写进 B 的存储 —— 这是测试脚手架的坑，不是产品代码的问题。
 */
type AnyStore = typeof A
function bind(store: AnyStore, dev: Device) {
  const methods = ['load', 'persist', 'persistSync'] as const
  for (const m of methods) {
    const orig = (store[m] as (...args: unknown[]) => unknown).bind(store)
    ;(store as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
      const prev = mock.state.device
      mock.state.device = dev
      try {
        return orig(...args)
      } finally {
        mock.state.device = prev
      }
    }
  }
}

bind(A, 'A')
bind(B, 'B')
bind(C, 'C')

function as(dev: Device): AnyStore {
  mock.useDevice(dev)
  // 令牌不需要在这里按设备重设：backend 已从模块级单例改为每 store 一份实例
  // （store.api()），令牌在每次请求时从该实例自己的 sync.identity 现取 ——
  // A 登录不会再波及 B / C，「非成员写不进去」的断言天然测到真东西。
  // 若哪天有人把令牌改回模块级可变状态，[11] 的 403 断言会当场变红。
  return dev === 'A' ? A : dev === 'B' ? B : C
}

as('A').load()
as('B').load()
as('C').load()

// ── [0.5] 脚手架自检：bind() 的设备隔离必须真的生效 ──
//
// bind() 是所有多设备用例的「地基」：每个用例都假设「A 的读写只落在 A 的存储」。
// 但地基自己没断言 —— 若有人改坏 bind（比如吞掉 finally 里的设备还原，或没包住
// persistSync），多设备用例只会**偶尔**互相污染（取决于去抖定时器何时触发），
// 绿得看运气。这里用一次确定性的写入对照把地基钉死：
// 当前设备是 B 时让 A 写盘 → B 的存储必须纹丝不动、写入必须落在 A 的存储、
// 调用完设备必须还原（finally 的职责）。
section('[0.5] 脚手架自检：bind() 的设备隔离真的生效')
{
  mock.useDevice('B')
  const before = mock.read('B', 'travel_h5_state_v1')
  A.persistSync()
  ok(
    mock.state.device === 'B' && JSON.stringify(before) === JSON.stringify(mock.read('B', 'travel_h5_state_v1')),
    '当前设备是 B 时调 A.persistSync()：B 的存储纹丝不动、设备已还原（bind 的交换生效）',
    { device: mock.state.device }
  )
  ok(
    mock.read('A', 'travel_h5_state_v1') !== null,
    '写入落在 A 自己的存储里（而不是「当时的当前设备」）'
  )
}

// ── [0] 客户端 HLC 自检 ──
//
// 编码格式必须与服务端 server/lib/hlc.mjs **逐字节一致**，否则两端对「谁更新」的
// 判断会分叉：服务端按它那边的编码比，客户端按自己这边的比，同一份数据得出不同结论。
//
// 两侧各自对**同一个字面量**断言（服务端那份在 server/smoke.mjs 的 [15]），
// 等于把「两端同一把尺子」这件事钉住了 —— 任何一侧改格式都会炸。
section('[0] 客户端 HLC：编码与服务端对齐 / 因果序 / 陈旧 hlc 兜底')

ok(
  encodeHlc({ t: 1, c: 0, n: '00000000' }) === '000000000000001-000000-00000000',
  '编码样例（最小值）与服务端一致',
  encodeHlc({ t: 1, c: 0, n: '00000000' })
)
ok(
  encodeHlc({ t: 1789622509947, c: 3, n: 'ab12cd34' }) === '001789622509947-000003-ab12cd34',
  '编码样例（常规值）与服务端一致',
  encodeHlc({ t: 1789622509947, c: 3, n: 'ab12cd34' })
)

// 字典序 == 三元组序：服务端 SQL 里的 MAX()/>= 全靠这条性质与 JS 侧结论一致
const encSeq = [
  { t: 5, c: 0, n: '00000000' },
  { t: 5, c: 1, n: '00000000' },
  { t: 5, c: 1, n: '00000001' },
  { t: 6, c: 0, n: '00000000' }
].map(encodeHlc)
ok(encSeq.join('|') === [...encSeq].sort().join('|'), '定长编码后字典序 == 三元组序', encSeq)

// 因果序：收到别家的戳后再编辑，必须排在对方之后 —— 这是 HLC 存在的理由
{
  let phys = 1_000_000
  const clk = createHlc({ state: null, now: () => phys })
  const seen = clk.observe({ t: phys + 400, c: 2, n: 'aaaaaaaa' })
  const mine = clk.stamp()
  ok(cmpHlc(mine, seen) > 0, 'observe 之后 stamp 一定晚于对方（物理钟没动也一样）', {
    mine,
    seen
  })
  // 物理时钟原地不动时，靠同一毫秒内的计数递增保持全序
  const again = clk.stamp()
  ok(cmpHlc(again, mine) > 0, '同毫秒连续两次 stamp 仍严格递增', { mine, again })
}

// 坏钟同伴不能把本机逻辑时钟拽跑：observe 也封顶（与服务端同一口径）
{
  const phys = 1_000_000
  const clk = createHlc({ state: null, now: () => phys, maxSkewMs: 60_000 })
  const obs = clk.observe({ t: phys + 3 * 3600 * 1000, c: 0, n: 'bbbbbbbb' })
  ok(obs.t === phys + 60_000, '收下 3 小时超前的戳时被封到 now+60s', obs)
}

// 陈旧 hlc 兜底：客户端手里那个从云端带回来的旧 hlc，不能压过它自己的 updatedAt
{
  const h = recordHlc({ t: 1000, c: 0, n: 'cccccccc' }, 5000)
  ok(h.t === 5000, 'recordHlc 取较晚者（updatedAt 更新时以它为准）', h)
  const back = recordHlc({ t: 9000, c: 0, n: 'cccccccc' }, 5000)
  ok(back.t === 9000 && back.n === 'cccccccc', 'recordHlc 取较晚者（hlc 更新时保留原 hlc）', back)
}

// ── 孪生模块一致性 ──
//
// `server/lib/hlc.mjs` ↔ `src/services/hlc.ts`、`server/lib/lww.mjs` ↔ `src/services/lww.ts`
// 是两对孪生实现：服务端是 .mjs、客户端是 .ts，零依赖约束下没法共享源码，只能各写一份。
//
// 这个模式已经踩过两次：
//   · `loose()` 加进了 .ts 却忘了 .mjs → 服务端直到运行到那一行才抛 ReferenceError；
//   · 「哪些字段参与合并」两边各写一套，很容易只改一边。
// 语法检查发现不了「用了不存在的名字」，所以这里直接钉住**双方都必须导出**的那份清单。
//
// 平台各自特有的导出不在清单里，允许不同：服务端的 nodeKey / decodeHlc 要用
// node:crypto 与 SQL 侧的字符串解码，客户端的 newHlcNode 要在小程序里生成节点号。
{
  const TWINS: Record<string, { of: string; need: string[] }> = {
    'server/lib/hlc.mjs': {
      of: 'src/services/hlc.ts',
      need: [
        'createHlc', 'normHlc', 'recordHlc', 'capHlc', 'cmpHlc', 'hlcAfter',
        'maxHlc', 'encodeHlc', 'hlcFromTs', 'hlcTimeOf', 'LEGACY_NODE'
      ]
    },
    'server/lib/lww.mjs': {
      of: 'src/services/lww.ts',
      need: ['MERGE_META_KEYS', 'MAX_MERGE_FIELDS', 'dataKeysOf', 'fieldHlcsOf', 'withRecordHlc', 'mergeRecord']
    }
  }

  // 本文件会被打包到临时目录再执行，不能按 import.meta.url 找项目文件，
  // 用 cwd（脚本约定从项目根目录跑）拼绝对路径。
  const exportsOf = (rel: string): Set<string> => {
    const src = readFileSync(join(process.cwd(), rel), 'utf8')
    const out = new Set<string>()
    for (const m of src.matchAll(
      /^export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z_$][\w$]*)/gm
    )) {
      out.add(m[1])
    }
    for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
      for (const raw of m[1].split(',')) {
        const n = raw.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim()
        if (/^[A-Za-z_$][\w$]*$/.test(n)) out.add(n)
      }
    }
    return out
  }

  for (const [serverRel, spec] of Object.entries(TWINS)) {
    const server = exportsOf(serverRel)
    const client = exportsOf(spec.of)
    const missServer = spec.need.filter((n) => !server.has(n))
    const missClient = spec.need.filter((n) => !client.has(n))
    ok(
      !missServer.length && !missClient.length,
      `${serverRel} ↔ ${spec.of} 共享语义导出一致`,
      { 服务端缺: missServer, 客户端缺: missClient }
    )
  }
}

// ── 字段级合并的纯函数语义自检 ──
//
// 不经过网络，把 mergeRecord 的几条关键规则钉死。端到端那条在 [10]。
{
  const H = (t: number, n = '11111111') => ({ t, c: 0, n })
  const base = {
    id: 'x',
    a: 1,
    b: 2,
    updatedAt: 100,
    hlc: H(100),
    fhlc: { a: H(100), b: H(100) }
  }
  // incoming 只顶了 b
  const r = mergeRecord(base, { ...base, b: 9, updatedAt: 200, hlc: H(200), fhlc: { a: H(100), b: H(200) } })
  ok(r.rec.a === 1 && r.rec.b === 9, '只改 b：a 保留 base、b 取 incoming', { a: r.rec.a, b: r.rec.b })
  ok(r.rec.updatedAt === 200, '记录级 hlc / updatedAt 由字段戳推导为最大值', r.rec.updatedAt)
  ok(r.took === 1 && r.kept === 1, 'took / kept 计数正确', { took: r.took, kept: r.kept })

  // 平局保留 base：这是两端不来回翻的前提
  const tie = mergeRecord(base, { ...base, a: 42 })
  ok(tie.rec.a === 1, '时间戳相等时保留 base（两端同口径，不来回翻）', tie.rec.a)

  // 没有 fhlc 的老记录 → 整条退到记录级 LWW
  const legacy = mergeRecord(
    { id: 'x', a: 1, b: 2, updatedAt: 100 },
    { id: 'x', a: 1, b: 9, updatedAt: 200 }
  )
  ok(
    legacy.rec.a === 1 && legacy.rec.b === 9,
    '无字段戳的老记录按记录级整条胜负（旧行为不变）',
    { a: legacy.rec.a, b: legacy.rec.b }
  )

  // 插入：身份字段必须保留（漏掉 id 会让落库直接失败）
  const ins = mergeRecord(null, { id: 'y', tripId: 't', a: 1, updatedAt: 5 })
  ok(ins.rec.id === 'y' && ins.rec.tripId === 't', '插入时 id / tripId 不丢', {
    id: ins.rec.id,
    tripId: ins.rec.tripId
  })
}

const trip = as('A').createTrip({
  title: '成都四日',
  destination: '成都',
  startDate: '2026-10-01',
  endDate: '2026-10-03',
  budget: 3000,
  memberNames: ['我', '阿哲']
})

section('[1] A 建行程 + 记一笔账 → 推送云端')
const aMembers = A.membersOf(trip.id)
A.addExpense({
  tripId: trip.id,
  title: '蜀九香火锅',
  amount: 400,
  category: 'food',
  date: '2026-10-01',
  payerId: aMembers[0].id,
  participants: aMembers.map((m) => ({ memberId: m.id, share: 1 })),
  splitMode: 'even',
  note: ''
})
ok(A.dirtyTripIds.includes(trip.id), '改动后行程被标记为待推送', A.dirtyTripIds)
await A.syncAll()
ok(A.sync.lastStatus === 'ok', '同步成功', { s: A.sync.lastStatus, e: A.sync.lastError })
const code = A.sync.codes[trip.id]
ok(/^[A-Z0-9]{6}$/.test(code || ''), '拿到分享码 ' + code, code)
ok(!A.dirtyTripIds.includes(trip.id), '推送后不再是待推送')
ok(
  JSON.parse(mock.read('A', 'travel_h5_state_v1')).trips.length === 1,
  '数据确实落到 A 的本地存储'
)

section('[2] B 凭分享码加入')
const B1 = as('B')
const joined = await B1.joinByCode(code)
ok(B1.trips.length === 1, 'B 本地出现该行程', B1.trips.length)
ok(joined.id === trip.id, '是同一个行程 id')
ok(B1.membersOf(joined.id).length === 2, '成员一致', B1.membersOf(joined.id).length)
ok(B1.expensesOf(joined.id).length === 1, 'B 看到同一笔账单', B1.expensesOf(joined.id).length)
ok(B1.expensesOf(joined.id)[0].amount === 400, '金额一致')
ok(B1.daysOf(joined.id).length === 3, '天数按日期生成一致', B1.daysOf(joined.id).length)

section('[3] B 加一笔账单 → A 同步后能看到')
const bMembers = B1.membersOf(joined.id)
B1.addExpense({
  tripId: joined.id,
  title: '青城山包车',
  amount: 520,
  category: 'transport',
  date: '2026-10-02',
  payerId: bMembers[1].id,
  participants: bMembers.map((m) => ({ memberId: m.id, share: 1 })),
  splitMode: 'even',
  note: ''
})
await B1.syncAll()
ok(B1.sync.lastStatus === 'ok', 'B 推送成功', B1.sync.lastStatus)
await as('A').syncAll()
ok(A.expensesOf(trip.id).length === 2, 'A 拉到 B 加的账单', A.expensesOf(trip.id).length)
ok(A.expensesOf(trip.id).some((e) => e.title === '青城山包车'), '账单标题一致')

section('[4] A 删掉一笔账单 → B 同步后也消失（墓碑生效）')
const victim = A.expensesOf(trip.id).find((e) => e.title === '青城山包车')
ok(!!victim, '先确认找到了这笔账单')
A.removeExpense(victim!.id)
ok(A.sync.tombstones.length === 1, '删除产生了一条墓碑', A.sync.tombstones)
await A.syncAll()
ok(A.sync.tombstones.length === 0, '推送成功后墓碑被清空')
await as('B').syncAll()
ok(B1.expensesOf(joined.id).length === 1, 'B 端该账单消失', B1.expensesOf(joined.id).length)
ok(!B1.expensesOf(joined.id).some((e) => e.title === '青城山包车'), '删掉的账单没有复活')

section('[5] 离线改动只存本地，联网后自动补推')
const offMembers = B1.membersOf(joined.id)
mock.setOnline(false)
B1.addExpense({
  tripId: joined.id,
  title: '离线买的奶茶',
  amount: 32,
  category: 'food',
  date: '2026-10-03',
  payerId: offMembers[0].id,
  participants: offMembers.map((m) => ({ memberId: m.id, share: 1 })),
  splitMode: 'even',
  note: ''
})
await B1.syncAll()
ok(B1.sync.lastStatus === 'offline', '离线时状态为 offline', {
  s: B1.sync.lastStatus,
  e: B1.sync.lastError
})
ok(
  B1.expensesOf(joined.id).some((e) => e.title === '离线买的奶茶'),
  '离线改动仍保留在本地'
)
ok(B1.dirtyTripIds.includes(joined.id), '该行程仍标记为待推送')
mock.setOnline(true)
await B1.syncAll()
ok(B1.sync.lastStatus === 'ok', '恢复联网后同步成功', B1.sync.lastStatus)
await as('A').syncAll()
ok(
  A.expensesOf(trip.id).some((e) => e.title === '离线买的奶茶'),
  'A 收到了离线期间补推的改动'
)

section('[6] 双方改同一条：后改的赢（LWW）')
A.updateTrip(trip.id, { title: 'A 改的标题' })
// 回归守卫：编辑后本地记录必须带上**本机节点号**的 HLC。
//
// 早前的 bug 是 stamp 只写 updatedAt、不动 hlc，而本地那条记录是从云端同步下来的
// （带着服务端给的 hlc）。于是编辑完推送时，服务端优先采信那个**陈旧 hlc**，
// 比较结果既不算更新也不算冲突 —— 编辑被静默丢弃，applied.conflicts === 0 且内容纹丝不动。
const aHlcAfterEdit = A.trips.find((t) => t.id === trip.id)?.hlc
ok(
  !!aHlcAfterEdit && aHlcAfterEdit.n !== '00000000',
  'A 编辑后带上了本机节点号的 HLC',
  JSON.stringify(aHlcAfterEdit)
)
await new Promise((r) => setTimeout(r, 40))
B1.updateTrip(joined.id, { title: 'B 改的标题' })
await B1.syncAll()
const srv1 = await B1.api().getSpace(trip.id)
ok(
  srv1.space?.doc?.trip?.title === 'B 改的标题',
  '服务端已接受 B 的改动',
  srv1.space?.doc?.trip?.title
)
await as('A').syncAll()
ok(
  A.trips.find((t) => t.id === trip.id)?.title === 'B 改的标题',
  'A 端收敛到后改的标题',
  A.trips.find((t) => t.id === trip.id)?.title
)
await as('B').syncAll()
ok(B1.trips.find((t) => t.id === joined.id)?.title === 'B 改的标题', 'B 端一致')

section('[7] 全新设备 C 凭码加入 → 拿到完整现状')
const C1 = as('C')
const cTrip = await C1.joinByCode(code)
ok(C1.trips.length === 1, 'C 本地出现该行程')
ok(C1.membersOf(cTrip.id).length === 2, '成员齐全', C1.membersOf(cTrip.id).length)
ok(C1.expensesOf(cTrip.id).length === 2, '账单齐全（火锅 + 离线奶茶）', C1.expensesOf(cTrip.id).length)
ok(C1.expensesOf(cTrip.id).some((e) => e.title === '离线买的奶茶'), '包含后加的账单')
ok(C1.trips.find((t) => t.id === cTrip.id)?.title === 'B 改的标题', '标题为最新')

section('[8] A 删掉整个行程 → 其他人同步后也没了')
A.removeTrip(trip.id)
ok(
  A.sync.tombstones.some((t) => t.kind === 'trip' && t.id === trip.id),
  '删行程留有 trip 墓碑'
)
ok(A.trips.length === 0, 'A 本地已无该行程')
ok(
  JSON.parse(mock.read('A', 'travel_h5_state_v1')).trips.length === 0,
  'A 的本地存储也清掉了'
)
await A.syncAll()
await as('B').syncAll()
ok(B1.trips.length === 0, 'B 同步后本地也没了', B1.trips.length)
await as('C').syncAll()
ok(C1.trips.length === 0, 'C 同步后本地也没了', C1.trips.length)

// ── [9] HLC 状态持久化：冷启动不能倒退 ──
//
// `travel_sync_v1` 是**白名单式重建**读出来的（storage.readSync 逐字段挑，不是展开后覆盖），
// 漏一个字段就等于每次读取都把它悄悄丢掉。HLC 状态一丢，下次冷启动本机逻辑时钟从 0 起步：
// 手机时钟若落后于上次见过的服务端时间戳，之后所有编辑都会拿到更小的 HLC、
// 被服务端判成落后而丢弃 —— 而本地看起来一切正常，症状是「我改了但别人的页面不变」，
// 在微信开发者工具里几乎不可能定位。所以这条必须钉死。
section('[9] HLC 状态持久化：落盘 + 读回都不丢')

mock.useDevice('A')
const persisted = JSON.parse(mock.read('A', 'travel_sync_v1') || '{}') as {
  hlc?: { t: number; c: number; n: string }
}
ok(
  !!persisted.hlc && persisted.hlc.t > 0 && /^[0-9a-f]{8}$/.test(persisted.hlc.n || ''),
  'HLC 状态已落盘到 travel_sync_v1',
  persisted.hlc
)
const roundTrip = storage.readSync()
ok(
  roundTrip.hlc?.t === A.sync.hlc?.t &&
    roundTrip.hlc?.c === A.sync.hlc?.c &&
    roundTrip.hlc?.n === A.sync.hlc?.n,
  'readSync 读回后与内存中的 HLC 状态一致（白名单没漏字段）',
  { memory: A.sync.hlc, disk: roundTrip.hlc }
)
// 同一个存储条目里，墓碑的 deletedAt 也不会被 readSync 丢掉（老字段的同类守卫）
ok(
  Array.isArray(roundTrip.tombstones) && roundTrip.tombstones.length === 0,
  '墓碑列表读回正常',
  roundTrip.tombstones
)

// 三台设备的 HLC 节点号必须互不相同。
//
// 时钟曾经是**模块级单例**（`let hlcClock`），三个 store 实例共用同一个节点号，
// 而且 `save` 闭包写死在第一个创建它的实例上 —— 于是 B、C 的编辑把逻辑时钟状态
// 写进了 A 的同步元数据。症状是「每台设备各自持久化自己的时钟」这件事根本没发生，
// 但上面那条 readSync 断言却因为「恰好写到了 A」而变绿。
// 现在时钟按 store 实例持有（WeakMap），这条断言才有意义。
const clockNodes = [A.sync.hlc?.n, B.sync.hlc?.n, C.sync.hlc?.n].filter(Boolean) as string[]
ok(
  clockNodes.length === 3 && new Set(clockNodes).size === 3,
  '三台设备各有各的 HLC 节点号（时钟按 store 实例持有，不是全局单例）',
  clockNodes
)

// ── [9.5] SyncMeta 白名单重建：全字段 round-trip / 畸形输入收敛 ──
//
// readSync 是白名单式重建，hlc 和 identity 都被漏过（各造成一次真事故）。
// 字段归一化现在收敛在 storage.ts 的 SYNC_META_SPEC 一张表里，`satisfies` 让
// 「类型加了字段、spec 忘了加」变成**编译错误** —— 编译器管住「漏字段」，
// 这里管住剩下的部分：归一化函数本身写坏（比如条件写反、默认值给错）。
// 办法是两头夹击：
//   · 全字段写入 → 读回必须一字不差（归一化函数不能吃掉合法值）；
//   · 畸形写入 → 必须收敛到默认值（不能带病上岗）。
// 用独立的 'Z' 设备跑，不弄脏 A/B/C 的既有状态。
section('[9.5] SyncMeta 白名单重建：全字段 round-trip 与畸形输入')

mock.useDevice('Z')
storage.clearAll()
const full: SyncMeta = {
  deviceId: 'dev-z',
  author: '测者',
  lastSyncAt: 1726600000000,
  lastStatus: 'ok',
  lastError: '曾经出过错',
  revOf: { t1: 7, t2: 12 },
  localAtOf: { t1: 1726600001000 },
  syncedAtOf: { t1: 1726600000500 },
  codes: { t1: 'ABC123' },
  tombstones: [
    { kind: 'item', id: 'i1', deletedAt: 1726600002000, hlc: { t: 1726600002000, c: 1, n: '0badf00d' }, tripId: 't1' }
  ],
  hlc: { t: 1726600002000, c: 3, n: '0badf00d' },
  identity: { openid: 'oZ', token: 'tok-z', expiresAt: 1726700000000, dev: true }
}
storage.writeSync(full)
const back = storage.readSync()
ok(
  back.deviceId === full.deviceId &&
    back.author === full.author &&
    back.lastSyncAt === full.lastSyncAt &&
    back.lastStatus === full.lastStatus &&
    back.lastError === full.lastError,
  '标量字段 round-trip 不丢',
  back
)
ok(
  JSON.stringify(back.revOf) === JSON.stringify(full.revOf) &&
    JSON.stringify(back.localAtOf) === JSON.stringify(full.localAtOf) &&
    JSON.stringify(back.syncedAtOf) === JSON.stringify(full.syncedAtOf) &&
    JSON.stringify(back.codes) === JSON.stringify(full.codes),
  '映射字段 round-trip 不丢',
  back
)
ok(
  back.tombstones.length === 1 &&
    back.tombstones[0].id === 'i1' &&
    back.tombstones[0].kind === 'item' &&
    back.tombstones[0].tripId === 't1' &&
    back.tombstones[0].deletedAt === 1726600002000,
  '墓碑 round-trip 不丢（含 tripId 路由字段）',
  back.tombstones
)
ok(
  back.hlc?.t === full.hlc?.t && back.hlc?.c === full.hlc?.c && back.hlc?.n === full.hlc?.n,
  'HLC 状态 round-trip 不丢',
  { memory: full.hlc, disk: back.hlc }
)
ok(
  back.identity?.openid === 'oZ' &&
    back.identity?.token === 'tok-z' &&
    back.identity?.expiresAt === 1726700000000 &&
    back.identity?.dev === true,
  '身份 round-trip 不丢（含 dev 标记）',
  back.identity
)

// 畸形输入：类型不对 / 非法值，一律收敛到默认，而不是带病上岗
storage.writeSync({
  deviceId: 42,
  author: '   ',
  lastSyncAt: 'abc',
  lastStatus: 'bogus-status',
  lastError: 0,
  revOf: 'nope',
  codes: null,
  tombstones: 'x',
  hlc: { t: -1, c: 0, n: 'zzzz' },
  identity: { token: '' }
} as unknown as SyncMeta)
const norm = storage.readSync()
ok(
  norm.deviceId === '' &&
    norm.author === '我' &&
    norm.lastSyncAt === 0 &&
    norm.lastStatus === 'idle' &&
    norm.lastError === '' &&
    JSON.stringify(norm.revOf) === '{}' &&
    JSON.stringify(norm.codes) === '{}' &&
    Array.isArray(norm.tombstones) &&
    norm.tombstones.length === 0,
  '畸形字段全部收敛到默认',
  norm
)
ok(!norm.hlc, '畸形 HLC 被丢弃（而不是带病上岗）', norm.hlc)
ok((norm.identity ?? null) === null, '畸形身份被清空', norm.identity)

// 未来版本写入的未知新字段：被白名单挡在外面，既有字段不受影响
storage.writeSync({ ...full, somedayNewField: { a: 1 } } as unknown as SyncMeta)
const withNew = storage.readSync()
ok(
  withNew.deviceId === full.deviceId &&
    withNew.hlc?.t === full.hlc?.t &&
    !('somedayNewField' in withNew),
  '未知新字段被白名单挡在外面，既有字段不受影响',
  withNew
)
storage.clearAll()


// ── [10] 字段级合并：两台设备各改一条记录的不同字段 ──
//
// 这是 Step 3 真正的收益点，也是记录级 LWW 一定会丢数据的场景。
// 用一个**全新的行程**跑，不干扰前面几节的既有状态。
section('[10] 字段级合并：两人各改同一条记录的不同字段 → 两边都保住')

const T2 = as('A').createTrip({
  title: '字段级合并用例',
  destination: '西安',
  startDate: '2026-12-01',
  endDate: '2026-12-02',
  budget: 500,
  memberNames: ['我', '小北']
})
await as('A').syncAll()
const code2 = A.sync.codes[T2.id]
ok(/^[A-Z0-9]{6}$/.test(code2 || ''), '新行程拿到分享码 ' + code2, code2)

// B 加入，并且**先同步一次**拿到服务端那一版 —— 接下来的两边改动都基于同一份基线
const B2 = as('B')
const bJoined = await B2.joinByCode(code2)
await as('B').syncAll()

// A 改标题，B 改预算：不同字段、且双方都没看到对方的改动（真并发）
A.updateTrip(T2.id, { title: 'A 改的标题' })
B2.updateTrip(bJoined.id, { budget: 8888 })

// ⚠️ 这里必须用 pushTrip 而不是 syncAll。
//
// syncAll 是「先拉 → 再推 → 再拉」，B 在推之前就已经把 A 的标题拉下来了，
// 于是「各改一边」在客户端本地就合并完了，**服务端那次并发根本没被触发** ——
// 测试看起来过了，实际只验到了客户端那一半。
// 直接 pushTrip 才是两台设备各自带着自己的版本同时推上去，服务端的字段级合并才会真正被打到。
await as('A').pushTrip(T2.id)
await as('B').pushTrip(bJoined.id)

// 之后走正常同步收敛（A 先推的，B 推完 A 还不知道，所以要再拉一次）
await as('A').syncAll()

const aT = A.trips.find((t) => t.id === T2.id)
const bT = B2.trips.find((t) => t.id === T2.id)

ok(aT?.title === 'A 改的标题', 'A 的标题改动保住了', aT?.title)
ok(aT?.budget === 8888, 'B 的预算改动也保住了（A 端）', aT?.budget)
ok(bT?.title === 'A 改的标题', 'B 端也拿到了 A 的标题', bT?.title)
ok(bT?.budget === 8888, 'B 端自己的预算没被盖掉', bT?.budget)

// 服务端也必须两格都在
const srvT2 = await A.api().getSpace(T2.id)
ok(srvT2.space?.doc?.trip?.title === 'A 改的标题', '服务端标题正确', srvT2.space?.doc?.trip?.title)
ok(srvT2.space?.doc?.trip?.budget === 8888, '服务端预算正确', srvT2.space?.doc?.trip?.budget)

// 同一条记录的字段戳映射确实存在，且 title / budget 是**两个不同的戳**
// —— 这正是「各自只顶自己改过的字段」留下的痕迹
const fm = srvT2.space?.doc?.trip?.fhlc || {}
ok(!!fm.title && !!fm.budget, '记录上带着字段级时间戳映射', Object.keys(fm))
ok(
  !Object.keys(fm).some((k) => MERGE_META_KEYS.has(k)),
  '字段戳映射里没有混进元数据键（id / updatedAt / hlc / fhlc）',
  Object.keys(fm)
)
// ⚠️ 这里比的是**完整 HLC 编码**，不是 `.t`。
//
// 两台设备是几乎同时改的，两个字段戳的 `t` 完全可以落在同一毫秒 —— 只比 `.t` 会误报
// （曾经就是这么红的：两边都是 ...629785，差别只在同毫秒计数 `c`）。
// 要证明的是「两个字段各自被顶过、不是整条覆盖」，而完整三元组（含 `c` 与节点号 `n`）
// 不同才说明这一点：记录级 LWW 下两个字段会拿到**同一个**戳对象，这条断言就会红。
ok(
  encodeHlc(fm.title) !== encodeHlc(fm.budget),
  '两个字段的字段戳是各自独立的（各顶各的，不是整条覆盖）',
  { title: encodeHlc(fm.title), budget: encodeHlc(fm.budget) }
)
// 两台设备必须各有自己的节点号，否则「本机节点号」这一层语义整个是假的
ok(
  fm.title.n !== fm.budget.n,
  '两个字段戳来自不同设备节点（A 改标题 / B 改预算）',
  { title: fm.title.n, budget: fm.budget.n }
)

// 第三个设备凭码加入，看到的必须是合并后的完整状态
const C2 = as('C')
const c2Trip = await C2.joinByCode(code2)
ok(c2Trip.title === 'A 改的标题', '新设备看到 A 的标题', c2Trip.title)
ok(
  C2.trips.find((t) => t.id === c2Trip.id)?.budget === 8888,
  '新设备也看到 B 的预算',
  C2.trips.find((t) => t.id === c2Trip.id)?.budget
)

// ── [11] 微信身份：登录 / 令牌持久化 / 归属与授权 ──
//
// Step 4 的收益点：把「谁是谁」从**客户端自报**（昵称 / 知道 id）换成**服务端可校验**的 openid。
// 这里要钉住的是「服务端真的会因为身份不同而给出不同结果」——
// 只在服务端测是不够的，客户端不带令牌 / 忘了持久化，用户看到的就是「登录了却说我没权限」。
section('[11] 微信身份：登录 / 令牌持久化 / 归属与授权')

// 11.1 初始未登录
ok(!as('A').isLoggedIn(), '初始状态未登录')
ok((as('A').sync.identity ?? null) === null, '本地没有身份记录')

// 11.2 纯函数的有效期判定（不要靠「跑的时候刚好没过期」来验证）
{
  const now = 1_700_000_000_000
  ok(!identityValid(null, now), 'null 身份视为未登录')
  ok(!identityValid(undefined, now), 'undefined 身份视为未登录')
  ok(
    identityValid({ openid: 'o', token: 't', expiresAt: now + 3600_000 }, now),
    '未到期的身份有效'
  )
  ok(
    !identityValid({ openid: 'o', token: 't', expiresAt: now + 1000 }, now),
    '临到期（不足 60s）视为需要重新登录，避免请求正好卡在过期边界'
  )
  ok(!identityValid({ openid: '', token: 't', expiresAt: now + 3600_000 }, now), '缺 openid 视为无效')
  ok(!identityValid({ openid: 'o', token: '', expiresAt: now + 3600_000 }, now), '缺令牌视为无效')
}

// 11.3 登录
await as('A').login()
const idA = A.sync.identity
ok(!!idA && /^dev[0-9a-f]{24}$/.test(idA.openid), '登录换到 openid', idA?.openid)
ok(String(idA?.token || '').startsWith('wxs_'), '拿到服务端签发的会话令牌')
ok(A.isLoggedIn(), '登录后状态为已登录')

// 令牌必须落盘 + 读回 —— readSync 是白名单式重建，漏字段就等于每次冷启动被登出
const diskSync = JSON.parse(mock.read('A', 'travel_sync_v1') || '{}') as {
  identity?: { openid?: string } | null
}
ok(diskSync.identity?.openid === idA?.openid, '身份已落盘到 travel_sync_v1')
ok(storage.readSync().identity?.openid === idA?.openid, 'readSync 读回身份不丢（白名单没漏字段）')

// 11.4 登录后创建的行程归自己
const T3 = as('A').createTrip({
  title: '身份用例',
  destination: '厦门',
  startDate: '2027-01-01',
  endDate: '2027-01-02',
  budget: 200,
  memberNames: ['我']
})
await as('A').syncAll()
const code3 = A.sync.codes[T3.id]
ok(/^[A-Z0-9]{6}$/.test(code3 || ''), '新行程拿到分享码 ' + code3)

/**
 * 以**指定设备自己的 backend 实例**打推送接口并只取状态码。
 *
 * 用 doc:null 是为了让权限判定成为唯一可能的结果 —— 权限检查与文档内容无关，
 * 带上文档只会把「文档不合法 → 400」混进来。
 * 令牌来自 `store.api()` 的 token 回调（实例各自闭包，见 as() 里的说明）：
 * 这里**必须**传 store 而不是复用某个全局 client，否则 403 断言测的是脚手架而不是产品。
 */
const pushStatus = (store: AnyStore) =>
  store
    .api()
    .pushSpace(T3.id, { author: '谁', deviceId: 'dev_x', baseRev: null, doc: null, tombstones: [] })
    .then(() => 200)
    .catch((e: { status?: number }) => e?.status ?? 0)

// 11.5 其它设备（未登录）写不进去
as('B')
ok((await pushStatus(B)) === 403, '未登录设备写入有主行程 → 403')

// 11.5.1 隔离机制本身：A 登录不允许让别的实例「连带登录」。
// 这是把「模块级令牌单例」钉死的断言 —— 若令牌回到全局可变状态，
// B 的请求会带上 A 的令牌，上一条就会变成 200。
ok(A.api() !== B.api() && A.api() !== C.api(), '每个 store 实例各持一份 backend 客户端')

// 11.6 B 登录了但还不是成员 → 依然 403
await as('B').login()
ok(B.isLoggedIn(), 'B 也登录成功（两台设备两个身份）')
ok(B.sync.identity?.openid !== A.sync.identity?.openid, '两台设备的 openid 不同')
ok((await pushStatus(B)) === 403, '登录了但还不是成员 → 403（身份 ≠ 权限）')

// 11.7 列表按身份隔离
await as('B').pullAll()
ok(!B.trips.some((t) => t.id === T3.id), 'B 的列表里没有 A 未分享的行程')
await as('A').pullAll()
ok(A.trips.some((t) => t.id === T3.id), 'A 的列表里有自己的行程')

// 11.8 凭码加入 → 成为成员 → 能写
const joined3 = await as('B').joinByCode(String(code3))
ok(joined3.id === T3.id, 'B 凭码加入成功')
ok((await pushStatus(B)) === 200, '加入后 B 能写了')
await as('A').pullAll()
ok(A.trips.some((t) => t.id === T3.id), 'A 那边行程仍在（加入只增加成员，不改归属）')

// 11.9 认领：把「登录之前建的」行程纳入账号体系
as('C')
const T4 = C.createTrip({
  title: '登录前建的',
  destination: '长沙',
  startDate: '2027-02-01',
  endDate: '2027-02-02',
  budget: 300,
  memberNames: ['我']
})
await as('C').syncAll()
const code4 = C.sync.codes[T4.id]
ok(/^[A-Z0-9]{6}$/.test(code4 || ''), '未登录也能建行程并拿到分享码 ' + code4)
ok(!C.isLoggedIn(), 'C 仍未登录（这个行程因此没有归属）')

await as('A').claimTrip(T4.id, String(code4))
ok(A.trips.some((t) => t.id === T4.id), '认领后该行程出现在 A 的本地（认领会顺带拉一次）')

as('C')
const anonAfterClaim = await C.api()
  .pushSpace(T4.id, { author: 'x', deviceId: 'dev_c', baseRev: null, doc: null, tombstones: [] })
  .then(() => 200)
  .catch((e: { status?: number }) => e?.status ?? 0)
ok(anonAfterClaim === 403, '认领后原来的匿名创建者写不动了（权限模型已从「谁知道 id」切到「只有成员」）')

// 11.9.5 批量认领：claimAllLocal —— SyncPage「批量认领已有行程」入口的数据层。
//
// 关键点：服务端没有只读的归属查询，**认领本身就是探针** —— 200 = 原本无主这次
// 归到你名下，409 = 已有归属（自己的或别人的都算）。这两种必须分开报：
// 把 409 当成功会让用户以为「都认领好了」，实际一半是跳过。
as('B')
const TC5 = B.createTrip({
  title: '登录后建的',
  destination: '苏州',
  startDate: '2027-03-01',
  endDate: '2027-03-02',
  budget: 100,
  memberNames: ['我']
})
await as('B').syncAll()
ok(!!B.sync.codes[TC5.id], '登录后建的行程上云拿到分享码（推送时已直接归属）')

as('C')
const TC6 = C.createTrip({
  title: '匿名建的待认领',
  destination: '贵阳',
  startDate: '2027-04-01',
  endDate: '2027-04-02',
  budget: 120,
  memberNames: ['我']
})
await as('C').syncAll()
ok(!!C.sync.codes[TC6.id] && !C.isLoggedIn(), 'C 匿名上云的行程无归属（批量认领的目标）')

as('B')
await B.pullAll()
ok(B.trips.some((t) => t.id === TC6.id), '无主行程对登录用户可见（我参与 ∪ 无主）')
ok(!!B.sync.codes[TC6.id], 'B 拉到了无主行程的分享码（认领凭证随之到位）')

const claimRes = await B.claimAllLocal()
const r6 = claimRes.find((r) => r.id === TC6.id)
ok(r6?.outcome === 'claimed', '无主行程被批量认领（claimed）')
const r5 = claimRes.find((r) => r.id === TC5.id)
ok(r5?.outcome === 'owned', '本就属于自己的行程 → owned（409 跳过，不混进成功里）')
ok(claimRes.every((r) => r.outcome !== 'failed'), '没有任何失败被混进结果')
ok(B.trips.some((t) => t.id === TC6.id), '认领后行程仍在 B 本地（pullAll 顺带刷新）')

const claimRes2 = await B.claimAllLocal()
ok(claimRes2.length > 0 && claimRes2.every((r) => r.outcome === 'owned'), '重复批量认领幂等：全部 owned')

as('C')
const cAfterBatch = await C.api()
  .pushSpace(TC6.id, { author: 'x', deviceId: 'dev_c', baseRev: null, doc: null, tombstones: [] })
  .then(() => 200)
  .catch((e: { status?: number }) => e?.status ?? 0)
ok(cAfterBatch === 403, '批量认领后原匿名创建者写不动了（归属已落到 B）')

// 11.10 登出：本地清干净（服务端无状态，没有会话要清）
as('A').logout()
ok(!A.isLoggedIn(), '登出后不再是登录态')
ok((A.sync.identity ?? null) === null, '登出后内存里的身份被清掉')
ok(JSON.parse(mock.read('A', 'travel_sync_v1')).identity == null, '登出后落盘的也不再有身份')
ok((storage.readSync().identity ?? null) === null, '登出后读回来的也是空的')

// 11.11 登录失败必须能看见（不能静默吞掉，否则表现为「点了没反应」）
mock.setLoginFail(true)
let loginErr: unknown = null
try {
  await as('C').login()
} catch (e) {
  loginErr = e
}
mock.setLoginFail(false)
ok(loginErr instanceof Error, 'uni.login 失败会抛错')
ok(loginErrorText(loginErr).length > 0, '有给用户看的失败文案', loginErrorText(loginErr))
ok(!C.isLoggedIn(), '登录失败后 C 仍是未登录状态')

// ═══════════════════ [12] 实时同步（WebSocket）═══════════════════
//
// 这一段的重点是**「不调用 syncAll，本地也会变」**：实时通道如果只是
// 「连上了但没接到 store 上」，所有断言都还是会绿 —— 所以核心用例必须
// 完全靠等待本地状态自己变化，而不是靠主动同步。
section('[12] 实时层：纯函数')

ok(toWsUrl('http://localhost:8787', '/api/ws') === 'ws://localhost:8787/api/ws', 'http → ws')
ok(
  toWsUrl('https://api.example.com/', '/api/ws') === 'wss://api.example.com/api/ws',
  'https → wss，并去掉多余的尾斜杠',
  toWsUrl('https://api.example.com/', '/api/ws')
)
ok(toWsUrl('wss://a.b/', '/ws') === 'wss://a.b/ws', '已经是 ws/wss 就不重复转换')

{
  // 抖动取中点（rand=0.5）时应当等于理论值，用来把「指数增长」与「抖动」分开验
  const mid = () => 0.5
  ok(backoffDelay(0, 1000, 30000, mid) === 1000, '第 0 次退避 = base', backoffDelay(0, 1000, 30000, mid))
  ok(backoffDelay(3, 1000, 30000, mid) === 8000, '指数增长（2^3）', backoffDelay(3, 1000, 30000, mid))
  ok(backoffDelay(20, 1000, 30000, mid) === 30000, '被上限夹住（不会退避到几小时）', backoffDelay(20, 1000, 30000, mid))
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < 300; i += 1) {
    const d = backoffDelay(2, 1000, 30000)
    min = Math.min(min, d)
    max = Math.max(max, d)
  }
  ok(min >= 3200 && max <= 4800, '抖动落在 ±20% 内（避免多端同时重连撞成同步波）', { min, max })
  ok(backoffDelay(0, 1000, 30000, () => 0) >= 500, '抖动不会把延迟压成 0（否则会变成忙等）')
}

/** 轮询等待某个条件成立；超时返回 false 而不是抛错，方便在断言里报出实际值 */
async function waitFor(pred: () => boolean, ms = 6000, step = 60): Promise<boolean> {
  const end = Date.now() + ms
  for (;;) {
    if (pred()) return true
    if (Date.now() >= end) return false
    await new Promise((r) => setTimeout(r, step))
  }
}

const titleOf = (store: AnyStore, id: string): string =>
  store.trips.find((t) => t.id === id)?.title || ''

section('[12] 实时通道：连接与订阅')
await as('A').login()
ok(A.isLoggedIn(), 'A 登录')
as('A').startRealtime()
ok(await waitFor(() => A.realtime.status === 'online'), '实时通道连上（status=online）', A.realtime.status)
ok(String(A.realtime.connId).startsWith('ws-'), '拿到服务端分配的连接 id', A.realtime.connId)
ok(A.realtimeStatusText === '实时已连接', '状态文案正确', A.realtimeStatusText)

// A 建一个行程推上去（这一步会把它纳入订阅集合）
as('A')
const T5 = A.createTrip({
  title: '实时共享',
  destination: '西安',
  startDate: '2027-03-01',
  endDate: '2027-03-02',
  budget: 800,
  memberNames: ['我', '阿哲']
})
await as('A').syncAll()
const code5 = String(A.sync.codes[T5.id] || '')
ok(/^[A-Z0-9]{6}$/.test(code5), 'A 拿到分享码 ' + code5)

await as('B').login()
const joined5 = await as('B').joinByCode(code5)
ok(joined5.id === T5.id, 'B 凭码加入')
as('B').startRealtime()
ok(await waitFor(() => B.realtime.status === 'online'), 'B 的实时通道也连上', B.realtime.status)

section('[12] B 一改，A 不做任何动作就看到了 ★')
as('B')
B.updateTrip(T5.id, { title: '由 B 改的' })
await as('B').syncAll()

as('A')
const sawB = await waitFor(() => titleOf(A, T5.id) === '由 B 改的')
ok(sawB, 'A 没调 syncAll、没切前台，本地标题就变了 ★', titleOf(A, T5.id))
ok(A.realtime.lastEventAt > 0, '记下了实时事件时间（可用于「上次活动」展示）', A.realtime.lastEventAt)
ok(A.sync.lastStatus === 'ok', 'A 自己那次同步仍是 ok（实时拉取不改同步状态）', A.sync.lastStatus)

section('[12] 断线期间的改动靠 rev 比对补上 ★')
as('A').stopRealtime()
ok(A.realtime.status === 'stopped', 'A 断开实时通道')

as('B')
B.updateTrip(T5.id, { title: 'B 断线期间的改动' })
await as('B').syncAll()
await new Promise((r) => setTimeout(r, 600))

as('A')
ok(titleOf(A, T5.id) === '由 B 改的', '断线期间 A 的本地没变（说明上一条结论确实来自实时通道）', titleOf(A, T5.id))

// 重连：服务端在 subscribed 里带回当前 rev，与本地 revOf 对不上 → 补拉。
// 这条路径是「通知会丢」这件事的兜底，必须能独立work。
as('A').startRealtime()
ok(
  await waitFor(() => titleOf(A, T5.id) === 'B 断线期间的改动'),
  '重连后自动补拉了断线期间的改动 ★（通知丢了也不影响最终一致）',
  titleOf(A, T5.id)
)
ok(
  A.sync.revOf[T5.id] === B.sync.revOf[T5.id],
  '两边 rev 重新对齐',
  { a: A.sync.revOf[T5.id], b: B.sync.revOf[T5.id] }
)

section('[12] 删除也要实时传播 ★')
as('B')
B.removeTrip(T5.id)
await as('B').syncAll()
as('A')
ok(
  await waitFor(() => !A.trips.some((t) => t.id === T5.id)),
  'A 收到删除通知后本地那份也消失了 ★（不会留着一份别人已经删掉的行程）',
  A.trips.filter((t) => t.id === T5.id).length
)

section('[12] 登出后收不到别人的改动（权限跟着身份走）')
as('A')
const T6 = A.createTrip({
  title: '登出后不该收到',
  destination: '昆明',
  startDate: '2027-04-01',
  endDate: '2027-04-02',
  budget: 500,
  memberNames: ['我']
})
await as('A').syncAll()
const code6 = String(A.sync.codes[T6.id] || '')
await as('B').joinByCode(code6)
as('B').startRealtime()
await waitFor(() => B.realtime.status === 'online')

// A 登出 → 变成匿名 → 有主空间不再给它订阅（服务端按 acl 拒掉）。
// 这里把服务端的订阅回执记下来：**这条断言必须能区分「服务端拒了」与「客户端漏了」**，
// 否则一旦失败根本不知道该查哪一侧。
const subLog: Array<{ accepted: string[]; denied: string[] }> = []
const origOnSub = A.onRealtimeSubscribed.bind(A)
A.onRealtimeSubscribed = (acc, den) => {
  subLog.push({
    accepted: acc.map((s) => s.id),
    denied: den.map((d) => d.id + ':' + d.reason)
  })
  return origOnSub(acc, den)
}
as('A').logout()
ok(await waitFor(() => A.realtime.status === 'online'), '登出后实时通道重新握手并连上', A.realtime.status)
ok(!A.isLoggedIn(), 'A 已不在登录态')
// ⚠️ 必须轮询：ready 帧（status=online）先到，订阅回执（subscribed/denied）
// 要等一个「发 sub → 服务端 ACL → 回帧」的往返，紧跟着 online 同步读 subLog
// 会读到空 —— 偶发报红（实测约 50%），与权限判定是否生效无关，纯属时序。
ok(
  await waitFor(() => subLog.some((s) => s.denied.includes(T6.id + ':anonymous-on-owned'))),
  '服务端明确拒掉了 T6 的订阅（anonymous-on-owned）',
  subLog
)

const evBefore = A.realtime.lastEventAt
as('B')
B.updateTrip(T6.id, { title: 'B 在 A 登出后改的' })
await as('B').syncAll()
await new Promise((r) => setTimeout(r, 2000))
ok(
  A.realtime.lastEventAt === evBefore,
  'A 登出后不再收到有主空间的**实时通知** ★',
  { before: evBefore, after: A.realtime.lastEventAt }
)
// 诚实记录边界：匿名口径收紧后（listSpaces 匿名只返回无主空间），登出者的
// 「主动同步」也拉不到有主空间的更新了 —— 服务端没有身份，无从判定「这是你的行程」。
// 本地副本保留（离线可用），但停留在登出那一刻的内容。仍开放的只剩
// 「按 id 直接读取」（GET /api/trips/:id 不做机密性保证，见 routes/trips.mjs 注释）。
await as('A').syncAll()
ok(
  titleOf(A, T6.id) === '登出后不该收到',
  '登出后主动同步不再更新有主空间的本地副本（匿名列表只含无主空间）',
  titleOf(A, T6.id)
)

// 但 A 仍能以匿名身份收**无主空间**的通知（兼容口径：存量数据不该突然收不到）
as('C')
const T7 = C.createTrip({
  title: '无主行程',
  destination: '兰州',
  startDate: '2027-05-01',
  endDate: '2027-05-02',
  budget: 200,
  memberNames: ['我']
})
await as('C').syncAll()
ok(!!C.sync.codes[T7.id], 'C 把它推上去了（拿到分享码 ' + C.sync.codes[T7.id] + '）')

// 轮询而不是「拉一次就必须看到」：这条断言要表达的是**最终可见**，
// 写成一次性检查就变成在赌「拉取和推送之间没有别的时序」，会偶发报红。
as('A')
let visible = false
for (let i = 0; i < 12 && !visible; i += 1) {
  await as('A').pullAll()
  visible = A.trips.some((t) => t.id === T7.id)
  if (!visible) await new Promise((r) => setTimeout(r, 200))
}
ok(visible, 'A 能看到这个无主行程（它在 A 的订阅集合里）', A.trips.map((t) => t.id))

as('C')
C.updateTrip(T7.id, { title: '无主行程·改' })
await as('C').syncAll()
ok(
  await waitFor(() => titleOf(A, T7.id) === '无主行程·改'),
  '无主空间的改动，匿名的 A 仍能实时收到 ★（兼容口径与 REST 一致）',
  titleOf(A, T7.id)
)

// 收尾：把实时通道关掉，别让 Node 进程被长连接挂住
as('A').stopRealtime()
as('B').stopRealtime()
ok(A.realtime.status === 'stopped' && B.realtime.status === 'stopped', '停止后状态回到 stopped')

console.log(`\n===== 客户端同步结果：${pass} 通过 / ${fail} 失败 =====\n`)
process.exit(fail ? 1 : 0)
