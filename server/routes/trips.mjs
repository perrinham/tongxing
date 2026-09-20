/**
 * 行程空间（Trip Space）同步路由。
 *
 * 一个「行程空间」= 一次旅行的全部协作数据：
 *   trip + members + days + items + expenses
 * 同行的人用分享码加入同一个空间，各自在本地改，改完推上来合并。
 *
 * ── 同步模型：按实体的 LWW（last-write-wins）+ 删除墓碑 ──
 *
 * 为什么不用「加锁 / 硬 409 冲突」：
 *   熟人出行场景下多人几乎不会同时改同一条记录，但**离线**很常见（地铁、山区）。
 *   硬冲突会让离线的一方白改。所以选择收敛型合并：
 *
 *   · 每条记录按 id 对齐，updatedAt 大的一方胜 —— 幂等、可重复投递、天然防重复。
 *   · 删除不靠「客户端没带这条」，而靠显式墓碑（tombstone）：
 *     否则 A 删掉的账单会被 B 的旧快照推回来（resurrection）。
 *   · 记录的 updatedAt 晚于墓碑的 deletedAt 时，视为「删后又改」，以改为准。
 *
 * 已知代价（诚实记录）：
 *   1. 同一刻两人改同一条记录，可能只保一份（LWW 的固有代价）。
 *   2. 记录的**删除**与**修改**相撞时，只能整体二选一。
 *
 * ── 字段级合并 ──
 *
 *   每条记录额外带一个 `fhlc: { 字段名: HLC }`，合并时**逐字段**比时间戳，各取较晚的那份。
 *   于是「A 改标题、B 同时改预算」两边都保住 —— 记录级 LWW 做不到这个。
 *   核心实现在 lib/lww.mjs（客户端孪生是 src/services/lww.ts）。
 *   没有 `fhlc` 的记录（老数据 / 老客户端）整体退到记录级 hlc，行为与加这个特性之前一致。
 *
 * ── 时钟：HLC（混合逻辑时钟）──
 *
 *   「谁更新」不再直接比各设备的 Date.now()，而是比各自的 HLC：
 *
 *   · 客户端每次编辑递增自己的 HLC；收到服务端数据时把本地时钟推到对方之后，
 *     于是「看到 A 的改动之后才改的」这件事被编码进时间戳本身 ——
 *     即使 B 的手机慢 10 分钟，B 的改动也一定排在 A 之后。这是纯物理时钟给不了的。
 *   · 服务端再加一道**夹紧**：时间戳超前服务端 `now + MAX_CLOCK_SKEW_MS` 的一律拉回上界，
 *     把「手机时钟快 3 小时」的设备挡在门外（这类设备否则会永远压过别人）。
 *
 *   HLC 的 t 仍是毫秒量纲，所以**没有 hlc 的老记录**直接拿 updatedAt 当 t 就能参与比较，
 *   新旧数据能在同一把尺子上排队，不需要一次性数据迁移。
 *
 *   ⚠️ 归一化一律走 `recordHlc(raw.hlc, updatedAt)`（取两者较晚者），不要直接用 `normHlc`。
 *   客户端手里可能攥着一个从云端带回来的**陈旧 hlc**（applyServerDoc 把服务端下发的
 *   doc.trip 整条存成了本地记录），此时直接采信它会让编辑被**静默吞掉**：
 *   既不算更新也不算冲突，内容纹丝不动。详见 lib/hlc.mjs 里 `recordHlc` 的注释。
 *
 * ── 实时通知（Step 5）──
 *
 * 合并成功后，如果服务端内容**真的变了**（`changed === true`），就通过 hub 向
 * 「订阅了这个空间的其他连接」发一条 `{t:'update', id, rev}`。
 * 通知里**不带文档体**：客户端收到后自己拉那一个空间，合并逻辑仍然只有一份。
 * 幂等重投（changed=false）不广播 —— 否则所有人会为一次没有变化的推送白拉一遍。
 *
 * 发起本次请求的连接（`X-Conn-Id` 头）会被排除在外：它已经从响应里拿到了合并结果。
 * 排除的是**连接**而不是设备 —— 同一台设备开两个标签页时 deviceId 是共享的，
 * 按设备排除会让另一个标签页收不到更新。
 *
 * 接口：
 *   GET    /api/trips                    空间列表（含已删；?active=1 只看在用，?withDoc=1 带全量文档）
 *   GET    /api/trips/by-code/:code      按分享码拉取（加入行程）
 *   POST   /api/trips/join               凭分享码加入并登记成员
 *   GET    /api/trips/:id                按 id 拉取
 *   POST   /api/trips/:id                推送本地快照并合并（doc 可为 null，仅推墓碑）
 *   DELETE /api/trips/:id                删除空间（写 trip 墓碑）
 *   POST   /api/trips/:id/code           换一个分享码
 *   POST   /api/trips/:id/claim          认领一个无归属空间（需出示分享码）
 */

import { createHash } from 'node:crypto'
import { isSpaceDeleted } from '../lib/db.mjs'
import { accessVerdict, spaceHasOwner } from '../lib/acl.mjs'
import { capHlc, cmpHlc, createHlc, hlcAfter, normHlc, recordHlc } from '../lib/hlc.mjs'
import { MERGE_META_KEYS, MAX_MERGE_FIELDS, mergeRecord } from '../lib/lww.mjs'
import {
  bool,
  int,
  isPlainObject,
  isSafeId,
  isoDate,
  makeCode,
  normalizeCode,
  num,
  oneOf,
  safeDecode,
  str,
  strArray,
  ts
} from '../lib/util.mjs'

