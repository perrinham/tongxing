/**
 * SQLite 存储层 —— 零依赖，用 Node 22 内置的 node:sqlite。
 *
 * ── 为什么从「单文件 JSON」换过来 ──
 *
 * 旧实现把整库放在一个 JS 对象里，每次改动都 JSON.stringify 全库再原子替换。空间多了以后有两个硬伤：
 *   1. 改一个行程要序列化并重写**所有**行程 —— 写放大和延迟随数据量线性增长；
 *   2. 没有查询能力：列表接口必须把全库读进内存才能排序、过滤、算 counts。
 *
 * 换 SQLite 之后：
 *   · 写入以「空间」为事务边界，其他空间一个字节都不碰；
 *   · 列表/统计走 SQL（索引 + 冗余投影），不必反序列化文档；
 *   · 事务 + WAL 提供崩溃安全，不再需要 .tmp / .bak 那套手工兜底。
 *
 * ── 表结构 ──
 *   meta         schema 版本等元信息
 *   spaces       空间元信息 + 供列表使用的冗余投影（title / destination / 起止日期）
 *   records      空间内所有实体（trip / member / day / item / expense），data 列存 JSON
 *   tombstones   删除墓碑，(space_id, kind, id) 唯一
 *   guides       城市攻略 / 评价
 *
 * 「records.data 存 JSON」是刻意的取舍：合并逻辑按**整条记录**做 LWW，不按字段拆列，
 * 所以把记录当黑盒存最省事、最不容易出错；只有真正需要按列查询/排序/计数的少数字段，
 * 才在 spaces 上做冗余投影。同理，schema 里已经预留 owner_openid（账号体系用），
 * 免得后面再迁一次表。
 */

