/**
 * 云函数冒烟测试：用**内存版 wx-server-sdk** 驱动 cloudfunctions/ 里的真实云函数，
 * 验证移植后的合并语义与自托管参考实现一致。
 *
 * 为什么需要它：云函数路径要连真实云环境（用户手动上传）才能跑，而 trips 的
 * 实体 LWW / 墓碑 / 字段级合并是这次迁移里风险最高的一块。这里用一个极小的
 * 内存数据库替换 wx-server-sdk 的 database()，把 `require('wx-server-sdk')` 劫持掉，
 * 就能在本地跑通 push/join/claim/LWW/墓碑/攻略归属 等核心断言。
 *
 * 用法：npm run cloud:smoke
 *
 * ⚠️ 覆盖范围：只测「云函数逻辑 + 存储交互」；不测真机 wx.cloud 调用链
 * （那是 scripts/mp-walk.mjs 的活）。也不替代 client:smoke/city:smoke（它们走 HTTP）。
 */

import assert from 'node:assert/strict'
import Module from 'node:module'
import { createRequire } from 'node:module'

// ───────────────────────── 内存版 wx-server-sdk ─────────────────────────

const collections = new Map() // name -> Map(id -> doc)
let currentOpenid = ''

function collOf(name) {
  if (!collections.has(name)) collections.set(name, new Map())
  return collections.get(name)
}

function matchCond(doc, cond) {
  return Object.keys(cond || {}).every((k) => doc[k] === cond[k])
}

/**
 * 真云数据库的查询上限：服务端 SDK 单次最多 1000 条；**不写 limit 时默认只有 100 条**。
 * 早期版本这里把 limit 实现成了空操作、get 直接返回整表 —— 于是本地怎么测都是绿的，
 * 「单次只读一页」把大空间的记录静默截断这种事根本暴露不出来。现在按真实语义实现。
 */
const QUERY_MAX = 1000
const QUERY_DEFAULT = 100

function makeQuery(name, cond) {
  const state = { cond: cond || {}, limit: null, skip: 0 }
  const rows = () => [...collOf(name).values()].filter((d) => matchCond(d, state.cond))
  const q = {
    where(next) {
      state.cond = next || {}
      return q
    },
    orderBy(field, dir) {
      state.order = { field, dir: dir === 'desc' ? -1 : 1 }
      return q
    },
    limit(n) {
      state.limit = n
      return q
    },
    skip(n) {
      state.skip = n
      return q
    },
    async get() {
      const size = Math.min(state.limit == null ? QUERY_DEFAULT : state.limit, QUERY_MAX)
      let all = rows()
      if (state.order) {
        const { field, dir } = state.order
        all = [...all].sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * dir)
      }
      return { data: all.slice(state.skip, state.skip + size) }
    },
    async count() {
      return { total: rows().length }
    },
    async remove() {
      // 单次批量删除同样有 1000 条上限（真实环境如此），所以这里也只删一页 ——
      // 调用方 store.js 的 whereRemove 必须靠循环才能删干净。
      const ids = rows()
        .map((d) => d._id)
        .slice(0, QUERY_MAX)
      for (const id of ids) collOf(name).delete(id)
      return { stats: { removed: ids.length } }
    }
  }
  return q
}

const fakeDb = {
  async createCollection(name) {
    if (collections.has(name)) {
      // 真实环境「集合已存在」的报错形态并不统一：有时只给 errCode、有时只给 errMsg。
      // 这里两种都造出来，逼 ensureCollection 的双判分支都被跑到
      // （最初只判 errCode，真机部署第二次 setup 就 500 了）。
      const e = new Error(name === 'spaces' ? 'already exists' : 'collection already exists')
      if (name === 'spaces') e.errCode = -502005
      throw e
    }
    collOf(name)
  },
  collection(name) {
    const q = makeQuery(name, null)
    q.doc = (id) => ({
      async get() {
        const d = collOf(name).get(id)
        if (!d) {
          const e = new Error('document not exists')
          e.errCode = -502004
          throw e
        }
        return { data: { ...d } }
      },
      async set({ data }) {
        const { _id, ...rest } = data || {}
        collOf(name).set(id, { _id: id, ...rest })
      },
      async remove() {
        if (!collOf(name).has(id)) {
          const e = new Error('document not exists')
          e.errCode = -502004
          throw e
        }
        collOf(name).delete(id)
      }
    })
    return q
  }
}

const fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
  init() {},
  database() {
    return fakeDb
  },
  getWXContext() {
    return { OPENID: currentOpenid }
  }
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeSdk
  return origLoad.call(this, request, parent, isMain)
}

const require = createRequire(import.meta.url)
const trips = require('../cloudfunctions/trips/index.js')
const guides = require('../cloudfunctions/guides/index.js')
const auth = require('../cloudfunctions/auth/index.js')
const weather = require('../cloudfunctions/weather/index.js')

// ───────────────────────── 断言脚手架 ─────────────────────────

let passed = 0
const failures = []

function ok(cond, label) {
  if (cond) {
    passed += 1
    return true
  }
  failures.push(label)
  console.error('  ✗ ' + label)
  return false
}

function eq(actual, expected, label) {
  try {
    assert.deepEqual(actual, expected)
    passed += 1
    return true
  } catch {
    failures.push(label)
    console.error(`  ✗ ${label}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`)
    return false
  }
}

async function call(fn, event, openid = '') {
  currentOpenid = openid
  return fn.main(event)
}

function isErr(res) {
  return !!(res && res.e)
}

const NOW = Date.now()
const tripDoc = (over = {}) => ({
  trip: {
    title: '成都三日',
    destination: '成都',
    startDate: '2026-09-20',
    endDate: '2026-09-22',
    currency: '¥',
    budget: 1000,
    memberIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over
  },
  members: [],
  days: [],
  items: [],
  expenses: [],
  polls: [],
  votes: [],
  meetups: [],
  locations: []
})

// ───────────────────────── auth ─────────────────────────

console.log('· auth')
{
  const login = await call(auth, { action: 'wxLogin', code: 'code-1' }, 'openid-A')
  eq(login.openid, 'openid-A', 'auth wxLogin 返回上下文 openid')
  eq(login.token, 'cloud:openid-A', 'auth wxLogin 令牌为 cloud:<openid>')
  ok(login.expiresAt > Date.now(), 'auth wxLogin 令牌未过期')

  const noCode = await call(auth, { action: 'wxLogin' }, 'openid-A')
  eq(noCode.e && noCode.e.status, 400, 'auth wxLogin 缺 code 返回 400')

  const me = await call(auth, { action: 'authMe', token: login.token }, 'openid-A')
  eq(me.openid, 'openid-A', 'auth authMe 返回 openid')

  const meBad = await call(auth, { action: 'authMe' }, 'openid-A')
  eq(meBad.e && meBad.e.status, 401, 'auth authMe 无令牌返回 401')

  const health = await call(auth, { action: 'health' })
  eq(health.ok, true, 'auth health ok')
}

// ───────────────────────── trips：创建 / 列表 / 加入 ─────────────────────────

console.log('· trips 创建与加入')
let code = ''
{
  const first = await call(trips, {
    action: 'push',
    id: 'sp1',
    author: '小明',
    deviceId: 'dev-1',
    baseRev: null,
    doc: tripDoc(),
    tombstones: [],
    loggedIn: false
  })
  ok(!isErr(first), 'trips 匿名创建空间成功')
  ok(typeof first.space.code === 'string' && first.space.code.length >= 4, 'trips 创建后分配分享码')
  code = first.space.code
  eq(first.serverRev, 1, 'trips 创建后 rev=1')
  eq(first.changed, true, 'trips 创建 changed=true')
  ok(first.doc.trip && first.doc.trip.title === '成都三日', 'trips 返回文档含 trip')

  const listAnon = await call(trips, { action: 'list' })
  ok(listAnon.spaces.some((s) => s.id === 'sp1'), 'trips 无主空间对匿名可见')

  const byCode = await call(trips, { action: 'byCode', code })
  eq(byCode.space.id, 'sp1', 'trips byCode 命中')

  const joined = await call(trips, { action: 'join', code, loggedIn: true }, 'openid-A')
  eq(joined.joined, true, 'trips 登录用户 join 成功')

  const memberPush = await call(
    trips,
    { action: 'push', id: 'sp1', author: '阿花', deviceId: 'dev-2', baseRev: first.serverRev, doc: null, tombstones: [], loggedIn: true },
    'openid-A'
  )
  ok(!isErr(memberPush), 'trips 无主空间登录用户可写')

  const stranger = await call(
    trips,
    { action: 'push', id: 'sp1', author: '路人', deviceId: 'dev-3', baseRev: null, doc: tripDoc(), tombstones: [], loggedIn: true },
    'openid-X'
  )
  ok(!isErr(stranger), 'trips 无主空间任何人可写（认领前）')
}

