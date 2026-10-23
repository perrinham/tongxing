/**
 * 把自托管 SQLite（server/data/travel.sqlite3）导出成云迁移用的快照 JSON。
 *
 * 产物：cloudfunctions/migrate/snapshot.json（**含用户数据，已 gitignore，勿提交**）
 *
 * 为什么是「导出 + 云端导入」而不是本地直连云数据库：
 *   wx-server-sdk 设计上只在云函数里跑；本地直连要另配 @cloudbase/node-sdk +
 *   密钥（secretId/secretKey），既引入新的密钥管理，又难以在本机验证。
 *   改成「导出快照 → 用 migrate 云函数导入」后，导入端跑在云里、用的是原生
 *   wx-server-sdk，且天然幂等（doc.set 覆盖写），可反复重跑。
 *
 * 表结构与云集合字段是 1:1（见 server/lib/db.mjs 与 _lib/store.js 的说明）：
 *   spaces        -> spaces         (_id = id)
 *   records       -> records        (_id = space_id:kind:id)
 *   tombstones    -> tombstones     (_id = space_id:kind:id)
 *   guides        -> guides         (_id = id)
 *   space_members -> space_members  (_id = space_id:openid)
 *
 * 用法：npm run migrate:export   （之后上传 migrate 云函数并调用，见文档）
 */
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const dbPath = process.env.MIGRATE_DB || resolve(root, 'server/data/travel.sqlite3')
const outPath = process.env.MIGRATE_OUT || resolve(root, 'cloudfunctions/migrate/snapshot.json')

const TABLES = ['spaces', 'records', 'tombstones', 'guides', 'space_members']

if (!existsSync(dbPath)) {
  console.error(`[migrate:export] 找不到数据库：${dbPath}`)
  console.error('  先在本机跑过 npm run server（或用 MIGRATE_DB 指定路径）再导出。')
  process.exit(1)
}

const _emitWarning = process.emitWarning.bind(process)
process.emitWarning = (warning, ...rest) => {
  const msg = typeof warning === 'string' ? warning : warning?.message ?? ''
  if (msg.includes('SQLite is an experimental feature')) return
  return _emitWarning(warning, ...rest)
}

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const handle = new DatabaseSync(dbPath)
const snapshot = {}
const counts = {}

try {
  for (const t of TABLES) {
    try {
      snapshot[t] = handle.prepare(`SELECT * FROM ${t}`).all()
    } catch {
      // 旧库可能没有 space_members（账号体系之前）
      snapshot[t] = []
    }
    counts[t] = snapshot[t].length
  }
} finally {
  handle.close()
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(snapshot), 'utf8')
const size = statSync(outPath).size

console.log('[migrate:export] 导出完成')
for (const t of TABLES) console.log(`  ${t.padEnd(14)} ${counts[t]} 行`)
console.log(`  产物：${outPath}（${(size / 1024).toFixed(1)} KB）`)
if (size > 20 * 1024 * 1024) {
  console.warn('  ⚠️ 超过 20MB，云函数上传可能失败；请分批迁移或改用云存储中转。')
}