const ARRAY_KINDS = ['member', 'day', 'item', 'expense', 'poll', 'vote']
const ALL_KINDS = ['trip', ...ARRAY_KINDS]
/** 集合名 → doc 里的键 */
const DOC_KEY = { member: 'members', day: 'days', item: 'items', expense: 'expenses', poll: 'polls', vote: 'votes' }

const ITEM_TYPES = ['spot', 'food', 'transport', 'stay', 'other']
const EXPENSE_CATEGORIES = ['food', 'transport', 'stay', 'ticket', 'shopping', 'entertain', 'other']
const SPLIT_MODES = ['even', 'weight', 'custom']
const POLL_KINDS = ['date', 'destination']
const POLL_STATUSES = ['open', 'closed']

/** 单空间各类记录上限：防止有人灌爆存储 */
const KIND_LIMITS = { member: 200, day: 400, item: 4000, expense: 4000, poll: 200, vote: 2000 }
const MAX_TOTAL_RECORDS = 20000
const KIND_TO_FIELD = { member: 'members', day: 'days', item: 'items', expense: 'expenses', poll: 'polls', vote: 'votes' }
const MAX_TOMBSTONES = 3000

function todayISO() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ───────────────────────── 归一化（白名单写入） ─────────────────────────

/**
 * 归一化**字段级**时间戳映射 `fhlc`。
 *
 * 客户端提交的东西一律当不可信输入 —— 这里尤其要紧，因为映射会被原样存进库、
 * 还会参与「谁更新」的排序，一个畸形值（NaN / 负数 / 超大 t）就能让整块记录的
 * 合并结果失去意义。所以只认「键名像字段名 + 值是一个带正有限 t 的 HLC」的条目。
 *
 * 返回 undefined 表示「没有可用的字段戳」，此时整条记录退回记录级 LWW ——
 * 老客户端不带这个字段，行为与加字段级合并之前完全一致。
 */
function normFhlc(raw) {
  if (!isPlainObject(raw)) return undefined
  const out = {}
  let n = 0
  for (const k of Object.keys(raw)) {
    if (n >= MAX_MERGE_FIELDS) break
    if (MERGE_META_KEYS.has(k)) continue
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(k)) continue
    const v = raw[k]
    if (!isPlainObject(v)) continue
    const t = Number(v.t)
    if (!Number.isFinite(t) || t <= 0) continue
    out[k] = normHlc(v, 0)
    n += 1
  }
  return n ? out : undefined
}

/** 各正常化器共用：把 fhlc 一并带上（没有就不写这个键，保持老记录的字节不变） */
function withFhlc(rec, raw) {
  const fhlc = normFhlc(raw?.fhlc)
  if (fhlc) rec.fhlc = fhlc
  return rec
}

function normTrip(raw, spaceId) {
  if (!isPlainObject(raw)) return null
  const created = ts(raw.createdAt)
  const start = isoDate(raw.startDate, todayISO())
  const updatedAt = ts(raw.updatedAt, created)
  const t = {
    id: spaceId,
    title: str(raw.title, 80, '未命名行程') || '未命名行程',
    destination: str(raw.destination, 40),
    startDate: start,
    endDate: isoDate(raw.endDate, start),
    currency: str(raw.currency, 4, '¥') || '¥',
    budget: num(raw.budget, 0, 1e9, 0),
    memberIds: strArray(raw.memberIds, KIND_LIMITS.member, 64),
    createdAt: created,
    updatedAt,
    // 客户端带来的时钟；没带就退化成 updatedAt —— 老客户端与老记录都能在同一把尺子上比较
    hlc: recordHlc(raw.hlc, updatedAt)
  }
  if (raw.settledAt !== undefined) t.settledAt = ts(raw.settledAt)
  return withFhlc(t, raw)
}

function normMember(raw, tripId) {
  if (!isPlainObject(raw) || !isSafeId(raw.id)) return null
  const updatedAt = ts(raw.updatedAt)
  return withFhlc(
    {
      id: raw.id,
      tripId,
      name: str(raw.name, 24, '成员') || '成员',
      colorIndex: int(raw.colorIndex, 0, 31, 0),
      weight: num(raw.weight, 0, 1000, 1),
      isSelf: bool(raw.isSelf),
      updatedAt,
      hlc: recordHlc(raw.hlc, updatedAt)
    },
    raw
  )
}

function normDay(raw, tripId) {
  if (!isPlainObject(raw) || !isSafeId(raw.id)) return null
  const updatedAt = ts(raw.updatedAt)
  return withFhlc(
    {
      id: raw.id,
      tripId,
      date: isoDate(raw.date, todayISO()),
      index: int(raw.index, 0, 3650, 0),
      title: str(raw.title, 40),
      note: str(raw.note, 500),
      updatedAt,
      hlc: recordHlc(raw.hlc, updatedAt)
    },
    raw
  )
}

function normItem(raw, tripId) {
  if (!isPlainObject(raw) || !isSafeId(raw.id)) return null
  const updatedAt = ts(raw.updatedAt)
  return withFhlc(
    {
      id: raw.id,
      dayId: str(raw.dayId, 64),
      tripId,
      order: int(raw.order, 0, 9999, 0),
      time: /^\d{2}:\d{2}$/.test(String(raw.time || '')) ? String(raw.time) : '',
      type: oneOf(raw.type, ITEM_TYPES, 'other'),
      title: str(raw.title, 60, '新安排') || '新安排',
      address: str(raw.address, 120),
      lat: num(raw.lat, -90, 90, 0),
      lng: num(raw.lng, -180, 180, 0),
      cost: num(raw.cost, 0, 1e9, 0),
      duration: int(raw.duration, 0, 1440, 90),
      note: str(raw.note, 500),
      done: bool(raw.done),
      updatedAt,
      hlc: recordHlc(raw.hlc, updatedAt)
    },
    raw
  )
}