// ───────────────────────── trips：行李清单（trip.packing） ─────────────────────────

console.log('· trips 行李清单')
;{
  // 与 server/smoke.mjs 的同款断言：入库 + 40 上限 + 空标题丢弃 + GET 往返。
  // 用独立的 sp-pk 空间，不搅动后面用例的 rev 连续性。
  // 时间戳用当下的 Date.now()（NOW 是文件头取的常量，NOW+偏移会戳到未来，
  // 让 trip 记录在未来时间上赢过一切墓碑，把「删后又改」判成活记录）。
  const pkTp = Date.now()
  const items = [
    { title: '身份证', group: 'docs', done: false },
    { title: '', group: 'docs' }, // 空标题 → 丢
    { title: '垃圾项', junk: 1 }, // 额外键 → 剥
    ...Array.from({ length: 41 }, (_, i) => ({
      title: `第${i + 1}件`,
      group: 'wear',
      done: i === 0
    }))
  ]
  const pushed = await call(
    trips,
    {
      action: 'push',
      id: 'sp-pk',
      author: '小明',
      deviceId: 'dev-pk',
      baseRev: null,
      doc: tripDoc({ updatedAt: pkTp, packing: { builtAt: NOW, items } }),
      tombstones: [],
      loggedIn: true
    },
    'openid-A'
  )
  ok(!isErr(pushed), 'packing 随 doc 入云成功')
  eq(pushed.doc?.trip?.packing?.items?.length, 40, '云裁剪：43 → 40')
  ok(pushed.doc?.trip?.packing?.items[0]?.title === '身份证', '首项保序')
  ok(!pushed.doc?.trip?.packing?.items.some((x) => !x.title || 'junk' in x), '空标题丢弃、垃圾键剥掉')

  const got = await call(trips, { action: 'get', id: 'sp-pk' }, 'openid-B')
  eq(got.space?.doc?.trip?.packing?.items?.length, 40, 'get 往返后 packing 仍在云上')

  // 旧快照（trip 不带 packing 字段）推回来不能抹掉清单 —— 字段级合并。
  // 另一台设备先凭分享码入伙：云函数孪生认领后有归属权校验，
  // 陌生人直推会被 accessVerdict 打回。
  const joinedPk = await call(trips, { action: 'join', code: pushed.space.code, loggedIn: true }, 'openid-B')
  ok(joinedPk.joined === true, '另一台设备凭分享码加入', JSON.stringify(joinedPk).slice(0, 200))
  const stale = await call(
    trips,
    {
      action: 'push',
      id: 'sp-pk',
      author: '阿花',
      deviceId: 'dev-pk-2',
      baseRev: pushed.serverRev,
      doc: tripDoc({ updatedAt: pkTp - 1_000 }),
      tombstones: [],
      loggedIn: true
    },
    'openid-B'
  )
  ok(!isErr(stale), '旧快照 push 成功')
  eq(stale.doc?.trip?.packing?.items?.length, 40, '旧快照无 packing 字段 → 不抹掉清单（fhlc 比字段）')
}

// ───────────────────────── trips：认领 ─────────────────────────

