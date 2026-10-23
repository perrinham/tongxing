/**
 * 迁移云函数 —— 把 scripts/migrate-export.mjs 导出的 SQLite 快照写入云数据库。
 *
 * 一次性使用，导入完成后应**删除本云函数**（它自带整库快照，长期留着不合适）。
 *
 * 表 → 集合是 1:1 映射（见 _lib/store.js 的字段说明），所以这里只做「加 _id + 批量覆盖写」：
 *   spaces        _id = id
 *   records       _id = space_id:kind:id
 *   tombstones    _id = space_id:kind:id
 *   guides        _id = id
 *   space_members _id = space_id:openid
 *
 * 幂等：全部走 doc.set 覆盖写，可重复调用（先删后导也安全）。
 *
 * event：{ action:'plan' | 'run', only?: 'spaces'|'records'|... }
 *   plan 只回报将写入的行数（不落库），run 真正写入并回报计数。
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const { ensureCollection, docSet, writeDocs } = require('./_lib/store')

const snapshot = require('./snapshot.json')

const TABLES = ['spaces', 'records', 'tombstones', 'guides', 'space_members']

const COLLECTIONS = {
  spaces: 'spaces',
  records: 'records',
  tombstones: 'tombstones',
  guides: 'guides',
  space_members: 'space_members'
}

function idOf(table, row) {
  if (table === 'spaces' || table === 'guides') return String(row.id)
  if (table === 'space_members') return `${row.space_id}:${row.openid}`
  return `${row.space_id}:${row.kind}:${row.id}` // records / tombstones
}

function fail(status, message) {
  return { e: { status, message } }
}

exports.main = async (event) => {
  const action = event.action === 'run' ? 'run' : 'plan'
  const only = event.only ? String(event.only) : ''
  const tables = only ? [only] : TABLES
  if (tables.some((t) => !TABLES.includes(t))) {
    return fail(400, 'unknown table: ' + only)
  }

  const plan = {}
  for (const t of tables) plan[t] = Array.isArray(snapshot[t]) ? snapshot[t].length : 0

  if (action === 'plan') {
    return { ok: true, action, plan }
  }

  try {
    const written = {}
    for (const t of tables) {
      const rows = Array.isArray(snapshot[t]) ? snapshot[t] : []
      const coll = COLLECTIONS[t]
      await ensureCollection(coll)

      // spaces / guides 行数少，逐条 set；records/tombstones 可能很多，走批量分片。
      if (t === 'spaces' || t === 'guides') {
        for (const row of rows) {
          const { id, ...rest } = row
          await docSet(coll, idOf(t, row), rest)
        }
      } else {
        const docs = rows.map((row) => {
          const { space_id, kind, id, ...rest } = row
          return { _id: idOf(t, row), space_id, kind, id, ...rest }
        })
        await writeDocs(coll, docs)
      }
      written[t] = rows.length
    }
    return { ok: true, action, written }
  } catch (e) {
    console.error('[migrate:error]', String((e && e.message) || e))
    return fail(500, 'migration failed: ' + String((e && e.message) || e))
  }
}