function normExpense(raw, tripId) {
  if (!isPlainObject(raw) || !isSafeId(raw.id)) return null
  const parts = Array.isArray(raw.participants) ? raw.participants.slice(0, 200) : []
  const created = ts(raw.createdAt)
  const updatedAt = ts(raw.updatedAt, created)
  return withFhlc(
    {
      id: raw.id,
      tripId,
      title: str(raw.title, 60, '一笔支出') || '一笔支出',
      amount: num(raw.amount, 0, 1e9, 0),
      category: oneOf(raw.category, EXPENSE_CATEGORIES, 'other'),
      date: isoDate(raw.date, todayISO()),
      payerId: str(raw.payerId, 64),
      participants: parts
        .filter((p) => isPlainObject(p) && typeof p.memberId === 'string' && p.memberId.length <= 64)
        .map((p) => ({ memberId: p.memberId, share: num(p.share, -1e9, 1e9, 1) })),
      splitMode: oneOf(raw.splitMode, SPLIT_MODES, 'even'),
      note: str(raw.note, 500),
      createdAt: created,
      updatedAt,
      hlc: recordHlc(raw.hlc, updatedAt)
    },
    raw
  )
}

function normPoll(raw, tripId) {
  if (!isPlainObject(raw) || !isSafeId(raw.id)) return null
  const created = ts(raw.createdAt)
  const updatedAt = ts(raw.updatedAt, created)
  const options = Array.isArray(raw.options) ? [] : null
  if (options) {
    const seen = new Set()
    for (const o of raw.options.slice(0, 50)) {
      if (!isPlainObject(o)) continue
      const id = str(o.id, 64)
      const label = str(o.label, 40)
      if (!id || !label || seen.has(id)) continue
      seen.add(id)
      options.push({ id, label: label.slice(0, 40) })
    }
  }
  const p = {
    id: raw.id,
    tripId,
    kind: oneOf(raw.kind, POLL_KINDS, 'destination'),
    title: str(raw.title, 40, '投票') || '投票',
    options,
    status: oneOf(raw.status, POLL_STATUSES, 'open'),
    createdAt: created,
    updatedAt,
    hlc: recordHlc(raw.hlc, updatedAt)
  }
  if (raw.result !== undefined) p.result = str(raw.result, 64)
  return withFhlc(p, raw)
}

function normVote(raw, tripId) {
  if (!isPlainObject(raw) || !isSafeId(raw.id)) return null
  const updatedAt = ts(raw.updatedAt)
  return withFhlc(
    {
      id: raw.id,
      tripId,
      pollId: str(raw.pollId, 64),
      memberId: str(raw.memberId, 64),
      optionId: str(raw.optionId, 64),
      updatedAt,
      hlc: recordHlc(raw.hlc, updatedAt)
    },
    raw
  )
}

const NORMALIZER = {
  member: normMember,
  day: normDay,
  item: normItem,
  expense: normExpense,
  poll: normPoll,
  vote: normVote
}

/** 把请求体里的 doc 归一成可信结构；返回 null 表示整体非法 */
function normDoc(raw, spaceId) {
  if (!isPlainObject(raw)) return null
  const out = {
    trip: normTrip(raw.trip, spaceId),
    members: [],
    days: [],
    items: [],
    expenses: [],
    polls: [],
    votes: []
  }
  if (!out.trip) return null

  for (const kind of ARRAY_KINDS) {
    const list = raw[DOC_KEY[kind]]
    if (!Array.isArray(list)) continue
    const norm = NORMALIZER[kind]
    for (const r of list.slice(0, KIND_LIMITS[kind])) {
      const v = norm(r, spaceId)
      if (v) out[DOC_KEY[kind]].push(v)
    }
  }
  return out
}

function normTombstones(raw, spaceId) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const t of raw.slice(0, MAX_TOMBSTONES)) {
    if (!isPlainObject(t)) continue
    const kind = oneOf(t.kind, ALL_KINDS, null)
    if (!kind) continue
    const id = kind === 'trip' ? spaceId : str(t.id, 64)
    if (!isSafeId(id)) continue
    const key = kind + ':' + id
    if (seen.has(key)) continue
    seen.add(key)
    const deletedAt = ts(t.deletedAt)
    out.push({ kind, id, deletedAt, hlc: recordHlc(t.hlc, deletedAt) })
  }
  return out
}

// ───────────────────────── 服务端时钟 ─────────────────────────

/**
 * 让服务端时钟「看过」传入的所有时间戳，并统计其中有多少明显超前。
 *
 * ⚠️ 这里**不改写**记录里的 hlc。超前与否只影响比较时的封顶（见 lib/hlc.mjs 的 capHlc）。
 * 早期版本把超前的值夹到 `now + skew` 再存库，结果同一条超前记录每次推送都被封到一个
 * 更大的值，服务端每次都判定「有变化」→ rev 无限增长、所有客户端被迫反复重拉。
 *
 * @returns {number} 明显超前的记录数（回给客户端，便于提示「设备时间可能不准」）
 */
function observeDoc(doc, clock) {
  if (!doc) return 0
  let skewed = 0
  const visit = (rec) => {
    if (!rec) return
    if (clock.observe(rec.hlc, rec.updatedAt || 0).skewed) skewed += 1
  }
  visit(doc.trip)
  for (const kind of ARRAY_KINDS) {
    for (const rec of doc[DOC_KEY[kind]]) visit(rec)
  }
  return skewed
}