import { existsSync, readFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
import { decodeHlc, encodeHlc, hlcAfter, hlcFromTs } from './hlc.mjs'
import { log } from './log.mjs'

// node:sqlite 在 Node 22 上仍会打一条 ExperimentalWarning。这里在**加载它之前**先滤掉这一条，
// 免得每次启动都往日志里冒噪音；其他警告照常透传。
// （如果要更彻底，也可以给 node 加 --disable-warning=ExperimentalWarning，但那要求调用方记得带参数。）
const _emitWarning = process.emitWarning.bind(process)
process.emitWarning = (warning, ...rest) => {
  const msg = typeof warning === 'string' ? warning : warning?.message ?? ''
  if (msg.includes('SQLite is an experimental feature')) return
  return _emitWarning(warning, ...rest)
}

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const SCHEMA_VERSION = 2

/** 集合名 → doc 里的键（与 routes/trips.mjs 保持一致） */
const DOC_KEY = { member: 'members', day: 'days', item: 'items', expense: 'expenses' }
const ARRAY_KINDS = ['member', 'day', 'item', 'expense']

/** 攻略表里单独提列、其余进 data JSON 的字段 */
const GUIDE_COLUMNS = ['status']
const GUIDE_JSON_FIELDS = ['visitDate', 'guide', 'review', 'rating', 'wishNote']

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spaces (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL DEFAULT '',
  rev           INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL DEFAULT 0,
  updated_by    TEXT NOT NULL DEFAULT '',
  digest        TEXT NOT NULL DEFAULT '',
  retired_codes TEXT NOT NULL DEFAULT '[]',
  owner_openid  TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  destination   TEXT NOT NULL DEFAULT '',
  start_date    TEXT NOT NULL DEFAULT '',
  end_date      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_spaces_code ON spaces(code);
CREATE INDEX IF NOT EXISTS idx_spaces_updated ON spaces(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_spaces_owner ON spaces(owner_openid);

CREATE TABLE IF NOT EXISTS records (
  space_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  id         TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  hlc        TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL,
  PRIMARY KEY (space_id, kind, id)
);
CREATE INDEX IF NOT EXISTS idx_records_space_kind ON records(space_id, kind);

CREATE TABLE IF NOT EXISTS tombstones (
  space_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  id         TEXT NOT NULL,
  deleted_at INTEGER NOT NULL DEFAULT 0,
  hlc        TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (space_id, kind, id)
);

CREATE TABLE IF NOT EXISTS guides (
  id         TEXT PRIMARY KEY,
  city_name  TEXT NOT NULL,
  author     TEXT NOT NULL,
  author_openid TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'visited',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_guides_city ON guides(city_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guides_city_author ON guides(city_name, author);
CREATE INDEX IF NOT EXISTS idx_guides_openid ON guides(author_openid);
CREATE INDEX IF NOT EXISTS idx_guides_updated ON guides(updated_at DESC);

-- 空间成员：谁能读写这个行程空间。
--
-- 为什么单独一张表而不是复用 spaces.owner_openid：owner 只有一个，而一次旅行
-- 天然是多人协作，「有权写」的是**成员集合**。把 owner 也作为 role='owner' 的一行写进来，
-- 判定就退化成一次存在性查询，不必到处写「是 owner 还是 member」的分支。
CREATE TABLE IF NOT EXISTS space_members (
  space_id   TEXT NOT NULL,
  openid     TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member',
  joined_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (space_id, openid)
);
CREATE INDEX IF NOT EXISTS idx_members_openid ON space_members(openid);
`

function parseJson(raw, fallback) {
  try {
    const v = JSON.parse(raw)
    return v === null || v === undefined ? fallback : v
  } catch {
    return fallback
  }
}

function emptyDoc() {
  return { trip: null, members: [], days: [], items: [], expenses: [] }
}

/**
 * 空间是否已被删除（trip 记录的 HLC 不晚于 trip 墓碑的 HLC）。
 *
 * 判断口径与合并规则是同一套：记录比墓碑**新**视为「删后又改」，以改为准。
 * 只在 db 层定义一次，路由直接从这儿引，避免两边各写一遍后走偏。
 *
 * @param cap 时钟封顶函数（由 clock 注入）。库里的时间戳可能来自时钟不准的设备，
 *            凡是比较都必须走同一套封顶口径，否则不同路径会给出互相矛盾的答案。
 */
export function isSpaceDeleted(space, cap = null) {
  if (!space) return false
  const capOf = cap || ((h) => h)
  let del = null
  for (const t of space.tombstones || []) {
    if (t.kind !== 'trip' || t.id !== space.id) continue
    const h = capOf(t.hlc)
    if (!del || hlcAfter(h, del)) del = h
  }
  if (!del) return false
  const rec = space.doc?.trip?.hlc
  return !rec || !hlcAfter(capOf(rec), del)
}

export function createDb({ file, legacyJsonFile = null, clock = null } = {}) {
  if (!file) throw new Error('createDb: file is required')

  // 时钟封顶口径由注入的 clock 决定；不传就是「不封顶」（等于旧行为）
  const cap = clock ? (h) => clock.cap(h) : (h) => h

  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const handle = new DatabaseSync(file)

  // WAL：读写不互相阻塞，且崩溃后能自动恢复到一致状态。
  // synchronous=NORMAL 在 WAL 下已足够安全（丢了也只是最后一个事务），换来明显的写入速度。
  handle.exec('PRAGMA journal_mode = WAL')
  handle.exec('PRAGMA synchronous = NORMAL')
  handle.exec('PRAGMA busy_timeout = 5000')
  handle.exec(SCHEMA)

  /**
   * 老库升级用：`CREATE TABLE IF NOT EXISTS` 不会给**已存在**的表补列，
   * 所以每次新增字段都要在这里显式检查 + ALTER，这样从上一版库升级也不会丢数据。
   */
  function ensureColumn(table, column, ddl) {
    const cols = handle.prepare(`PRAGMA table_info(${table})`).all()
    if (cols.some((c) => c.name === column)) return
    handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    log.info('存储结构升级：已补列', { table, column })
  }
  ensureColumn('records', 'hlc', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('tombstones', 'hlc', "TEXT NOT NULL DEFAULT ''")
  // 账号体系（Step 4）：攻略的作者从「自填昵称」升级为 openid 可校验归属
  ensureColumn('guides', 'author_openid', "TEXT NOT NULL DEFAULT ''")

  handle.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))

  // ── 预编译语句（热路径上反复用，避免每次重新 parse SQL）──
  const S = {
    upsertSpace: handle.prepare(`
      INSERT INTO spaces (id, code, rev, created_at, updated_at, updated_by, digest, retired_codes, owner_openid, title, destination, start_date, end_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        code = excluded.code, rev = excluded.rev, updated_at = excluded.updated_at,
        updated_by = excluded.updated_by, digest = excluded.digest, retired_codes = excluded.retired_codes,
        owner_openid = excluded.owner_openid, title = excluded.title, destination = excluded.destination,
        start_date = excluded.start_date, end_date = excluded.end_date
    `),
    getSpace: handle.prepare('SELECT * FROM spaces WHERE id = ?'),
    spaceIdByCode: handle.prepare('SELECT id FROM spaces WHERE code = ? LIMIT 1'),
    retiredCandidates: handle.prepare('SELECT id, retired_codes FROM spaces WHERE retired_codes LIKE ?'),
    countSpaces: handle.prepare('SELECT COUNT(*) AS n FROM spaces'),

    delRecords: handle.prepare('DELETE FROM records WHERE space_id = ?'),
    insRecord: handle.prepare(
      'INSERT INTO records (space_id, kind, id, updated_at, hlc, data) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    listRecords: handle.prepare('SELECT kind, id, hlc, data FROM records WHERE space_id = ?'),
    delTombstones: handle.prepare('DELETE FROM tombstones WHERE space_id = ?'),
    insTombstone: handle.prepare(
      'INSERT INTO tombstones (space_id, kind, id, deleted_at, hlc) VALUES (?, ?, ?, ?, ?)'
    ),
    listTombstones: handle.prepare('SELECT kind, id, deleted_at, hlc FROM tombstones WHERE space_id = ?'),

    // 列表专用：一次查询拿到 brief 所需的全部信息（含已删判定与各集合条数），**不加载文档**。
    // 这里只取**原始** hlc，封顶放在 JS 侧做（briefFromRow）—— 因为封顶依赖「当前时刻」，
    // 而 SQL 里没法干净地表达「按 now 封顶后再比大小」，两边各写一套必然走偏。
    listBriefs: handle.prepare(`
      SELECT s.id, s.code, s.rev, s.updated_at, s.updated_by, s.owner_openid,
             s.title, s.destination, s.start_date, s.end_date,
             (SELECT r.hlc FROM records r WHERE r.space_id = s.id AND r.kind = 'trip' AND r.id = s.id) AS trip_hlc,
             (SELECT MAX(t.hlc) FROM tombstones t WHERE t.space_id = s.id AND t.kind = 'trip' AND t.id = s.id) AS trip_del_hlc,
             (SELECT COUNT(*) FROM records r WHERE r.space_id = s.id AND r.kind = 'member')  AS n_member,
             (SELECT COUNT(*) FROM records r WHERE r.space_id = s.id AND r.kind = 'day')     AS n_day,
             (SELECT COUNT(*) FROM records r WHERE r.space_id = s.id AND r.kind = 'item')    AS n_item,
             (SELECT COUNT(*) FROM records r WHERE r.space_id = s.id AND r.kind = 'expense') AS n_expense
      FROM spaces s
      ORDER BY s.updated_at DESC
    `),

    upsertGuide: handle.prepare(`
      INSERT INTO guides (id, city_name, author, author_openid, status, created_at, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        city_name = excluded.city_name, author = excluded.author,
        author_openid = excluded.author_openid, status = excluded.status,
        updated_at = excluded.updated_at, data = excluded.data
    `),
    getGuide: handle.prepare('SELECT * FROM guides WHERE id = ?'),
    getGuideOwner: handle.prepare('SELECT author_openid FROM guides WHERE id = ?'),
    getGuideByCityAuthor: handle.prepare('SELECT * FROM guides WHERE city_name = ? AND author = ? LIMIT 1'),
    getGuideOwnerByCityAuthor: handle.prepare(
      'SELECT author_openid FROM guides WHERE city_name = ? AND author = ? LIMIT 1'
    ),
    listGuides: handle.prepare('SELECT * FROM guides'),
    listGuidesByStatus: handle.prepare('SELECT * FROM guides WHERE status = ?'),
    listGuidesByCity: handle.prepare('SELECT * FROM guides WHERE city_name = ?'),
    listGuidesByOpenid: handle.prepare('SELECT * FROM guides WHERE author_openid = ? ORDER BY updated_at DESC'),
    delGuide: handle.prepare('DELETE FROM guides WHERE id = ?'),
    delGuidesByCityAuthor: handle.prepare('DELETE FROM guides WHERE city_name = ? AND author = ?'),
    delGuidesByCityOpenid: handle.prepare('DELETE FROM guides WHERE city_name = ? AND author_openid = ?'),
    countGuides: handle.prepare('SELECT COUNT(*) AS n FROM guides'),

    // ── 空间成员（账号体系的授权依据）──
    addMember: handle.prepare(`
      INSERT INTO space_members (space_id, openid, role, joined_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(space_id, openid) DO NOTHING
    `),
    getMember: handle.prepare('SELECT role FROM space_members WHERE space_id = ? AND openid = ?'),
    listMembers: handle.prepare(
      'SELECT openid, role, joined_at FROM space_members WHERE space_id = ? ORDER BY joined_at ASC'
    ),
    countMembers: handle.prepare('SELECT COUNT(*) AS n FROM space_members WHERE space_id = ?'),
    /** 我参与的空间 id（用于「按用户隔离行程列表」） */
    spaceIdsOfMember: handle.prepare('SELECT space_id FROM space_members WHERE openid = ?'),
    delMembers: handle.prepare('DELETE FROM space_members WHERE space_id = ?'),
    countAllMembers: handle.prepare('SELECT COUNT(*) AS n FROM space_members')
  }

  let closed = false
  let inTx = false

  /**
   * 事务。支持嵌套：SQLite 不允许在已有事务里再 BEGIN，而迁移这类批量操作
   * 天然是「外层一个大事务，里面逐个 saveSpace」的结构，所以这里做扁平化 ——
   * 内层直接复用外层事务，原子性由最外层负责（内层抛错会冒泡出去让外层回滚）。
   */
  function tx(fn) {
    if (inTx) return fn()
    inTx = true
    handle.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      handle.exec('COMMIT')
      return out
    } catch (e) {
      try {
        handle.exec('ROLLBACK')
      } catch {
        /* 回滚失败也要把原始错误抛出去 */
      }
      throw e
    } finally {
      inTx = false
    }
  }

  // ───────────────────────── 空间 ─────────────────────────

  function loadSpace(id) {
    const row = S.getSpace.get(id)
    if (!row) return null

    const space = {
      id: row.id,
      code: row.code,
      rev: row.rev,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      digest: row.digest,
      retiredCodes: parseJson(row.retired_codes, []),
      ownerOpenid: row.owner_openid || '',
      tombstones: S.listTombstones.all(id).map((t) => ({
        kind: t.kind,
        id: t.id,
        deletedAt: t.deleted_at,
        hlc: t.hlc ? decodeHlc(t.hlc) : hlcFromTs(t.deleted_at)
      })),
      doc: emptyDoc()
    }

    for (const r of S.listRecords.all(id)) {
      const rec = parseJson(r.data, null)
      if (!rec) continue
      // 补齐 HLC：HLC 之前落库的记录只有 updatedAt，用 updatedAt 当 t、节点号用全零占位，
      // 这样新旧记录能放在同一把尺子上比较（同刻时旧格式让位给新格式）
      if (!rec.hlc) rec.hlc = hlcFromTs(rec.updatedAt || 0)
      if (r.kind === 'trip') space.doc.trip = rec
      else if (DOC_KEY[r.kind]) space.doc[DOC_KEY[r.kind]].push(rec)
    }
    return space
  }

  /**
   * 保存整个空间（空间级原子）。
   *
   * 为什么不做「只写改动的那几条」：客户端推上来的本来就是**整份**快照，
   * 记录集合是完整的；空间内最多几千条，全量重写在一次事务里是毫秒级。
   * 真正的收益在于**只重写这一个空间** —— 其他空间完全不参与，这才是相对旧 JSON 方案的关键改进。
   */
  function saveSpace(space) {
    const trip = space.doc?.trip || null
    tx(() => {
      S.upsertSpace.run(
        space.id,
        space.code || '',
        space.rev | 0,
        space.createdAt || 0,
        space.updatedAt || 0,
        space.updatedBy || '',
        space.digest || '',
        JSON.stringify(space.retiredCodes || []),
        space.ownerOpenid || '',
        trip?.title || '',
        trip?.destination || '',
        trip?.startDate || '',
        trip?.endDate || ''
      )

      S.delRecords.run(space.id)
      if (trip) {
        S.insRecord.run(
          space.id,
          'trip',
          space.id,
          trip.updatedAt || 0,
          encodeHlc(trip.hlc ?? hlcFromTs(trip.updatedAt || 0)),
          JSON.stringify(trip)
        )
      }
      for (const kind of ARRAY_KINDS) {
        for (const rec of space.doc[DOC_KEY[kind]] || []) {
          S.insRecord.run(
            space.id,
            kind,
            rec.id,
            rec.updatedAt || 0,
            encodeHlc(rec.hlc ?? hlcFromTs(rec.updatedAt || 0)),
            JSON.stringify(rec)
          )
        }
      }

      S.delTombstones.run(space.id)
      for (const t of space.tombstones || []) {
        S.insTombstone.run(
          space.id,
          t.kind,
          t.id,
          t.deletedAt || 0,
          encodeHlc(t.hlc ?? hlcFromTs(t.deletedAt || 0))
        )
      }
    })
  }

  function briefFromRow(row) {
    // 已删判定：SQL 只取原始 hlc，封顶与比较都在这里做，保证与路由侧的判定口径一致。
    // 有 trip 墓碑，且 trip 记录的（封顶后）时间不晚于墓碑 ⇒ 已删。
    const recHlc = row.trip_hlc ? decodeHlc(row.trip_hlc) : null
    const delHlc = row.trip_del_hlc ? decodeHlc(row.trip_del_hlc) : null
    const deleted = delHlc !== null && (recHlc === null || !hlcAfter(cap(recHlc), cap(delHlc)))
    return {
      id: row.id,
      code: row.code,
      rev: row.rev,
      deleted,
      title: row.title || '未命名行程',
      destination: row.destination || '',
      startDate: row.start_date || '',
      endDate: row.end_date || '',
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      counts: {
        members: row.n_member,
        days: row.n_day,
        items: row.n_item,
        expenses: row.n_expense
      }
    }
  }

  /**
   * 空间列表。
   *
   * ⚠️ 默认**包含**已删除的空间（带 deleted:true）—— 这是同步协议的要求：
   * 列表一旦把已删空间藏起来，别的设备就永远收不到「这个行程被删了」这个事实，会一直留着陈旧副本。
   * 想只看在用的，传 activeOnly。
   *
   * @param viewerOpenid 「我参与的 ∪ 无主的」；**匿名（空）同样只返回无主空间**。
   *   ⚠️ 无主空间（owner_openid 为空且没有任何成员行）必须保留：它们是接账号体系
   *   之前的存量数据，谁也不知道该归谁；一刀切隐藏会让用户以为「我的行程丢了」。
   *   ⚠️ 匿名绝不能返回全部：未登录的冷启动会拉匿名列表做全量同步，返回全部等于
   *   把别人的行程并进本地 —— 随后本地按「有这行程 → 可编辑」判定，越权入口就是这么来的。
   */
  function listSpaces({ activeOnly = false, withDoc = false, viewerOpenid = '' } = {}) {
    const mine = viewerOpenid ? new Set(S.spaceIdsOfMember.all(viewerOpenid).map((r) => r.space_id)) : new Set()
    const out = []
    for (const row of S.listBriefs.all()) {
      const isMine = !!viewerOpenid && (mine.has(row.id) || row.owner_openid === viewerOpenid)
      const isOrphan = !row.owner_openid && S.countMembers.get(row.id).n === 0
      if (!isMine && !isOrphan) continue
      const brief = briefFromRow(row)
      if (activeOnly && brief.deleted) continue
      if (!withDoc) {
        out.push(brief)
        continue
      }
      const space = loadSpace(row.id)
      out.push({ ...brief, doc: space.doc, tombstones: space.tombstones })
    }
    return out
  }

  /**
   * 发现广场列表：全部未删除空间的 brief + `mine` 标记。
   *
   * 与 listSpaces 的区别：不做「我参与 ∪ 无主」过滤 —— 广场的语义恰恰是
   * 「所有登录用户都能看到全部行程」。mine 只用来给前端区分「我的 / 他人的」，
   * 不代表读权限差异（读本就开放，写由 lib/acl.mjs 的 accessVerdict 保护）。
   *
   * ⚠️ 响应层还须把非 mine 条目的 code 剥掉（见 routes/trips.mjs）——
   * 分享码等于「加入即写权」，不能随广场广播。
   */
  function listSpacesBriefForDiscover(viewerOpenid = '') {
    const memberOf = viewerOpenid
      ? new Set(S.spaceIdsOfMember.all(viewerOpenid).map((r) => r.space_id))
      : null
    const out = []
    for (const row of S.listBriefs.all()) {
      const brief = briefFromRow(row)
      if (brief.deleted) continue
      const mine =
        !!viewerOpenid && (row.owner_openid === viewerOpenid || (memberOf && memberOf.has(row.id)))
      out.push(mine ? { ...brief, mine } : { ...brief, code: undefined, mine })
    }
    return out
  }

  /** 按分享码找空间：先用当前码走索引，再回退到曾用名（retiredCodes）里精确比对 */
  function findSpaceByCode(code, { includeDeleted = false } = {}) {
    if (!code) return null

    const hit = S.spaceIdByCode.get(code)
    if (hit) {
      const space = loadSpace(hit.id)
      if (space && (includeDeleted || !isSpaceDeleted(space, cap))) return space
    }

    // LIKE 只用来粗筛候选（命中索引不了但数据量小），最终以 JS 里的数组比对为准，
    // 避免 '"AB12CD"' 这种子串误匹配。
    for (const row of S.retiredCandidates.all(`%"${code}"%`)) {
      const list = parseJson(row.retired_codes, [])
      if (!Array.isArray(list) || !list.includes(code)) continue
      const space = loadSpace(row.id)
      if (space && (includeDeleted || !isSpaceDeleted(space, cap))) return space
    }
    return null
  }

  function hasSpace(id) {
    return S.getSpace.get(id) != null
  }

  // ───────────────────────── 攻略 ─────────────────────────

  function assembleGuide(row) {
    // ⚠️ 刻意**不**带出 author_openid。
    //
    // openid 是用户在本小程序内的稳定标识，把它塞进列表响应等于把所有人的
    // 身份标识广播给每个调用者（而且会被客户端缓存、被日志打到）。需要归属判定的
    // 地方（撤回 / 更新自己的攻略）走下面的 guideOwnerOf / guideOwnerByCityAuthor，
    // 「不放进返回对象」比「放进去再记得删掉」可靠得多。
    return {
      id: row.id,
      cityName: row.city_name,
      author: row.author,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...parseJson(row.data, {})
    }
  }

  /** 攻略的归属 openid（仅授权判定用，绝不进入响应体）；没有归属返回 '' */
  function guideOwnerOf(id) {
    const row = S.getGuideOwner.get(id)
    return row ? row.author_openid || '' : ''
  }

  function guideOwnerByCityAuthor(cityName, author) {
    const row = S.getGuideOwnerByCityAuthor.get(cityName, author)
    return row ? row.author_openid || '' : ''
  }

  function saveGuide(g) {
    const extra = {}
    for (const f of GUIDE_JSON_FIELDS) {
      if (g[f] !== undefined) extra[f] = g[f]
    }
    S.upsertGuide.run(
      g.id,
      g.cityName,
      g.author,
      g.authorOpenid || '',
      g.status || 'visited',
      g.createdAt || 0,
      g.updatedAt || 0,
      JSON.stringify(extra)
    )
    return g
  }

  function listGuides({ status = null } = {}) {
    const rows = status ? S.listGuidesByStatus.all(status) : S.listGuides.all()
    return rows.map(assembleGuide)
  }

  function listGuidesOfCity(name) {
    return S.listGuidesByCity.all(name).map(assembleGuide)
  }

  /** 我的足迹：按 openid 归属过滤（走 idx_guides_openid），assembleGuide 自动剥 authorOpenid */
  function listGuidesByOpenid(openid) {
    if (!openid) return []
    return S.listGuidesByOpenid.all(openid).map(assembleGuide)
  }

  function findGuideById(id) {
    const row = S.getGuide.get(id)
    return row ? assembleGuide(row) : null
  }

  function findGuideByCityAuthor(cityName, author) {
    const row = S.getGuideByCityAuthor.get(cityName, author)
    return row ? assembleGuide(row) : null
  }

  function deleteGuideById(id) {
    return S.delGuide.run(id).changes
  }

  function deleteGuidesByCityAuthor(cityName, author) {
    return S.delGuidesByCityAuthor.run(cityName, author).changes
  }

  function deleteGuidesByCityOpenid(cityName, openid) {
    return S.delGuidesByCityOpenid.run(cityName, openid).changes
  }

  // ───────────────────────── 空间成员（账号体系） ─────────────────────────

  /**
   * 把某个 openid 加为空间成员。
   *
   * `role='owner'` 只在创建时写入一次（`ON CONFLICT DO NOTHING`），
   * 所以「凭码加入」不会把 owner 降级成 member —— 这个原子性由 SQL 保证，
   * 不要在 JS 里写成「先查再写」（并发下会互相覆盖）。
   */
  function addMember(spaceId, openid, role = 'member', joinedAt = Date.now()) {
    if (!spaceId || !openid) return false
    return S.addMember.run(spaceId, openid, role === 'owner' ? 'owner' : 'member', joinedAt).changes > 0
  }

  function memberRoleOf(spaceId, openid) {
    if (!spaceId || !openid) return ''
    const row = S.getMember.get(spaceId, openid)
    return row ? row.role : ''
  }

  function listMembers(spaceId) {
    return S.listMembers.all(spaceId).map((r) => ({
      openid: r.openid,
      role: r.role,
      joinedAt: r.joined_at
    }))
  }

  function memberCountOf(spaceId) {
    return S.countMembers.get(spaceId).n
  }

  // ───────────────────────── 旧数据迁移 ─────────────────────────

  /**
   * 首次启动时把旧的 db.json 导入进来。
   *
   * 只在库里完全是空的时候才做，避免覆盖已经在用的数据。
   * 导入后把旧文件改名成 .migrated 保留（不删），出问题还能人工查回来。
   */
  function migrateLegacyJson() {
    if (!legacyJsonFile || !existsSync(legacyJsonFile)) return null
    if (S.countSpaces.get().n > 0 || S.countGuides.get().n > 0) return null

    let raw
    try {
      raw = JSON.parse(readFileSync(legacyJsonFile, 'utf-8'))
    } catch (e) {
      log.warn('旧 JSON 数据文件无法解析，跳过迁移', { file: legacyJsonFile, err: String(e) })
      return null
    }
    if (!raw || typeof raw !== 'object') return null

    const guides = Array.isArray(raw.guides) ? raw.guides : []
    const spaces = raw.spaces && typeof raw.spaces === 'object' ? Object.values(raw.spaces) : []

    tx(() => {
      for (const g of guides) {
        if (!g || typeof g !== 'object' || !g.id) continue
        saveGuide({
          createdAt: 0,
          updatedAt: 0,
          status: 'visited',
          ...g,
          cityName: g.cityName ?? '',
          author: g.author ?? ''
        })
      }
      for (const s of spaces) {
        if (!s || typeof s !== 'object' || !s.id) continue
        saveSpace({
          code: '',
          rev: 0,
          createdAt: 0,
          updatedAt: 0,
          updatedBy: '',
          digest: '',
          retiredCodes: [],
          ownerOpenid: '',
          tombstones: [],
          ...s,
          doc: s.doc && typeof s.doc === 'object' ? { ...emptyDoc(), ...s.doc } : emptyDoc()
        })
      }
    })

    const target = legacyJsonFile + '.migrated'
    try {
      renameSync(legacyJsonFile, target)
    } catch (e) {
      log.warn('旧数据文件改名失败（数据已导入，可手工清理）', { file: legacyJsonFile, err: String(e) })
    }
    log.info('已从旧 JSON 数据文件迁移到 SQLite', { spaces: spaces.length, guides: guides.length, archived: target })
    return { spaces: spaces.length, guides: guides.length, archived: target }
  }

  const migrated = migrateLegacyJson()

  return {
    loadSpace,
    saveSpace,
    listSpaces,
    listSpacesBriefForDiscover,
    findSpaceByCode,
    hasSpace,
    listGuides,
    listGuidesOfCity,
    listGuidesByOpenid,
    findGuideById,
    findGuideByCityAuthor,
    saveGuide,
    guideOwnerOf,
    guideOwnerByCityAuthor,
    deleteGuideById,
    deleteGuidesByCityAuthor,
    deleteGuidesByCityOpenid,
    // 账号体系：空间成员（授权依据）
    addMember,
    memberRoleOf,
    listMembers,
    memberCountOf,
    counts: () => ({
      spaces: S.countSpaces.get().n,
      guides: S.countGuides.get().n,
      spaceMembers: S.countAllMembers.get().n
    }),
    migrated,
    /** 底层句柄，供将来的实时推送 / 调试使用 */
    raw: handle,
    close: () => {
      if (closed) return
      closed = true
      try {
        handle.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        /* checkpoint 失败不影响关闭 */
      }
      handle.close()
    }
  }
}