console.log('· trips 认领与越权')
let claimRev = 0
{
  const claim = await call(trips, { action: 'claim', id: 'sp1', code, loggedIn: true }, 'openid-A')
  eq(claim.ok, true, 'trips 凭码认领成功')
  claimRev = claim.space.rev

  const again = await call(trips, { action: 'claim', id: 'sp1', code, loggedIn: true }, 'openid-B')
  eq(again.e && again.e.status, 409, 'trips 重复认领返回 409')

  const wrongCode = await call(trips, { action: 'claim', id: 'sp1', code: 'ZZZZ99', loggedIn: true }, 'openid-B')
  eq(wrongCode.e && wrongCode.e.status, 403, 'trips 认领码不匹配返回 403')

  const outsider = await call(
    trips,
    { action: 'push', id: 'sp1', author: '路人', deviceId: 'dev-9', baseRev: claimRev, doc: tripDoc(), tombstones: [], loggedIn: true },
    'openid-X'
  )
  eq(outsider.e && outsider.e.status, 403, 'trips 认领后非成员写入被拒 403')

  const anon = await call(trips, {
    action: 'push',
    id: 'sp1',
    author: '路人',
    deviceId: 'dev-9',
    baseRev: claimRev,
    doc: tripDoc(),
    tombstones: [],
    loggedIn: false
  })
  eq(anon.e && anon.e.status, 403, 'trips 认领后匿名写入被拒 403')

  const owner = await call(
    trips,
    { action: 'push', id: 'sp1', author: '小明', deviceId: 'dev-1', baseRev: claimRev, doc: null, tombstones: [], loggedIn: true },
    'openid-A'
  )
  ok(!isErr(owner), 'trips 认领人可写')
}

// ───────────────────────── trips：LWW / 墓碑 ─────────────────────────

console.log('· trips LWW 与墓碑')
{
  const base = await call(trips, { action: 'get', id: 'sp1' }, 'openid-A')
  const rev = base.space.rev

  const oldItem = {
    ...tripDoc(),
    items: [
      {
        id: 'it1',
        dayId: 'd1',
        tripId: 'sp1',
        order: 0,
        time: '09:00',
        type: 'spot',
        title: '旧标题',
        address: '',
        lat: 0,
        lng: 0,
        cost: 0,
        duration: 90,
        note: '',
        done: false,
        updatedAt: NOW - 10000
      }
    ]
  }
  const newer = await call(
    trips,
    { action: 'push', id: 'sp1', author: '小明', deviceId: 'dev-1', baseRev: rev, doc: oldItem, tombstones: [], loggedIn: true },
    'openid-A'
  )
  ok(!isErr(newer), 'trips 推送 item 成功')
  eq(newer.doc.items.length, 1, 'trips item 已写入')
  const rev2 = newer.serverRev

  // 更旧的记录不应覆盖新标题
  const stale = await call(
    trips,
    {
      action: 'push',
      id: 'sp1',
      author: '小明',
      deviceId: 'dev-1',
      baseRev: rev2,
      doc: { ...tripDoc(), items: [{ ...oldItem.items[0], title: '更旧标题', updatedAt: NOW - 20000 }] },
      tombstones: [],
      loggedIn: true
    },
    'openid-A'
  )
  eq(stale.doc.items[0].title, '旧标题', 'trips 更旧记录不覆盖新值（LWW）')

  // 更新的记录覆盖
  const fresh = await call(
    trips,
    {
      action: 'push',
      id: 'sp1',
      author: '小明',
      deviceId: 'dev-1',
      baseRev: stale.serverRev,
      doc: { ...tripDoc(), items: [{ ...oldItem.items[0], title: '新标题', updatedAt: NOW + 10000 }] },
      tombstones: [],
      loggedIn: true
    },
    'openid-A'
  )
  eq(fresh.doc.items[0].title, '新标题', 'trips 更新记录覆盖旧值（LWW）')

  // 墓碑删除
  const del = await call(
    trips,
    {
      action: 'push',
      id: 'sp1',
      author: '小明',
      deviceId: 'dev-1',
      baseRev: fresh.serverRev,
      doc: null,
      tombstones: [{ kind: 'item', id: 'it1', deletedAt: NOW + 20000, hlc: { t: NOW + 20000, c: 0, n: '11111111' } }],
      loggedIn: true
    },
    'openid-A'
  )
  eq(del.doc.items.length, 0, 'trips 墓碑删除 item')
  const rev3 = del.serverRev

  // 旧记录再推不应复活
  const resurrectOld = await call(
    trips,
    { action: 'push', id: 'sp1', author: '小明', deviceId: 'dev-1', baseRev: rev3, doc: { ...tripDoc(), items: [oldItem.items[0]] }, tombstones: [], loggedIn: true },
    'openid-A'
  )
  eq(resurrectOld.doc.items.length, 0, 'trips 墓碑后旧记录不复活')

  // 更新的记录可复活
  const resurrectNew = await call(
    trips,
    {
      action: 'push',
      id: 'sp1',
      author: '小明',
      deviceId: 'dev-1',
      baseRev: resurrectOld.serverRev,
      doc: { ...tripDoc(), items: [{ ...oldItem.items[0], title: '复活', updatedAt: NOW + 30000 }] },
      tombstones: [],
      loggedIn: true
    },
    'openid-A'
  )
  eq(resurrectNew.doc.items.length, 1, 'trips 更新的记录可复活')
}