function observeTombstones(tombstones, clock) {
  let skewed = 0
  for (const t of tombstones) {
    if (clock.observe(t.hlc, t.deletedAt || 0).skewed) skewed += 1
  }
  return skewed
}

// ───────────────────────── 合并 ─────────────────────────

function mergeTombstones(server, incoming, cap) {
  const map = new Map()
  for (const t of [...server, ...incoming]) {
    const key = t.kind + ':' + t.id
    const prev = map.get(key)
    if (!prev || hlcAfter(cap(t.hlc), cap(prev.hlc))) map.set(key, t)
  }
  return [...map.values()]
}

function pruneTombstones(list, cap) {
  // 只按条数截断，**不按时间过期**。
  //
  // 曾经用过「删除 30 天以上墓碑」的策略，但它会制造一个真实的复活窗口：
  // 一台离线两个月没同步的设备，一上线就会把早已删除的记录整批推回来，
  // 而服务端此时已经没有墓碑可以挡住它了。
  // 这个应用的数据量很小（单个空间最多几千条记录），墓碑长期保留成本可忽略，
  // 所以选择更安全的做法：只在超过上限时丢弃最旧的墓碑（极端情况下才有影响）。
  if (list.length <= MAX_TOMBSTONES) return list
  return [...list].sort((a, b) => cmpHlc(cap(b.hlc), cap(a.hlc))).slice(0, MAX_TOMBSTONES)
}

/** 墓碑生效：记录比墓碑新则视为「删后又改」，保留记录 */
function applyTombstones(list, tombstones, kind, cap) {
  const del = new Map()
  for (const t of tombstones) {
    if (t.kind !== kind) continue
    const h = cap(t.hlc)
    const prev = del.get(t.id)
    if (!prev || hlcAfter(h, prev)) del.set(t.id, h)
  }
  if (!del.size) return list
  return list.filter((r) => {
    const d = del.get(r.id)
    return d === undefined || hlcAfter(cap(r.hlc), d)
  })
}

/**
 * 把客户端快照合并进服务端空间（就地修改）。
 *
 * **逐字段**合并：每个字段各带自己的时间戳，比时间戳各取较晚的那份。
 * 于是「A 改标题、B 同时改预算」两边都保住 —— 这是记录级 LWW 做不到的。
 * 没有字段戳的记录（老数据 / 老客户端）整体退到记录级 hlc 参与比较，
 * 行为与加字段级合并之前完全一致，所以不需要迁移。
 *
 * `applied` 的语义随之一并调整：
 *   · `updated`  —— base 存在，但**至少有一个字段**被 incoming 赢走
 *   · `conflicts`—— base 存在，且 incoming **一个字段都没赢**（整条都是旧的）
 * 一半新一半旧的推送算 `updated`，这正是「部分重合并」该有的样子。
 *
 * @returns {{added:number, updated:number, removed:number, conflicts:number}}
 */
function mergeIntoSpace(space, doc, incomingTombstones, cap) {
  const stats = { added: 0, updated: 0, removed: 0, conflicts: 0 }
  const before = countRecords(space.doc)

  /** 单条记录走字段级合并；base 为 null 即插入 */
  const put = (base, incoming) => {
    const m = mergeRecord(base, incoming, cap)
    if (!base) {
      stats.added += 1
    } else if (m.took > 0) {
      stats.updated += 1
    } else {
      stats.conflicts += 1
    }
    return m.rec
  }

  // 1) trip 单条
  if (doc.trip) {
    space.doc.trip = put(space.doc.trip, doc.trip)
  }

  // 2) 各集合：按 id 对齐，再逐字段合并
  for (const kind of ARRAY_KINDS) {
    const key = DOC_KEY[kind]
    const map = new Map(space.doc[key].map((r) => [r.id, r]))
    for (const c of doc[key]) {
      map.set(c.id, put(map.get(c.id), c))
    }
    space.doc[key] = [...map.values()]
  }

  // 3) 合并墓碑并生效（放在最后：即使客户端同时带了记录和墓碑，也以墓碑规则收口）
  space.tombstones = pruneTombstones(mergeTombstones(space.tombstones, incomingTombstones, cap), cap)
  for (const kind of ARRAY_KINDS) {
    const key = DOC_KEY[kind]
    space.doc[key] = applyTombstones(space.doc[key], space.tombstones, kind, cap)
  }

  const after = countRecords(space.doc)
  stats.removed = Math.max(0, before + stats.added - after)
  return stats
}

function countRecords(doc) {
  let n = doc.trip ? 1 : 0
  for (const kind of ARRAY_KINDS) n += doc[DOC_KEY[kind]].length
  return n
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const byId = (a, b) => cmpStr(String(a.id), String(b.id))

/** 递归按 key 排序，让「同一个对象」无论键的插入顺序如何都产出同一段字符串 */
function stableValue(v) {
  if (Array.isArray(v)) return v.map(stableValue)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = stableValue(v[k])
    return out
  }
  return v
}

/**
 * 文档 + 墓碑的指纹，用来判断「这次推送到底有没有改变服务端」。
 *
 * ⚠️ 必须是**顺序无关**的。记录和墓碑的排列顺序会随存储层回读、客户端提交次序而变，
 * 如果直接 stringify 整个数组，一次没有实质变化的推送也会被算成 changed，
 * 于是 rev 无谓增长、所有客户端被迫重新拉一遍 —— 幂等性就废了。
 * 所以这里先规范化：数组按 id 排序，对象键按字典序排序。
 */
