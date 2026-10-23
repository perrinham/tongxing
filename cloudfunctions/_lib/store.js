/**
 * 云数据库存储层公共助手 —— 云函数侧的 CommonJS。
 *
 * 被 trips / guides 云函数共用（含 _lib 同步副本，由 scripts/cloud-lib-sync.mjs 生成）。
 *
 * ⚠️ wx-server-sdk 的数据库 API 是**文档型**，与 SQLite 的差异：
 *   - 无「复合主键 upsert」，用 `doc(id).set()` 做幂等覆盖；
 *   - `where().remove()` 批量删；
 *   - `doc(id).get()` 不存在时会 **throw**（errCode -502004 / 'document.not.exists'）。
 * 所以「读一条不存在的文档」必须用 try/catch 兜成 null。
 *
 * 各集合的文档结构与字段命名（与 CLOUD_MIGRATION_PLAN.md 第 4 节一致）：
 *   spaces        _id = spaceId；字段 code/rev/created_at/updated_at/updated_by/digest/
 *                 retired_codes/owner_openid/title/destination/start_date/end_date
 *   records       _id = `spaceId:kind:id`；字段 space_id/kind/id/updated_at/hlc(编码串)/data(JSON 串)
 *   tombstones    _id = `spaceId:kind:id`；字段 space_id/kind/id/deleted_at/hlc(编码串)
 *   guides        _id = guideId；字段 city_name/author/author_openid/status/created_at/updated_at/data(JSON 串)
 *   space_members _id = `spaceId:openid`；字段 space_id/openid/role/joined_at
 *
 * hlc 在库里存**编码后的定长字符串**（与 SQLite 存 encodeHlc 一致），读出时解码。
 */

let _db = null

/** 云数据库单次查询 / 单次批量删除的记录数上限（服务端 SDK） */
const QUERY_MAX = 1000
/**
 * 无上限查询的兜底扫描量。默认「读全」而不是「读一页」——注意别把 QUERY_MAX
 * 当成默认返回值上限用（那样等于还是只读一页）。5 倍于 MAX_TOTAL_RECORDS，纯兜底。
 */
const QUERY_SCAN_MAX = 100000

function getDb() {
  if (_db) return _db
  const cloud = require('wx-server-sdk')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
  _db = cloud.database()
  return _db
}

/** 不存在就建集合；已存在（-502005）则跳过。名字来自固定白名单，不做用户输入。 */
async function ensureCollection(name) {
  const db = getDb()
  try {
    await db.createCollection(name)
    return 'created'
  } catch (e) {
    // 已存在不算失败。云开发这条错误的 errCode 在不同版本/调用路径下并不统一
    // （实测 errCode 缺失、只有 errMsg），所以 errCode 与文案**双判**，缺一不可。
    const code = Number(e && (e.errCode || e.code))
    const msg = String((e && (e.errMsg || e.message)) || '')
    if (code === -502005 || /already exist|already exists|已存在|exist/i.test(msg)) return 'exists'
    throw e
  }
}

function normalizeCond(cond) {
  const out = {}
  for (const k of Object.keys(cond || {})) {
    const v = cond[k]
    if (v === undefined || v === null || v === '') continue
    out[k] = v
  }
  return out
}

/** 读单条；不存在返回 null（不抛） */
async function docGet(coll, id) {
  const db = getDb()
  try {
    const r = await db.collection(coll).doc(id).get()
    return r && r.data ? r.data : null
  } catch {
    return null
  }
}

/** 单条幂等覆盖。data 里不要带 _id（doc 路径本身就是 id）。 */
async function docSet(coll, id, data) {
  const db = getDb()
  const { _id, ...rest } = data || {}
  return db.collection(coll).doc(id).set({ data: rest })
}

/** 批量写：每批 doc 形如 { _id, ...fields }，分片并发避免打满单次并发配额 */
async function writeDocs(coll, docs, batch = 20) {
  const db = getDb()
  if (!docs || !docs.length) return
  for (let i = 0; i < docs.length; i += batch) {
    const slice = docs.slice(i, i + batch)
    await Promise.all(
      slice.map((d) => {
        const { _id, ...rest } = d
        return db.collection(coll).doc(_id).set({ data: rest })
      })
    )
  }
}

/**
 * 条件查询。
 *
 * ⚠️ 云数据库**单次查询最多返回 1000 条**（服务端 SDK 的上限；不写 limit 时默认只有
 * 100 条）。而一个空间按 KIND_LIMITS / MAX_TOTAL_RECORDS 允许存到 20000 条记录，
 * 所以「一次 limit(1000) 读完」会**静默截断**：表现是别人的大行程在我这边少了记录，
 * 更糟的是 push 的 saveSpace 会「先清空 records 再按读到的写回」，被截断的部分
 * 就此永久消失。这里必须翻页读全（SQLite 参考实现没有这个上限，是迁移引入的坑）。
 *
 * 翻页用 `_id` 排序 + skip：`_id` 天然有索引，且排序稳定，不会漏读/重读。
 */
async function whereGet(coll, cond, limit = QUERY_SCAN_MAX) {
  const db = getDb()
  const c = normalizeCond(cond)
  const pageSize = Math.min(QUERY_MAX, Math.max(1, limit))
  const out = []
  for (let skip = 0; out.length < limit; skip += pageSize) {
    const base = Object.keys(c).length ? db.collection(coll).where(c) : db.collection(coll)
    const r = await base.orderBy('_id', 'asc').skip(skip).limit(pageSize).get()
    const rows = (r && r.data) || []
    out.push(...rows)
    if (rows.length < pageSize) break
  }
  return out.slice(0, limit)
}

async function whereCount(coll, cond) {
  const db = getDb()
  const c = normalizeCond(cond)
  const q = Object.keys(c).length ? db.collection(coll).where(c) : db.collection(coll)
  const r = await q.count()
  return Number((r && r.total) ?? 0)
}

/**
 * 条件批量删除（返回删除条数）。
 *
 * ⚠️ 与 whereGet 同理：单次批量删除有 1000 条的量级上限（服务端行为在不同
 * 版本下并不统一）。循环删到「一次删不满一页」为止，两种语义下都收敛：
 * 若一次就全删完，第二轮返回 0 即退出；若单次封顶 1000，则删几轮直到删完。
 */
async function whereRemove(coll, cond) {
  const db = getDb()
  const c = normalizeCond(cond)
  if (!Object.keys(c).length) return 0
  let removedTotal = 0
  for (;;) {
    const r = await db.collection(coll).where(c).remove()
    const removed = r && r.stats ? Number(r.stats.removed ?? 0) : 0
    removedTotal += removed
    if (removed < QUERY_MAX) break
  }
  return removedTotal
}

/** 按 _id 删除单条；不存在（-502004）视为成功 */
async function docRemove(coll, id) {
  const db = getDb()
  try {
    await db.collection(coll).doc(id).remove()
  } catch {
    // 不存在 -> 幂等成功
  }
  return 1
}

module.exports = {
  getDb,
  ensureCollection,
  docGet,
  docSet,
  writeDocs,
  whereGet,
  whereCount,
  whereRemove,
  docRemove
}