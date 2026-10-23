/**
 * 行程空间（Trip Space）云函数 —— server/routes/trips.mjs + server/lib/db.mjs 的云端移植。
 *
 * 语义与自托管参考实现完全一致（按实体 LWW + 墓碑 + 字段级合并 + HLC 封顶）。
 * 存储从「SQLite 单库」换成「云数据库集合」，合并逻辑仍在应用层做（读整空间 → 合并 → 幂等覆盖写）。
 *
 * ⚠️ 并发口径：云数据库没有「复合主键 upsert + 按 hlc 条件更新」的原子原语，
 * 所以 push 采用「读 → 合并 → set 覆盖」；两个并发 push 各自基于同一基线时会互相覆盖。
 * 这不会造成永久丢失：客户端同步协议是「拉 → 推 → 拉」，被覆盖的那一侧拿着自己的
 * 较新版，下次拉取时会重新合并推回（服务器合并天然幂等 + LWW 收敛）。局限已在
 * CLOUD_MIGRATION_PLAN.md 第 6 节说明。
 *
 * 身份：函数用 cloud.getWXContext().OPENID 拿真实 openid；事件里的 `loggedIn` 是
 * **客户端自报的执行状态**（是否进入账号体系）。云环境里每个调用者都有 OPENID，
 * 但「未登录」的用户体验必须保留：未登录时按匿名口径（无主空间开放、新空间不记 owner）。
 * 自报 loggedIn 不会造成越权升级 —— 「冒充匿名」最多让自己创建的空间保持无主，
 * 与「先创建无主空间再用码认领」等价，不是权限提升。
 *
 * event：{ action, ...payload, loggedIn }
 * action：list | get | byCode | join | discover | push | delete | rotateCode | claim
 * 成功直接返回数据对象；失败返回 { e: { status, message } }（前端适配层据此转 BackendError）。
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const { randomBytes, createHash } = require('crypto')

const {
  ensureCollection,
  docGet,
  docSet,
  writeDocs,
  whereGet,
  whereCount,
  whereRemove
} = require('./_lib/store')
const {
  capHlc,
  cmpHlc,
  createHlc,
  decodeHlc,
  encodeHlc,
  hlcAfter,
  hlcFromTs,
  normHlc,
  recordHlc
} = require('./_lib/hlc')
const { MERGE_META_KEYS, MAX_MERGE_FIELDS, mergeRecord } = require('./_lib/lww')
const {
  bool,
  int,
  isPlainObject,
  isSafeId,
  isoDate,
  makeCode,
  normalizeCode,
  num,
  oneOf,
  str,
  strArray,
  ts
} = require('./_lib/util')

const ARRAY_KINDS = ['member', 'day', 'item', 'expense', 'poll', 'vote', 'meetup', 'location']
const ALL_KINDS = ['trip', ...ARRAY_KINDS]
const DOC_KEY = { member: 'members', day: 'days', item: 'items', expense: 'expenses', poll: 'polls', vote: 'votes', meetup: 'meetups', location: 'locations' }

const ITEM_TYPES = ['spot', 'food', 'transport', 'stay', 'other']
const EXPENSE_CATEGORIES = ['food', 'transport', 'stay', 'ticket', 'shopping', 'entertain', 'other']
const SPLIT_MODES = ['even', 'weight', 'custom']
const POLL_KINDS = ['date', 'destination']
const POLL_STATUSES = ['open', 'closed']

const KIND_LIMITS = { member: 200, day: 400, item: 4000, expense: 4000, poll: 200, vote: 2000, meetup: 20, location: 200 }
const MAX_TOTAL_RECORDS = 20000
const KIND_TO_FIELD = { member: 'members', day: 'days', item: 'items', expense: 'expenses', poll: 'polls', vote: 'votes', meetup: 'meetups', location: 'locations' }
const MAX_TOMBSTONES = 3000

/** 实例级随机节点：多个容器实例并发时 DELETE 盖戳（stamp）不会撞节点号 */
const clock = createHlc({ node: 'cloud-trips-' + randomBytes(6).toString('hex') })

function todayISO() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function fail(status, message) {
  return { e: { status, message } }
}

function parseJson(raw, fallback) {
  try {
    const v = JSON.parse(raw)
    return v === null || v === undefined ? fallback : v
  } catch {
    return fallback
  }
}

function emptyDoc() {
  return { trip: null, members: [], days: [], items: [], expenses: [], polls: [], votes: [], meetups: [], locations: [] }
}