function digestOf(space) {
  const doc = space.doc
  const canon = {
    trip: doc.trip || null,
    members: [...doc.members].sort(byId),
    days: [...doc.days].sort(byId),
    items: [...doc.items].sort(byId),
    expenses: [...(doc.expenses || [])].sort(byId),
    polls: [...(doc.polls || [])].sort(byId),
    votes: [...(doc.votes || [])].sort(byId)
  }
  const tombs = [...space.tombstones].sort((a, b) =>
    a.kind === b.kind ? cmpStr(String(a.id), String(b.id)) : cmpStr(String(a.kind), String(b.kind))
  )
  return createHash('sha1')
    .update(JSON.stringify(stableValue(canon)))
    .update('|')
    .update(JSON.stringify(stableValue(tombs)))
    .digest('hex')
    .slice(0, 16)
}

function emptyDoc() {
  return { trip: null, members: [], days: [], items: [], expenses: [], polls: [], votes: [] }
}

function newSpace(id, author, ownerOpenid = '') {
  const now = Date.now()
  return {
    id,
    code: '',
    rev: 0,
    createdAt: now,
    updatedAt: now,
    updatedBy: author,
    // 归属：创建者带身份时记下来（开启成员表后由成员表说了算，见 assertCanWrite）
    ownerOpenid,
    // 曾用名历史：分享码换过之后，旧码短时间内仍可加入
    retiredCodes: [],
    digest: '',
    tombstones: [],
    doc: emptyDoc()
  }
}

// ───────────────────────── 路由 ─────────────────────────