// ───────────────────────── trips：rotateCode / discover / delete ─────────────────────────

console.log('· trips rotateCode / discover / delete')
{
  const rot = await call(trips, { action: 'rotateCode', id: 'sp1', loggedIn: true }, 'openid-A')
  ok(rot.code && rot.code !== code, 'trips 轮换分享码得到新码')
  const byNew = await call(trips, { action: 'byCode', code: rot.code })
  eq(byNew.space.id, 'sp1', 'trips 新码可访问')
  const byOld = await call(trips, { action: 'byCode', code })
  eq(byOld.space && byOld.space.id, 'sp1', 'trips 旧码在宽限期内仍可访问')

  const rotAnon = await call(trips, { action: 'rotateCode', id: 'sp1' })
  eq(rotAnon.e && rotAnon.e.status, 403, 'trips 匿名轮换码被拒 403')

  const discAnon = await call(trips, { action: 'discover' })
  eq(discAnon.e && discAnon.e.status, 401, 'trips 匿名 discover 返回 401')

  const disc = await call(trips, { action: 'discover', loggedIn: true }, 'openid-A')
  ok(Array.isArray(disc.trips) && disc.trips.some((t) => t.id === 'sp1' && t.mine), 'trips discover 含自己的行程')

  const del = await call(trips, { action: 'delete', id: 'sp1', loggedIn: true }, 'openid-A')
  eq(del.deleted, true, 'trips 删除空间')

  const after = await call(trips, { action: 'byCode', code: rot.code })
  eq(after.e && after.e.status, 404, 'trips 删除后按码 404')

  const list = await call(trips, { action: 'list', active: true, loggedIn: true }, 'openid-A')
  ok(!list.spaces.some((s) => s.id === 'sp1'), 'trips 删除后不在 active 列表')
}

// ───────────────────────── guides ─────────────────────────