// ───────────────────────── 归一化（白名单写入，与 trips.mjs 一一对应） ─────────────────────────

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

function withFhlc(rec, raw) {
  const fhlc = normFhlc(raw && raw.fhlc)
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

function normMeetup(raw, tripId) {
  if (!isPlainObject(raw) || !isSafeId(raw.id)) return null
  const created = ts(raw.createdAt)
  const updatedAt = ts(raw.updatedAt, created)
  return withFhlc(
    {
      id: raw.id,
      tripId,
      title: str(raw.title, 60, '集合点') || '集合点',
      address: str(raw.address, 120),
      lat: num(raw.lat, -90, 90, 0),
      lng: num(raw.lng, -180, 180, 0),
      createdAt: created,
      updatedAt,
      hlc: recordHlc(raw.hlc, updatedAt)
    },
    raw
  )
}

function normLocation(raw, tripId) {
  if (!isPlainObject(raw) || !isSafeId(raw.id)) return null
  const updatedAt = ts(raw.updatedAt)
  return withFhlc(
    {
      id: raw.id,
      tripId,
      memberId: str(raw.memberId, 64),
      lat: num(raw.lat, -90, 90, 0),
      lng: num(raw.lng, -180, 180, 0),
      accuracy: num(raw.accuracy, 0, 1e6, 0),
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
  vote: normVote,
  meetup: normMeetup,
  location: normLocation
}

function normDoc(raw, spaceId) {
  if (!isPlainObject(raw)) return null
  const out = {
    trip: normTrip(raw.trip, spaceId),
    members: [],
    days: [],
    items: [],
    expenses: [],
    polls: [],
    votes: [],
    meetups: [],
    locations: []
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

// ───────────────────────── 时钟 ─────────────────────────

function observeDoc(doc) {
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

function observeTombstones(tombstones) {
  let skewed = 0
  for (const t of tombstones) {
    if (clock.observe(t.hlc, t.deletedAt || 0).skewed) skewed += 1
  }
  return skewed
}

// ───────────────────────── 合并（与 trips.mjs 完全一致） ─────────────────────────

function isSpaceDeleted(space, cap) {
  if (!space) return false
  const capOf = cap || ((h) => h)
  let del = null
  for (const t of space.tombstones || []) {
    if (t.kind !== 'trip' || t.id !== space.id) continue
    const h = capOf(t.hlc)
    if (!del || hlcAfter(h, del)) del = h
  }
  if (!del) return false
  const rec = space.doc && space.doc.trip && space.doc.trip.hlc
  return !rec || !hlcAfter(capOf(rec), del)
}

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
  if (list.length <= MAX_TOMBSTONES) return list
  return [...list].sort((a, b) => cmpHlc(cap(b.hlc), cap(a.hlc))).slice(0, MAX_TOMBSTONES)
}

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

function mergeIntoSpace(space, doc, incomingTombstones, cap) {
  const stats = { added: 0, updated: 0, removed: 0, conflicts: 0 }
  const before = countRecords(space.doc)

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

  if (doc.trip) {
    space.doc.trip = put(space.doc.trip, doc.trip)
  }

  for (const kind of ARRAY_KINDS) {
    const key = DOC_KEY[kind]
    const map = new Map(space.doc[key].map((r) => [r.id, r]))
    for (const c of doc[key]) {
      map.set(c.id, put(map.get(c.id), c))
    }
    space.doc[key] = [...map.values()]
  }

  space.tombstones = pruneTombstones(mergeTombstones(space.tombstones, incomingTombstones, cap), cap)
  for (const kind of ARRAY_KINDS) {
    const key = DOC_KEY[kind]
    space.doc[key] = applyTombstones(space.doc[key], space.tombstones, kind, cap)
  }

  const after = countRecords(space.doc)
  stats.removed = Math.max(0, before + stats.added - after)
  return stats
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

function countRecords(doc) {
  let n = doc.trip ? 1 : 0
  for (const kind of ARRAY_KINDS) n += doc[DOC_KEY[kind]].length
  return n
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const byId = (a, b) => cmpStr(String(a.id), String(b.id))

function stableValue(v) {
  if (Array.isArray(v)) return v.map(stableValue)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = stableValue(v[k])
    return out
  }
  return v
}

function digestOf(space) {
  const doc = space.doc
  const canon = {
    trip: doc.trip || null,
    members: [...doc.members].sort(byId),
    days: [...doc.days].sort(byId),
    items: [...doc.items].sort(byId),
    expenses: [...(doc.expenses || [])].sort(byId),
    polls: [...(doc.polls || [])].sort(byId),
    votes: [...(doc.votes || [])].sort(byId),
    meetups: [...(doc.meetups || [])].sort(byId),
    locations: [...(doc.locations || [])].sort(byId)
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

function newSpace(id, author, ownerOpenid = '') {
  const now = Date.now()
  return {
    id,
    code: '',
    rev: 0,
    createdAt: now,
    updatedAt: now,
    updatedBy: author,
    ownerOpenid,
    retiredCodes: [],
    digest: '',
    tombstones: [],
    doc: emptyDoc()
  }
}

// ───────────────────────── 云数据库存储层（spaces/records/tombstones/members） ─────────────────────────

async function loadSpace(id) {
  const s = await docGet('spaces', id)
  if (!s) return null
  const space = {
    id,
    code: s.code || '',
    rev: s.rev | 0,
    createdAt: s.created_at || 0,
    updatedAt: s.updated_at || 0,
    updatedBy: s.updated_by || '',
    digest: s.digest || '',
    retiredCodes: parseJson(s.retired_codes, []),
    ownerOpenid: s.owner_openid || '',
    tombstones: [],
    doc: emptyDoc()
  }
  const [records, tombs] = await Promise.all([
    whereGet('records', { space_id: id }),
    whereGet('tombstones', { space_id: id })
  ])
  for (const t of tombs) {
    space.tombstones.push({
      kind: t.kind,
      id: t.id,
      deletedAt: t.deleted_at || 0,
      hlc: t.hlc ? decodeHlc(t.hlc) : hlcFromTs(t.deleted_at || 0)
    })
  }
  for (const r of records) {
    const rec = parseJson(r.data, null)
    if (!rec) continue
    if (!rec.hlc) rec.hlc = hlcFromTs(rec.updatedAt || 0)
    if (r.kind === 'trip') space.doc.trip = rec
    else if (DOC_KEY[r.kind]) space.doc[DOC_KEY[r.kind]].push(rec)
  }
  return space
}

async function saveSpace(space) {
  const trip = space.doc && space.doc.trip
  await docSet('spaces', space.id, {
    code: space.code || '',
    rev: space.rev | 0,
    created_at: space.createdAt || 0,
    updated_at: space.updatedAt || 0,
    updated_by: space.updatedBy || '',
    digest: space.digest || '',
    retired_codes: JSON.stringify(space.retiredCodes || []),
    owner_openid: space.ownerOpenid || '',
    title: (trip && trip.title) || '',
    destination: (trip && trip.destination) || '',
    start_date: (trip && trip.startDate) || '',
    end_date: (trip && trip.endDate) || ''
  })

  const recordDocs = []
  if (trip) {
    recordDocs.push({
      _id: `${space.id}:trip:${space.id}`,
      space_id: space.id,
      kind: 'trip',
      id: space.id,
      updated_at: trip.updatedAt || 0,
      hlc: encodeHlc(trip.hlc || hlcFromTs(trip.updatedAt || 0)),
      data: JSON.stringify(trip)
    })
  }
  for (const kind of ARRAY_KINDS) {
    for (const rec of (space.doc && space.doc[DOC_KEY[kind]]) || []) {
      recordDocs.push({
        _id: `${space.id}:${kind}:${rec.id}`,
        space_id: space.id,
        kind,
        id: rec.id,
        updated_at: rec.updatedAt || 0,
        hlc: encodeHlc(rec.hlc || hlcFromTs(rec.updatedAt || 0)),
        data: JSON.stringify(rec)
      })
    }
  }
  const tombDocs = (space.tombstones || []).map((t) => ({
    _id: `${space.id}:${t.kind}:${t.id}`,
    space_id: space.id,
    kind: t.kind,
    id: t.id,
    deleted_at: t.deletedAt || 0,
    hlc: encodeHlc(t.hlc || hlcFromTs(t.deletedAt || 0))
  }))

  await whereRemove('records', { space_id: space.id })
  await whereRemove('tombstones', { space_id: space.id })
  await writeDocs('records', recordDocs)
  await writeDocs('tombstones', tombDocs)
}

async function memberRoleOf(spaceId, openid) {
  if (!spaceId || !openid) return ''
  const m = await docGet('space_members', `${spaceId}:${openid}`)
  return m ? String(m.role || '') : ''
}

async function memberCountOf(spaceId) {
  return whereCount('space_members', { space_id: spaceId })
}

async function addMember(spaceId, openid, role = 'member', joinedAt = Date.now()) {
  if (!spaceId || !openid) return false
  const key = `${spaceId}:${openid}`
  const existing = await docGet('space_members', key)
  if (existing) return false // ON CONFLICT DO NOTHING 等价
  await docSet('space_members', key, {
    space_id: spaceId,
    openid,
    role: role === 'owner' ? 'owner' : 'member',
    joined_at: joinedAt
  })
  return true
}

// ───────────────────────── 空间列表 / 发现 / byCode ─────────────────────────

async function allSpaceRows() {
  const rows = await whereGet('spaces', {})
  return rows.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
}

async function hasOwner(dbLike, space) {
  if (!space) return false
  return !!space.ownerOpenid || (await memberCountOf(space.id)) > 0
}

async function accessVerdict(space, openid) {
  if (!space) return { ok: false, status: 404, message: 'not found', reason: 'missing' }
  if (!(await hasOwner(null, space))) return { ok: true, reason: 'orphan-open' }
  if (!openid) {
    return {
      ok: false,
      status: 403,
      message: 'this trip belongs to an account; sign in first',
      reason: 'anonymous-on-owned'
    }
  }
  if (space.ownerOpenid === openid) return { ok: true, reason: 'owner' }
  const role = await memberRoleOf(space.id, openid)
  if (role) return { ok: true, reason: 'member:' + role }
  return { ok: false, status: 403, message: 'not a member of this trip', reason: 'not-member' }
}

async function briefOf(space, viewerOpenid = '') {
  const cap = (h) => clock.cap(h)
  const t = space.doc.trip
  const owned = await hasOwner(null, space)
  const canSeeCode =
    !owned ||
    (!!viewerOpenid && (space.ownerOpenid === viewerOpenid || !!(await memberRoleOf(space.id, viewerOpenid))))
  return {
    id: space.id,
    ...(canSeeCode ? { code: space.code } : {}),
    rev: space.rev,
    deleted: isSpaceDeleted(space, cap),
    title: (t && t.title) || '未命名行程',
    destination: (t && t.destination) || '',
    startDate: (t && t.startDate) || '',
    endDate: (t && t.endDate) || '',
    updatedAt: space.updatedAt,
    updatedBy: space.updatedBy,
    counts: {
      members: space.doc.members.length,
      days: space.doc.days.length,
      items: space.doc.items.length,
      expenses: space.doc.expenses.length,
      polls: space.doc.polls.length,
      votes: space.doc.votes.length,
      meetups: space.doc.meetups.length,
      locations: space.doc.locations.length
    }
  }
}

async function listSpaces({ activeOnly = false, withDoc = false, viewerOpenid = '' } = {}) {
  const out = []
  for (const row of await allSpaceRows()) {
    const id = row._id || row.id
    const mine =
      !!viewerOpenid && (row.owner_openid === viewerOpenid || !!(await memberRoleOf(id, viewerOpenid)))
    const orphan =
      !row.owner_openid && (await memberCountOf(id)) === 0
    if (!mine && !orphan) continue
    const space = await loadSpace(id)
    if (!space) continue
    const brief = await briefOf(space, viewerOpenid)
    if (activeOnly && brief.deleted) continue
    if (!withDoc) {
      out.push(brief)
      continue
    }
    out.push({ ...brief, doc: space.doc, tombstones: space.tombstones })
  }
  return out
}

async function listDiscoverTrips(viewerOpenid = '') {
  const out = []
  for (const row of await allSpaceRows()) {
    const id = row._id || row.id
    const space = await loadSpace(id)
    if (!space) continue
    const brief = await briefOf(space, viewerOpenid)
    if (brief.deleted) continue
    const mine =
      !!viewerOpenid && (row.owner_openid === viewerOpenid || !!(await memberRoleOf(id, viewerOpenid)))
    out.push(mine ? { ...brief, mine } : { ...brief, code: undefined, mine })
  }
  return out
}

const GRACE_MS = 7 * 24 * 3600 * 1000

async function findSpaceByCode(code, { includeDeleted = false } = {}) {
  const cap = (h) => clock.cap(h)
  if (!code) return null

  const byCode = await whereGet('spaces', { code })
  const primary = byCode[0]
  if (primary) {
    const space = await loadSpace(primary._id || primary.id)
    if (space && (includeDeleted || !isSpaceDeleted(space, cap))) return space
  }

  // 曾用码宽限期扫描（数据量小，全表读）
  for (const row of await allSpaceRows()) {
    const list = parseJson(row.retired_codes, [])
    if (!Array.isArray(list) || !list.length) continue
    const live = list.some(
      (e) => e && typeof e === 'object' && e.code === code && Date.now() - e.retiredAt < GRACE_MS
    )
    if (!live) continue
    const space = await loadSpace(row._id || row.id)
    if (space && (includeDeleted || !isSpaceDeleted(space, cap))) return space
  }
  return null
}

async function allocateCode() {
  for (let i = 0; i < 50; i += 1) {
    const c = makeCode(6)
    if (!(await findSpaceByCode(c, { includeDeleted: true }))) return c
  }
  return makeCode(8)
}

// ───────────────────────── actions ─────────────────────────

async function setupCollections() {
  const names = ['spaces', 'records', 'tombstones', 'space_members']
  const detail = {}
  for (const name of names) {
    // 不在这里抛：建集合是部署期动作，把「哪个集合建失败、为什么」原样带回去，
    // 比 500 + 翻日志有用得多（真实环境第一次跑就是这么定位到已存在判断失灵的）。
    try {
      detail[name] = await ensureCollection(name)
    } catch (e) {
      detail[name] = { error: { errCode: e && e.errCode, errMsg: e && (e.errMsg || e.message) } }
    }
  }
  const ok = names.every((n) => typeof detail[n] === 'string')
  return { ok, collections: names, detail }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const ctxOpenid = String(OPENID || '')
  const loggedIn = event.loggedIn === true && !!ctxOpenid
  const openid = loggedIn ? ctxOpenid : ''

  try {
    switch (event.action) {
      case 'setup':
        // 首次部署后调用一次：创建所需集合（幂等，已存在则跳过）
        return await setupCollections()

      case 'list': {
        const withDoc = event.withDoc === true
        const activeOnly = event.active === true
        return { spaces: await listSpaces({ activeOnly, withDoc, viewerOpenid: openid }) }
      }

      case 'get': {
        const id = str(event.id, 64)
        if (!isSafeId(id)) return fail(400, 'invalid trip id')
        const space = await loadSpace(id)
        if (!space) return fail(404, 'not found')
        const brief = await briefOf(space, openid)
        return { space: { ...brief, doc: space.doc, tombstones: space.tombstones } }
      }

      case 'byCode': {
        const code = normalizeCode(event.code)
        if (!code) return fail(400, 'invalid code')
        const space = await findSpaceByCode(code)
        if (!space) return fail(404, 'code not found')
        const brief = await briefOf(space, openid)
        return { space: { ...brief, doc: space.doc, tombstones: space.tombstones } }
      }

      case 'join': {
        const code = normalizeCode(event.code)
        if (!code) return fail(400, 'invalid code')
        const space = await findSpaceByCode(code)
        if (!space) return fail(404, 'code not found')
        if (openid && (await hasOwner(null, space))) {
          await addMember(space.id, openid, 'member')
        }
        const brief = await briefOf(space, openid)
        return { space: { ...brief, doc: space.doc, tombstones: space.tombstones }, joined: !!openid }
      }

      case 'discover': {
        if (!openid) return fail(401, 'sign in required to browse discover')
        return { trips: await listDiscoverTrips(openid) }
      }

      case 'push': {
        const id = str(event.id, 64)
        if (!isSafeId(id)) return fail(400, 'invalid trip id')
        const author = str(event.author, 24, '匿名') || '匿名'
        const deviceId = str(event.deviceId, 64)
        const baseRev = int(event.baseRev, 0, 1e9, null)

        const rawDoc = event.doc
        const doc = rawDoc === null || rawDoc === undefined ? null : normDoc(rawDoc, id)
        if (rawDoc !== null && rawDoc !== undefined && doc === null) {
          return fail(400, 'invalid doc: trip 缺失或格式不合法')
        }
        const tombstones = normTombstones(event.tombstones, id)

        const skewed = (doc ? observeDoc(doc) : 0) + observeTombstones(tombstones)

        const reqNow = Date.now()
        const capReq = (h) => capHlc(h, reqNow, clock.maxSkewMs)

        if (doc) {
          const total = countRecords(doc)
          if (total > MAX_TOTAL_RECORDS) {
            return fail(413, `too many records (limit ${MAX_TOTAL_RECORDS})`)
          }
        }

        const existing = await loadSpace(id)
        if (existing) {
          const verdict = await accessVerdict(existing, openid)
          if (!verdict.ok) return fail(verdict.status, verdict.message)
        }

        const space = existing || newSpace(id, author, openid)
        if (!existing) space.code = await allocateCode()

        const revBefore = space.rev
        const staleBase = baseRev !== null && baseRev !== revBefore

        const beforeTotal = existing ? countRecords(existing.doc) : 0
        const beforeRows = {}
        for (const kind of Object.keys(KIND_LIMITS)) {
          beforeRows[kind] = existing ? (existing.doc[KIND_TO_FIELD[kind]] || []).length : 0
        }

        const applied = doc
          ? mergeIntoSpace(space, doc, tombstones, capReq)
          : mergeTombstonesOnly(space, tombstones, capReq)

        if (doc) {
          const total = countRecords(space.doc)
          if (total > MAX_TOTAL_RECORDS && total > beforeTotal) {
            return fail(413, `too many records (limit ${MAX_TOTAL_RECORDS})`)
          }
          for (const [kind, limit] of Object.entries(KIND_LIMITS)) {
            const rows = space.doc[KIND_TO_FIELD[kind]] || []
            if (rows.length > limit && rows.length > beforeRows[kind]) {
              return fail(413, `too many ${kind}s (limit ${limit})`)
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
        await saveSpace(space)

        if (!existing && openid) await addMember(id, openid, 'owner', space.createdAt)

        const brief = await briefOf(space, openid)
        return {
          space: brief,
          doc: space.doc,
          tombstones: space.tombstones,
          applied,
          changed,
          staleBase,
          skewed,
          serverRev: space.rev
        }
      }

      case 'delete': {
        const id = str(event.id, 64)
        if (!isSafeId(id)) return fail(400, 'invalid trip id')
        const space = await loadSpace(id)
        if (!space) return fail(404, 'not found')
        const verdict = await accessVerdict(space, openid)
        if (!verdict.ok) return fail(verdict.status, verdict.message)

        const nowTs = Date.now()
        const capDel = (h) => capHlc(h, nowTs, clock.maxSkewMs)
        space.tombstones = pruneTombstones(
          mergeTombstones(
            space.tombstones,
            [{ kind: 'trip', id, deletedAt: nowTs, hlc: clock.stamp() }],
            capDel
          ),
          capDel
        )
        const digest = digestOf(space)
        if (digest !== space.digest) {
          space.digest = digest
          space.rev += 1
        }
        space.updatedAt = Date.now()
        await saveSpace(space)
        return { ok: true, deleted: true }
      }

      case 'rotateCode': {
        const id = str(event.id, 64)
        if (!isSafeId(id)) return fail(400, 'invalid trip id')
        const cap = (h) => clock.cap(h)
        const space = await loadSpace(id)
        if (!space || isSpaceDeleted(space, cap)) return fail(404, 'not found')
        const verdict = await accessVerdict(space, openid)
        if (!verdict.ok) return fail(verdict.status, verdict.message)
        const old = space.code
        space.code = await allocateCode()
        const retired = (space.retiredCodes || []).map((c) =>
          typeof c === 'string' ? { code: c, retiredAt: 0 } : c
        )
        space.retiredCodes = [...retired, { code: old, retiredAt: Date.now() }].slice(-3)
        space.updatedAt = Date.now()
        await saveSpace(space)
        return { code: space.code, previous: old }
      }

      case 'claim': {
        const id = str(event.id, 64)
        if (!isSafeId(id)) return fail(400, 'invalid trip id')
        if (!openid) return fail(401, 'sign in required to claim a trip')
        const code = normalizeCode(event.code)
        if (!code) return fail(400, 'invalid code')
        const found = await findSpaceByCode(code)
        if (!found || found.id !== id) return fail(403, 'code does not match this trip')
        if (await hasOwner(null, found)) return fail(409, 'trip already has an owner')

        found.ownerOpenid = openid
        found.updatedAt = Date.now()
        found.updatedBy = `owner:${openid.slice(0, 8)}`
        await saveSpace(found)
        await addMember(id, openid, 'owner')
        const brief = await briefOf(found, openid)
        return { ok: true, space: brief, revokedSubscriptions: 0 }
      }

      default:
        return fail(400, 'unknown action: ' + event.action)
    }
  } catch (e) {
    console.error('[trips:error]', event.action, String((e && e.message) || e))
    return fail(500, 'internal error')
  }
}

// 供部署期初始化使用
exports._setup = setupCollections