export function createTripsRouter({
  http,
  db,
  log,
  clock = createHlc({ node: 'server-default' }),
  // 实时订阅中心（lib/hub.mjs）。可选：不起实时能力时传 null，其余功能完全不受影响。
  // 路由只负责「告诉它这个空间变了」，扇出与合并通知是 hub 的事。
  hub = null
}) {
  /**
   * 空间概要。`code` 是写权凭据（凭它 join 即登记成员），所以**按查看者剥离**：
   * 有主空间只有 owner / 成员能看到；无主空间维持 orphan-open 口径不剥
   * （写权本就开放，码不构成越权升级）。否则「discover 剥码、GET /:id 送码」
   * 会把只读浏览变回人人可写的后门。
   *
   * 必须在 router 闭包内：canSeeCode 要查成员表（db）。
   */
  function brief(space, viewerOpenid = '') {
    const t = space.doc.trip
    const canSeeCode =
      !spaceHasOwner(db, space) ||
      (!!viewerOpenid &&
        (space.ownerOpenid === viewerOpenid || !!db.memberRoleOf(space.id, viewerOpenid)))
    return {
      id: space.id,
      ...(canSeeCode ? { code: space.code } : {}),
      rev: space.rev,
      deleted: isSpaceDeleted(space, cap),
      title: t?.title || '未命名行程',
      destination: t?.destination || '',
      startDate: t?.startDate || '',
      endDate: t?.endDate || '',
      updatedAt: space.updatedAt,
      updatedBy: space.updatedBy,
      counts: {
        members: space.doc.members.length,
        days: space.doc.days.length,
        items: space.doc.items.length,
        expenses: space.doc.expenses.length,
        polls: space.doc.polls.length,
        votes: space.doc.votes.length
      }
    }
  }

  function full(space, viewerOpenid = '') {
    return { ...brief(space, viewerOpenid), doc: space.doc, tombstones: space.tombstones }
  }

  /**
   * 所有时间戳比较都必须走这个封顶函数。
   * 库里的时间戳可能来自时钟不准的设备，不封顶会让它永远压过别人；
   * lib/db.mjs 的已删判定也用同一个函数，两条路径必须同一口径。
   */
  const cap = (h) => clock.cap(h)

  /** 取一个未删除的空间 */
  function findById(id) {
    const s = db.loadSpace(id)
    return s && !isSpaceDeleted(s, cap) ? s : null
  }

  /** 按分享码找未删除的空间（含曾用码） */
  function findByCode(code) {
    return db.findSpaceByCode(code)
  }

  /** 生成不与现有空间冲突的分享码 */
  function allocateCode() {
    for (let i = 0; i < 50; i += 1) {
      const c = makeCode(6)
      // 已删除的空间也算占用：否则旧码会被新空间复用，
      // 群里还留着旧码的人一加入就落到一个已删空间里。
      if (!db.findSpaceByCode(c, { includeDeleted: true })) return c
    }
    return makeCode(8)
  }

  // ── 归属与授权（Step 4 · 账号体系）──
  //
  // 规则本体在 lib/acl.mjs（单一定义处）—— 实时同步的「能不能订阅这个空间的变更」
  // 用的是同一份判定。在这里再抄一份迟早会漂移，而漂移的方向必然是某一侧忘了收紧。

  /** 请求携带的会话身份（index.mjs 管线里已解析好），无令牌为 null */
  function identityOf(req) {
    return req.identity || null
  }

  /**
   * 发起这次请求的实时连接 id（`X-Conn-Id`）。
   *
   * 走请求头而不是请求体：DELETE 这类请求没有载荷，用请求体就没法统一。
   * 客户端在 backend 的 headers() 里统一带上，路由侧只管读。
   */
  function connIdOf(req) {
    return str(req.headers['x-conn-id'], 48)
  }

  async function push(req, res, id) {
    const body = await http.readBody(req)
    if (!body.ok) return http.fail(req, res, body.status, body.error)

    const author = str(body.value.author, 24, '匿名') || '匿名'
    const deviceId = str(body.value.deviceId, 64)
    const baseRev = int(body.value.baseRev, 0, 1e9, null)
    // 发起这次推送的实时连接（客户端从 ready 帧拿到，放在 X-Conn-Id 头里）。
    // 仅用于「别把通知发回给自己」，不参与任何权限判定 ——
    // 它是客户端自报的，伪造它最多是让自己多收一条通知。
    const connId = connIdOf(req)

    const rawDoc = body.value.doc
    const doc = rawDoc === null || rawDoc === undefined ? null : normDoc(rawDoc, id)
    if (rawDoc !== null && rawDoc !== undefined && doc === null) {
      return http.fail(req, res, 400, 'invalid doc: trip 缺失或格式不合法')
    }

    const tombstones = normTombstones(body.value.tombstones, id)

    // 让服务端时钟看过这批时间戳，并统计有多少条明显超前（只影响比较时的封顶，不改写数据）
    const skewed = (doc ? observeDoc(doc, clock) : 0) + observeTombstones(tombstones, clock)

    // 封顶基准在**一次请求内固定**：否则同一条记录在比较两侧可能落在不同毫秒上，
    // 拿到不同的上界，判定会自相矛盾。
    const reqNow = Date.now()
    const capReq = (h) => capHlc(h, reqNow, clock.maxSkewMs)

    if (doc) {
      const total = countRecords(doc)
      if (total > MAX_TOTAL_RECORDS) {
        return http.fail(req, res, 413, `too many records (limit ${MAX_TOTAL_RECORDS})`, { total })
      }
    }

    const existing = db.loadSpace(id)
    const openid = identityOf(req)?.openid || ''

    // 写权限：有主空间只允许成员写入。放在合并之前 —— 拒绝的请求不该产生任何副作用。
    if (existing) {
      const verdict = accessVerdict(db, existing, openid)
      if (!verdict.ok) {
        log.warn('拒绝写非成员空间', { id, openid: openid.slice(0, 8), reason: verdict.reason })
        return http.fail(req, res, verdict.status, verdict.message)
      }
    }

    const space = existing || newSpace(id, author, openid)
    if (!existing) space.code = allocateCode()

    const revBefore = space.rev
    const staleBase = baseRev !== null && baseRev !== revBefore

    // 合并前基线：合并后复核只拦**本次推送带来的增量**——老版本限额下合法累积、
    // 现已存量超限的空间，靠幂等重推/无关编辑也能保住同步通道，不被 413 永久卡死。
    const beforeTotal = existing ? countRecords(existing.doc) : 0
    const beforeRows = {}
    for (const kind of Object.keys(KIND_LIMITS)) {
      beforeRows[kind] = existing ? (existing.doc[KIND_TO_FIELD[kind]] || []).length : 0
    }

    const applied = doc
      ? mergeIntoSpace(space, doc, tombstones, capReq)
      : mergeTombstonesOnly(space, tombstones, capReq)

    // 合并后复核总量：单次请求的限额挡不住「反复小推送、每次换 id」把库灌大。
    // 仅当「超限且有增量」才拒；此处 space 尚未落盘（saveSpace 在后面），拒绝无副作用。
    if (doc) {
      const total = countRecords(space.doc)
      if (total > MAX_TOTAL_RECORDS && total > beforeTotal) {
        return http.fail(req, res, 413, `too many records (limit ${MAX_TOTAL_RECORDS})`, { total })
      }
      for (const [kind, limit] of Object.entries(KIND_LIMITS)) {
        const rows = space.doc[KIND_TO_FIELD[kind]] || []
        if (rows.length > limit && rows.length > beforeRows[kind]) {
          return http.fail(req, res, 413, `too many ${kind}s (limit ${limit})`, { count: rows.length })
        }
      }
    }

    const digest = digestOf(space)
    const changed = digest !== space.digest
    if (changed) {
      space.digest = digest
      space.rev += 1
    }
    space.updatedAt = Date.now()
    space.updatedBy = author
    db.saveSpace(space)

    // 新建空间且创建者带身份 → 落一行 owner 成员。
    // 放在 saveSpace 之后：空间行先存在，成员行才有意义（两条写在同一事务之外，
    // 但即便中途崩溃，最坏情况只是「owner 列有值、成员表没有」，writeVerdict 里
    // `space.ownerOpenid === openid` 那条分支仍能放行，不会把自己锁在门外）。
    if (!existing && openid) db.addMember(id, openid, 'owner', space.createdAt)

    // 实时通知：**只在真的变了时发**（changed=false 的推送是幂等重投，广播它只会让
    // 所有人白拉一遍）。除发起连接外的订阅者会收到一条「这个空间变了」，
    // 然后各自去拉那一个空间 —— 推送不带文档体，理由见 lib/hub.mjs 的文件头。
    if (changed && hub) {
      hub.notify(
        id,
        { rev: space.rev, deleted: false, updatedBy: author, at: space.updatedAt },
        { exceptConnId: connId }
      )
    }

    if (skewed) log.warn('客户端时间戳明显超前（已按上界参与比较）', { id, skewed })

    log.info('trip push', {
      id,
      author,
      device: deviceId ? deviceId.slice(0, 8) : '',
      rev: space.rev,
      changed,
      staleBase,
      skewed,
      ...applied
    })

    return http.send(req, res, 200, {
      space: brief(space, openid),
      doc: space.doc,
      tombstones: space.tombstones,
      applied,
      changed,
      staleBase,
      skewed,
      serverRev: space.rev
    })
  }

  function mergeTombstonesOnly(space, tombstones, cap) {
    const stats = { added: 0, updated: 0, removed: 0, conflicts: 0 }
    const before = countRecords(space.doc)
    space.tombstones = pruneTombstones(mergeTombstones(space.tombstones, tombstones, cap), cap)
    for (const kind of ARRAY_KINDS) {
      const key = DOC_KEY[kind]
      space.doc[key] = applyTombstones(space.doc[key], space.tombstones, kind, cap)
    }
    stats.removed = Math.max(0, before - countRecords(space.doc))
    return stats
  }

  /**
   * @returns {Promise<boolean>} 是否已处理该请求
   */
  async function handle(req, res, url) {
    const p = url.pathname
    if (p !== '/api/trips' && !p.startsWith('/api/trips/')) return false

    // 列表
    //
    // ⚠️ 默认**包含**已删除的空间（带 deleted:true）。
    // 这是同步协议的要求，不是疏忽：如果列表把已删空间藏起来，
    // 别的设备就永远收不到「这个行程被删了」这个事实，会一直留着陈旧副本。
    // 想只看在用的，加 ?active=1。
    if (p === '/api/trips') {
      if (req.method !== 'GET') return http.methodNotAllowed(req, res, ['GET', 'OPTIONS'])
      const withDoc = url.searchParams.get('withDoc') === '1'
      const activeOnly = url.searchParams.get('active') === '1'
      // 带会话身份时返回「我参与的 ∪ 无主的」（含无主是为了不让存量行程凭空消失）；
      // 匿名只返回无主空间 —— 未登录的启动同步若能拉到全部，会把别人行程并进本地。
      // 见 db.listSpaces 的注释。
      const viewerOpenid = identityOf(req)?.openid || ''
      // 交给存储层走 SQL：不带 withDoc 时完全不加载文档，只取展示需要的列
      return http.send(req, res, 200, { spaces: db.listSpaces({ activeOnly, withDoc, viewerOpenid }) })
    }

    // 凭分享码加入：**与 GET by-code 的区别是它会产生副作用** ——
    // 带身份时把调用者登记为成员。所以是 POST，不能沿用 GET。
    if (p === '/api/trips/join') {
      if (req.method !== 'POST') return http.methodNotAllowed(req, res, ['POST', 'OPTIONS'])
      const body = await http.readBody(req)
      if (!body.ok) return http.fail(req, res, body.status, body.error)
      const code = normalizeCode(body.value?.code)
      if (!code) return http.fail(req, res, 400, 'invalid code')
      const space = findByCode(code)
      if (!space) return http.fail(req, res, 404, 'code not found')
      const openid = identityOf(req)?.openid || ''
      if (openid && spaceHasOwner(db, space)) {
        // 只往**已有归属**的空间里加成员。无主空间不做登记 ——
        // 一旦登记，「群里另一个人还没登录」就当场写不动了，那是静默的权限变更。
        // 无主空间要用账号体系保护的路径是 /claim（需出示分享码，且是本人在做决定）。
        const added = db.addMember(space.id, openid, 'member')
        if (added) log.info('新成员加入空间', { id: space.id, openid: openid.slice(0, 8) })
      }
      return http.send(req, res, 200, { space: full(space, openid), joined: !!openid })
    }

    // 按分享码加入（必须先于 :id 匹配，否则 'by-code' 会被当成 spaceId）
    const codeMatch = p.match(/^\/api\/trips\/by-code\/([^/]+)$/)
    if (codeMatch) {
      const raw = safeDecode(codeMatch[1])
      if (raw === null) return http.fail(req, res, 400, 'malformed code')
      const code = normalizeCode(raw)
      if (!code) return http.fail(req, res, 400, 'invalid code')
      if (req.method !== 'GET') return http.methodNotAllowed(req, res, ['GET', 'OPTIONS'])
      const space = findByCode(code)
      if (!space) return http.fail(req, res, 404, 'code not found')
      return http.send(req, res, 200, { space: full(space, identityOf(req)?.openid || '') })
    }

    // 发现广场：所有登录用户可见的全部未删除行程（只读浏览）。
    //
    // 与 GET /api/trips 的区别：那里是「我参与 ∪ 无主」的**工作集**（会进同步），
    // 这里是**橱窗**——别人也在用的行程，供浏览。读本就开放（id 即 capability），
    // 这里只是把「有哪些」列出来；写权限仍由 accessVerdict 在 push 路径把关。
    //
    // ⚠️ 非 mine 条目必须剥掉 code：分享码等于「凭它 join 就能拿到写权」，
    // 广场广播里带上它等于把「只读浏览」变成「人人可写」的后门。
    if (p === '/api/trips/discover') {
      if (req.method !== 'GET') return http.methodNotAllowed(req, res, ['GET', 'OPTIONS'])
      const openid = identityOf(req)?.openid || ''
      if (!openid) return http.fail(req, res, 401, 'sign in required to browse discover')
      return http.send(req, res, 200, { trips: db.listSpacesBriefForDiscover(openid) })
    }

    // 单个空间
    const idMatch = p.match(/^\/api\/trips\/([^/]+)$/)
    if (idMatch) {
      const id = safeDecode(idMatch[1])
      if (id === null || !isSafeId(id)) return http.fail(req, res, 400, 'invalid trip id')

      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        return push(req, res, id)
      }

      if (req.method === 'DELETE') {
        const space = db.loadSpace(id)
        if (!space) return http.fail(req, res, 404, 'not found')
        const verdict = accessVerdict(db, space, identityOf(req)?.openid || '')
        if (!verdict.ok) {
          log.warn('拒绝删除非成员空间', { id, reason: verdict.reason })
          return http.fail(req, res, verdict.status, verdict.message)
        }
        // 服务端自己产生的变更（删除）用服务端 HLC 盖章：一定排在所有已接受的记录之后
        const nowTs = Date.now()
        const capDel = (h) => capHlc(h, nowTs, clock.maxSkewMs)
        space.tombstones = pruneTombstones(
          mergeTombstones(space.tombstones, [{ kind: 'trip', id, deletedAt: nowTs, hlc: clock.stamp() }], capDel),
          capDel
        )
        const digest = digestOf(space)
        if (digest !== space.digest) {
          space.digest = digest
          space.rev += 1
        }
        space.updatedAt = Date.now()
        db.saveSpace(space)
        log.info('trip delete', { id, rev: space.rev })
        // 删除也要广播：不通知的话，同行的人会一直留着一份已被删除的行程，
        // 直到下次主动刷新 —— 而「别人删了你还在改」是最容易产生脏数据的情形。
        if (hub) {
          hub.notify(
            id,
            {
              rev: space.rev,
              deleted: true,
              updatedBy: identityOf(req)?.openid ? '成员' : '匿名',
              at: space.updatedAt
            },
            { exceptConnId: connIdOf(req) }
          )
        }
        return http.send(req, res, 200, { ok: true, deleted: true })
      }

      if (req.method === 'GET') {
        const space = db.loadSpace(id)
        if (!space) return http.fail(req, res, 404, 'not found')
        // 按查看者剥 code：有主空间的分享码只给 owner / 成员（id 是 capability，
        // 但码是写权凭据 —— 不能因为「读开放」就把写权一并送出去）
        return http.send(req, res, 200, { space: full(space, identityOf(req)?.openid || '') })
      }

      return http.methodNotAllowed(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])
    }

    // 换分享码（旧码保留 7 天可加入，避免群里发过的码立刻失效）
    if (/^\/api\/trips\/[^/]+\/code$/.test(p)) {
      if (req.method !== 'POST') return http.methodNotAllowed(req, res, ['POST', 'OPTIONS'])
      const id = safeDecode(p.split('/')[3])
      if (id === null || !isSafeId(id)) return http.fail(req, res, 400, 'invalid trip id')
      const space = findById(id)
      if (!space) return http.fail(req, res, 404, 'not found')
      // 换码会让旧码失效、影响所有还没加入的人 —— 属于「成员级」操作，不是随便谁都能做
      const verdict = accessVerdict(db, space, identityOf(req)?.openid || '')
      if (!verdict.ok) return http.fail(req, res, verdict.status, verdict.message)
      const old = space.code
      space.code = allocateCode()
      // 旧码 7 天宽限（群里发过的码不至于立刻失效），到期作废。
      // 带时间戳才作废得了 —— 之前只存码字符串，旧码永久可用，
      // 「换码踢掉泄漏持码人」从来没有真正生效过。
      const retired = (space.retiredCodes || []).map((c) =>
        typeof c === 'string' ? { code: c, retiredAt: 0 } : c
      )
      space.retiredCodes = [...retired, { code: old, retiredAt: Date.now() }].slice(-3)
      space.updatedAt = Date.now()
      db.saveSpace(space)
      return http.send(req, res, 200, { code: space.code, previous: old })
    }

    // 认领一个「无主」空间：把接账号体系之前创建的行程纳入账号体系。
    //
    // 为什么要求出示分享码：认领会**改变权限模型**（从「谁知道 id 谁能写」变成「只有成员能写」）。
    // 分享码正是旧模型下的访问凭证，拿它作为「你有资格决定这件事」的证明是与旧模型一致的；
    // 光凭 id 就允许认领，等于把「知道 id」升格为「拥有它」。
    //
    // 只允许认领真正无主的空间（没有 owner、也没有任何成员行）——
    // 否则这就是一个「把别人的行程抢过来」的后门。
    if (/^\/api\/trips\/[^/]+\/claim$/.test(p)) {
      if (req.method !== 'POST') return http.methodNotAllowed(req, res, ['POST', 'OPTIONS'])
      const id = safeDecode(p.split('/')[3])
      if (id === null || !isSafeId(id)) return http.fail(req, res, 400, 'invalid trip id')
      const openid = identityOf(req)?.openid || ''
      if (!openid) return http.fail(req, res, 401, 'sign in required to claim a trip')
      const body = await http.readBody(req)
      if (!body.ok) return http.fail(req, res, body.status, body.error)
      const code = normalizeCode(body.value?.code)
      if (!code) return http.fail(req, res, 400, 'invalid code')
      const found = findByCode(code)
      // 码必须指向**同一个**空间：否则拿自己空间的码就能认领别人的
      if (!found || found.id !== id) return http.fail(req, res, 403, 'code does not match this trip')
      if (spaceHasOwner(db, found)) return http.fail(req, res, 409, 'trip already has an owner')

      found.ownerOpenid = openid
      found.updatedAt = Date.now()
      found.updatedBy = `owner:${openid.slice(0, 8)}`
      db.saveSpace(found)
      db.addMember(id, openid, 'owner')
      // 认领**改变了权限模型**：从「谁知道码谁能写」变成「只有成员能访问」。
      // 认领之前已经建立的实时订阅不会自动失效，所以这里主动把非成员的订阅踢掉 ——
      // 否则「授权变了、会话还留着」会让不该收到通知的人继续收到（见 hub.dropSubscribers）。
      const revoked = hub
        ? hub.dropSubscribers(id, (conn) => !!conn.openid && conn.openid === openid)
        : 0
      log.info('空间已认领', { id, openid: openid.slice(0, 8), revokedSubscriptions: revoked })
      return http.send(req, res, 200, { ok: true, space: brief(found, openid), revokedSubscriptions: revoked })
    }

    return false
  }

  return { handle, _internal: { mergeIntoSpace, applyTombstones, normDoc, digestOf } }
}