console.log('· guides')
{
  const created = await call(
    guides,
    { action: 'upsert', cityName: '成都', author: '小明', status: 'visited', guide: '火锅必吃', rating: 5, visitDate: '2026-09-20', loggedIn: true },
    'openid-A'
  )
  ok(!isErr(created) && created.guide && created.guide.id, 'guides 新建攻略成功')
  ok(!('authorOpenid' in created.guide), 'guides 响应不泄漏 authorOpenid')
  const gid = created.guide.id

  const cities = await call(guides, { action: 'listCities' })
  ok(cities.cities.some((c) => c.name === '成都' && c.guides.length === 1), 'guides listCities 聚合')

  const one = await call(guides, { action: 'cityGuides', cityName: '成都' })
  eq(one.name, '成都', 'guides cityGuides 城市名')
  eq(one.guides.length, 1, 'guides cityGuides 命中 1 条')

  const other = await call(
    guides,
    { action: 'upsert', cityName: '成都', author: '小明', status: 'visited', guide: '改内容', loggedIn: true },
    'openid-B'
  )
  eq(other.e && other.e.status, 403, 'guides 他人同名攻略不可覆盖 403')

  const updOther = await call(guides, { action: 'update', id: gid, payload: { review: '差评' }, loggedIn: true }, 'openid-B')
  eq(updOther.e && updOther.e.status, 403, 'guides 他人攻略不可修改 403')

  const upd = await call(guides, { action: 'update', id: gid, payload: { review: '不错' }, loggedIn: true }, 'openid-A')
  eq(upd.guide.review, '不错', 'guides 本人可修改')

  const mineAnon = await call(guides, { action: 'listMine' })
  eq(mineAnon.e && mineAnon.e.status, 401, 'guides 匿名 listMine 返回 401')

  const mine = await call(guides, { action: 'listMine', loggedIn: true }, 'openid-A')
  eq(mine.guides.length, 1, 'guides listMine 返回本人攻略')

  const delOther = await call(guides, { action: 'delete', id: gid, loggedIn: true }, 'openid-B')
  eq(delOther.e && delOther.e.status, 403, 'guides 他人攻略不可删除 403')

  const retract = await call(guides, { action: 'retract', cityName: '成都', loggedIn: true }, 'openid-A')
  eq(retract.removed, 1, 'guides 按 openid 撤回 1 条')

  const empty = await call(guides, { action: 'cityGuides', cityName: '成都' })
  eq(empty.guides.length, 0, 'guides 撤回后为空')

  // 匿名写入（无 openid）→ 可被匿名按昵称撤回，且不能被他人 openid 认领覆盖
  const anonGuide = await call(guides, { action: 'upsert', cityName: '重庆', author: '游客', status: 'wish', wishNote: '想去', loggedIn: false })
  ok(!isErr(anonGuide), 'guides 匿名可写（旧口径）')
  const claimByOther = await call(
    guides,
    { action: 'upsert', cityName: '重庆', author: '游客', status: 'wish', wishNote: '改', loggedIn: true },
    'openid-C'
  )
  ok(!isErr(claimByOther), 'guides 无主攻略可被登录用户认领')
}

// ───────────────────────── weather（mock） ─────────────────────────

console.log('· weather')
{
  process.env.TX_WEATHER_MOCK = '1'

  const bad = await call(weather, { action: 'weather', place: '', start: '2026-09-20', end: '2026-09-22' })
  eq(bad.e && bad.e.status, 400, 'weather 缺 place 返回 400')

  const badDate = await call(weather, { action: 'weather', place: '成都', start: '2026/09/20', end: '2026-09-22' })
  eq(badDate.e && badDate.e.status, 400, 'weather 非法日期返回 400')

  const badRange = await call(weather, { action: 'weather', place: '成都', start: '2026-09-25', end: '2026-09-20' })
  eq(badRange.e && badRange.e.status, 400, 'weather start>end 返回 400')

  const days = await call(weather, { action: 'weather', place: '成都', start: '2026-09-20', end: '2026-09-22' })
  ok(Array.isArray(days.days), 'weather 返回 days 数组')
  eq(days.source, 'mock', 'weather mock 来源')
  ok(days.days.some((d) => d.code === 63), 'weather mock 序列含雨天码')

  const cached = await call(weather, { action: 'weather', place: '成都', start: '2026-09-20', end: '2026-09-22' })
  eq(cached.days.length, days.days.length, 'weather 命中缓存结果一致')
  delete process.env.TX_WEATHER_MOCK
}

// ───────────────────────── 大空间分页（单次查询 1000 条上限） ─────────────────────────

