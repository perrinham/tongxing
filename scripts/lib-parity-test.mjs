/**
 * 孪生实现一致性测试：server/lib/*.mjs（自托管参考实现）vs cloudfunctions/_lib/*.js（云函数）。
 *
 * 为什么需要它：HLC / LWW 合并 / ACL 这三块逻辑在仓库里各有两个实现 —— 一份跑在
 * 自托管后端，一份跑在云函数里。文件头都写着「孪生文件，语义必须严格一致」，但
 * 一致性此前只靠注释和肉眼维持：cloud:smoke 只覆盖了「结果对不对」，没有覆盖
 * 「两张实现是否给出同一个结果」。一旦漂移，症状是「云端和自托管对同一份数据
 * 算出不同的胜负」——静默、难查，且方向不定（可能是数据被覆盖，也可能是越权）。
 *
 * 做法：这些模块都是纯函数（不依赖数据库 / wx-server-sdk），所以可以在同一个进程里
 * 同时 import 两份实现，喂同一批语料（含边界：缺 hlc、陈旧 fhlc、时钟超前、t/c 上限、
 * 非法节点字符、超长字段表……），逐项比对返回值的深比较结果。
 *
 * 用法：npm run lib:parity
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))

const serverHlc = await import(new URL('../server/lib/hlc.mjs', import.meta.url))
const serverLww = await import(new URL('../server/lib/lww.mjs', import.meta.url))
const serverAcl = await import(new URL('../server/lib/acl.mjs', import.meta.url))

// ⚠️ 取的是**分发副本**（cloudfunctions/<fn>/_lib/）而不是唯一源 cloudfunctions/_lib/：
//    源目录的最近 package.json 是仓库根（"type": "module"），Node 会把它当 ESM 加载而
//    报 `require is not defined`；函数目录下有各自的 package.json（CJS），副本才能被
//    require。反正真正部署上云的就是副本，比对着它测更贴近事实。
//    （脚本前置 `cloud:sync-lib` 保证副本是最新的，见 package.json。）
const cloudHlc = require(resolve(root, 'cloudfunctions/trips/_lib/hlc.js'))
const cloudLww = require(resolve(root, 'cloudfunctions/trips/_lib/lww.js'))
const cloudAcl = require(resolve(root, 'cloudfunctions/trips/_lib/acl.js'))

let passed = 0
const failures = []

function eq(label, a, b) {
  try {
    assert.deepEqual(a, b)
    passed += 1
  } catch {
    failures.push(`${label}\n      server: ${JSON.stringify(a)}\n      cloud : ${JSON.stringify(b)}`)
    console.error(`  ✗ ${label}\n      server: ${JSON.stringify(a)}\n      cloud : ${JSON.stringify(b)}`)
  }
}

// ───────────────────────── HLC ─────────────────────────

console.log('· hlc（编码 / 比较 / 封顶 / 记录级时间戳）')

const NOW = 1_790_000_000_000
const HLC_CASES = [
  ['undefined', undefined],
  ['null', null],
  ['0 数字', 0],
  ['空对象', {}],
  ['只有 t=0', { t: 0 }],
  ['t 无 c/n', { t: 1 }],
  ['t+c', { t: 1, c: 1 }],
  ['t+c+n', { t: 1, c: 1, n: 'ab' }],
  ['负值', { t: -5, c: -1, n: '' }],
  ['字符串数字', { t: '123', c: '2', n: 123 }],
  ['NaN', { t: NaN, c: NaN, n: null }],
  ['小数', { t: 1.7, c: 2.9, n: 'ZZZZZZZZ' }],
  ['t 上限', { t: 999_999_999_999_999, c: 999_999, n: 'ffffffff' }],
  ['非 ascii 节点', { t: 1, c: 2, n: '我' }],
  ['子串数字', { t: '0x10', c: '1e3', n: 'gg' }],
  ['正常', { t: NOW, c: 5, n: 'deadbeef' }]
]

for (const [label, raw] of HLC_CASES) {
  eq(`normHlc(${label})`, serverHlc.normHlc(raw, 0), cloudHlc.normHlc(raw, 0))
  eq(`normHlc(${label}, fallback)`, serverHlc.normHlc(raw, 4242), cloudHlc.normHlc(raw, 4242))
  eq(`hlcTimeOf(${label})`, serverHlc.hlcTimeOf(raw), cloudHlc.hlcTimeOf(raw))
  eq(
    `recordHlc(${label})`,
    serverHlc.recordHlc(raw, NOW - 1000),
    cloudHlc.recordHlc(raw, NOW - 1000)
  )
  eq(`capHlc(${label})`, serverHlc.capHlc(raw, NOW, 60_000), cloudHlc.capHlc(raw, NOW, 60_000))
  eq(`encodeHlc(${label})`, serverHlc.encodeHlc(raw), cloudHlc.encodeHlc(raw))
  const enc = serverHlc.encodeHlc(raw)
  eq(`decodeHlc(encode(${label}))`, serverHlc.decodeHlc(enc), cloudHlc.decodeHlc(enc))
  eq(`hlcFromTs(${label})`, serverHlc.hlcFromTs(raw), cloudHlc.hlcFromTs(raw))
}

for (let i = 0; i < HLC_CASES.length; i += 1) {
  for (let j = 0; j < HLC_CASES.length; j += 1) {
    const a = HLC_CASES[i][1]
    const b = HLC_CASES[j][1]
    const key = `${HLC_CASES[i][0]} vs ${HLC_CASES[j][0]}`
    eq(`cmpHlc(${key})`, serverHlc.cmpHlc(a, b), cloudHlc.cmpHlc(a, b))
    eq(`hlcAfter(${key})`, serverHlc.hlcAfter(a, b), cloudHlc.hlcAfter(a, b))
  }
}

for (const [label, raw] of HLC_CASES) {
  eq(`nodeKey(${label})`, serverHlc.nodeKey(raw && raw.n), cloudHlc.nodeKey(raw && raw.n))
}

// createHlc：观察序列 + 自产时间戳（比较 peek 出来的 (t,c)，n 由 nodeKey 保证同源）
{
  const seq = [
    { t: 1, c: 0, n: 'aaaaaaaa' },
    { t: NOW + 10 * 60 * 1000, c: 3, n: 'bbbbbbbb' }, // 明显超前
    { t: NOW, c: 9, n: 'cccccccc' },
    { t: NOW, c: 9, n: 'dddddddd' }, // 同 t 同 c，比 n
    { t: NOW - 5000, c: 0, n: 'eeeeeeee' } // 更旧
  ]
  const a = serverHlc.createHlc({ node: 'parity-node', maxSkewMs: 60_000 })
  const b = cloudHlc.createHlc({ node: 'parity-node', maxSkewMs: 60_000 })
  eq('createHlc node', a.node, b.node)
  eq('createHlc maxSkewMs', a.maxSkewMs, b.maxSkewMs)
  for (const raw of seq) {
    eq(`createHlc observe(${JSON.stringify(raw)})`, a.observe(raw), b.observe(raw))
  }
  eq('createHlc peek 一致', a.peek(), b.peek())
  eq('createHlc stamp 的 n 一致', a.stamp().n, b.stamp().n)
  const sa = a.stamp()
  const sb = b.stamp()
  eq('createHlc stamp c 一致', sa.c, sb.c)
  eq('createHlc stamp 单调', sa.t >= a.peek().t, sb.t >= b.peek().t)
}

// ───────────────────────── LWW ─────────────────────────

console.log('· lww（字段级合并 / 记录级 hlc 戳）')

const rec = (over = {}) => ({
  id: 'r1',
  tripId: 't1',
  updatedAt: 1000,
  title: '甲',
  note: '',
  ...over
})

const LWW_CASES = [
  ['无 base', null, rec()],
  ['无 base + 无 hlc', null, { id: 'r1', title: '甲' }],
  ['同一条', rec(), rec()],
  ['incoming 更新', rec(), rec({ updatedAt: 2000, hlc: { t: 2000, c: 0, n: 'aaaa' } })],
  ['incoming 更旧', rec({ hlc: { t: 2000, c: 0, n: 'aaaa' } }), rec({ updatedAt: 1500 })],
  ['不同字段各改一边', rec({ hlc: { t: 1000, c: 0, n: 'aaaa' }, fhlc: { title: { t: 1000, c: 0, n: 'aaaa' }, note: { t: 1000, c: 0, n: 'aaaa' } } }), rec({ updatedAt: 2000, hlc: { t: 2000, c: 0, n: 'bbbb' }, fhlc: { note: { t: 2000, c: 0, n: 'bbbb' } } })],
  ['陈旧 hlc（updatedAt 更新）', rec({ hlc: { t: 1, c: 0, n: 'aaaa' } }), rec({ updatedAt: 9999 })],
  ['同 t 同 c 比 n', rec({ hlc: { t: 500, c: 1, n: 'aaaaaaaa' } }), rec({ hlc: { t: 500, c: 1, n: 'bbbbbbbb' } })],
  ['元数据键不参与合并', rec({ hlc: { t: 1, c: 0, n: 'aaaa' } }), { id: 'r1', tripId: 't1', updatedAt: 5000, hlc: { t: 5000, c: 0, n: 'bbbb' }, title: '乙' }],
  ['incoming 字段更少', rec(), { id: 'r1', updatedAt: 2000, hlc: { t: 2000, c: 0, n: 'bbbb' } }]
]

// 超长字段表（> MAX_MERGE_FIELDS）
const wide = {}
for (let i = 0; i < 60; i += 1) wide[`f${i}`] = i
LWW_CASES.push(['60 字段', { id: 'r1', updatedAt: 1, ...wide }, { id: 'r1', updatedAt: 2, ...wide }])

for (const [label, base, incoming] of LWW_CASES) {
  eq(`dataKeysOf(${label})`, serverLww.dataKeysOf(base), cloudLww.dataKeysOf(base))
  eq(`fieldHlcsOf(base ${label})`, serverLww.fieldHlcsOf(base), cloudLww.fieldHlcsOf(base))
  eq(
    `mergeRecord(${label})`,
    serverLww.mergeRecord(base, incoming),
    cloudLww.mergeRecord(base, incoming)
  )
  const cap = (h) => serverHlc.capHlc(h, NOW, 60_000)
  const capC = (h) => cloudHlc.capHlc(h, NOW, 60_000)
  eq(
    `mergeRecord(封顶 ${label})`,
    serverLww.mergeRecord(base, incoming, cap),
    cloudLww.mergeRecord(base, incoming, capC)
  )
  eq(
    `withRecordHlc(${label})`,
    serverLww.withRecordHlc({ a: 1 }, { a: { t: 1, c: 0, n: 'aaaa' } }),
    cloudLww.withRecordHlc({ a: 1 }, { a: { t: 1, c: 0, n: 'aaaa' } })
  )
}

// ───────────────────────── ACL ─────────────────────────

console.log('· acl（有主 / 无主判定）')

function fakeDb(members = {}, roles = {}) {
  return {
    memberCountOf: (id) => members[id] || 0,
    memberRoleOf: (id, openid) => roles[`${id}:${openid}`] || ''
  }
}

const ACL_CASES = [
  ['空间不存在', fakeDb(), null, ''],
  ['无主空间 + 匿名', fakeDb(), { id: 's1', ownerOpenid: '' }, ''],
  ['无主空间 + 登录', fakeDb(), { id: 's1', ownerOpenid: '' }, 'openid-A'],
  ['有主的空间 + 匿名', fakeDb(), { id: 's1', ownerOpenid: 'openid-A' }, ''],
  ['owner 本人', fakeDb(), { id: 's1', ownerOpenid: 'openid-A' }, 'openid-A'],
  ['成员', fakeDb({}, { 's1:openid-B': 'member' }), { id: 's1', ownerOpenid: 'openid-A' }, 'openid-B'],
  ['非成员', fakeDb(), { id: 's1', ownerOpenid: 'openid-A' }, 'openid-X'],
  ['owner 列为空但有成员', fakeDb({ s1: 1 }, { 's1:openid-B': 'member' }), { id: 's1', ownerOpenid: '' }, 'openid-X']
]

for (const [label, db, space, openid] of ACL_CASES) {
  eq(`spaceHasOwner(${label})`, serverAcl.spaceHasOwner(db, space), cloudAcl.spaceHasOwner(db, space))
  eq(`accessVerdict(${label})`, serverAcl.accessVerdict(db, space, openid), cloudAcl.accessVerdict(db, space, openid))
}

// ───────────────────────── 汇总 ─────────────────────────

console.log('')
if (failures.length) {
  console.error(`lib:parity 失败：${failures.length} 项不一致（一致 ${passed} 项）`)
  process.exit(1)
}
console.log(`lib:parity 全部一致（${passed} 项比对：hlc / lww / acl 孪生实现）`)