console.log('· 大空间分页（>1000 条记录）')
{
  // 云数据库单次查询最多 1000 条；而一个空间允许 20000 条记录。
  // 「一次读完」会静默截断，且 push 的 saveSpace 是「先清空 records 再按读到的写回」，
  // 被截断的部分会永久消失。这条用例用 1200 项钉住分页行为。
  const bigId = 'bigspace0001'
  const total = 1200
  const items = Array.from({ length: total }, (_, i) => ({
    id: `i${i}`,
    dayId: 'd1',
    title: `项 ${i}`,
    type: 'spot',
    time: '09:00',
    // 必须带 updatedAt：真实客户端每条记录都有，缺了会被 normDoc 补成 Date.now()，
    // 于是同一份快照重复推送也会「有变化」，rev 一直涨（那是测试数据不真实，不是 bug）。
    updatedAt: NOW - total + i,
    hlc: { t: NOW - total + i, c: 0, n: 'aaaaaaaa' }
  }))
  const doc = { ...tripDoc({ title: '大空间' }), items }

  const pushed = await call(
    trips,
    { action: 'push', id: bigId, author: '甲', deviceId: 'dev-big', baseRev: 0, doc, tombstones: [], loggedIn: true },
    'openid-big'
  )
  ok(!isErr(pushed), '大空间 push 成功')
  eq(pushed.doc.items.length, total, `push 回包含全部 ${total} 项`)
  const bigRecords = [...(collections.get('records') || new Map()).values()].filter(
    (r) => r.space_id === bigId
  ).length
  eq(bigRecords, total + 1, 'records 集合写入该空间的 total+1 条（含 trip 本身）')

  const got = await call(trips, { action: 'get', id: bigId, loggedIn: true }, 'openid-big')
  eq(got.space.doc.items.length, total, `get 读回全部 ${total} 项（翻页，而不是只读一页）`)

  const listed = await call(trips, { action: 'list', withDoc: true, loggedIn: true }, 'openid-big')
  const mine = (listed.spaces || []).find((s) => s.id === bigId)
  eq(mine && mine.doc.items.length, total, `list withDoc 也读回全部 ${total} 项`)

  // 二次 push：saveSpace 先 whereRemove 清空 records（>1000 条，需循环删）再全量重写。
  // 分页 / 批量删除任一失效，这里都会掉数据。
  const again = await call(
    trips,
    { action: 'push', id: bigId, author: '甲', deviceId: 'dev-big', baseRev: pushed.serverRev, doc, tombstones: [], loggedIn: true },
    'openid-big'
  )
  ok(!isErr(again), '大空间二次 push 成功')
  const after = await call(trips, { action: 'get', id: bigId, loggedIn: true }, 'openid-big')
  eq(after.space.doc.items.length, total, '二次 push 后一条不少（清理与重写都要翻页）')
  eq(again.serverRev, pushed.serverRev, '重复推送同一份快照 rev 不涨（幂等）')
}

// ───────────────────────── setup（部署期建集合） ─────────────────────────

console.log('· setup')
{
  // 前面的用例已经把集合建出来了；这里先清空，模拟「刚部署完全新环境」，
  // 否则 created 分支永远跑不到（第一版就是这么漏掉真机那个 bug 的）。
  collections.clear()

  const s1 = await call(trips, { action: 'setup' })
  ok(s1.ok === true && Array.isArray(s1.collections), 'trips setup 返回集合清单')
  eq(s1.collections, ['spaces', 'records', 'tombstones', 'space_members'], 'trips setup 集合名正确')
  eq(s1.detail, {
    spaces: 'created',
    records: 'created',
    tombstones: 'created',
    space_members: 'created'
  }, 'trips setup 首次全部 created')

  // 第二次：集合已存在，且两种报错形态（只有 errCode / 只有 errMsg）都要被判成 exists 而不是抛错
  const s2 = await call(trips, { action: 'setup' })
  ok(s2.ok === true, 'trips setup 可重复调用（幂等）')
  eq(s2.detail, {
    spaces: 'exists',
    records: 'exists',
    tombstones: 'exists',
    space_members: 'exists'
  }, 'trips setup 二次全部 exists（errCode 与 errMsg 两种形态都容错）')

  const g1 = await call(guides, { action: 'setup' })
  eq(g1.collections, ['guides'], 'guides setup 集合名正确')
  eq(g1.detail, { guides: 'created' }, 'guides setup 首次 created')
  const g2 = await call(guides, { action: 'setup' })
  eq(g2.detail, { guides: 'exists' }, 'guides setup 二次 exists')

  for (const name of ['spaces', 'records', 'tombstones', 'space_members', 'guides']) {
    ok(collections.has(name), `setup 后集合存在：${name}`)
  }
}

// ───────────────────────── 汇总 ─────────────────────────

console.log('')
if (failures.length) {
  console.error(`cloud:smoke 失败：${failures.length} 项断言未通过（通过 ${passed} 项）`)
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log(`cloud:smoke 全部通过（${passed} 项断言）`)