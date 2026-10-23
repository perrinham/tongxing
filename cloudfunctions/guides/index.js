/**
 * 城市攻略 / 评价云函数 —— server/routes/guides.mjs + 攻略相关 db 层的云端移植。
 *
 * 归属判定用 cloud.getWXContext().OPENID；事件里的 loggedIn 是「是否进入账号体系」的
 * 客户端自报状态（与 trips 云函数同一口径）。未登录的匿名写入按旧口径（昵称即作者）。
 *
 * event：{ action, loggedIn, ... }
 * action：listCities | cityGuides | listMine | upsert | retract | update | delete
 * 成功返回数据对象；失败返回 { e: { status, message } }。
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const { randomUUID } = require('crypto')

const {
  ensureCollection,
  docGet,
  docRemove,
  docSet,
  whereGet,
  whereRemove
} = require('./_lib/store')
const { isPlainObject, isoDate, int, oneOf, str, wasTruncated } = require('./_lib/util')

// 与 server/routes/guides.mjs 保持一致
const STATUSES = ['visited', 'wish']
const LIMITS = {
  author: 24,
  city: 40,
  guide: 5000,
  review: 2000,
  wishNote: 500
}

function fail(status, message) {
  return { e: { status, message } }
}

function normGuideFields(raw, { creating }) {
  const out = {}
  const warnings = []
  if (!isPlainObject(raw)) return { fields: out, warnings }

  const status = oneOf(raw.status, STATUSES, null)
  if (status) out.status = status
  else if (creating) out.status = 'visited'

  if (raw.visitDate !== undefined) {
    const d = isoDate(raw.visitDate, '')
    if (d) out.visitDate = d
    else warnings.push('visitDate 不是合法日期，已忽略')
  }

  for (const f of ['guide', 'review', 'wishNote']) {
    if (raw[f] === undefined) continue
    out[f] = str(raw[f], LIMITS[f])
    if (wasTruncated(raw[f], LIMITS[f])) warnings.push(`${f} 超长，已截断到 ${LIMITS[f]} 字`)
  }

  if (raw.rating !== undefined) {
    const r = int(raw.rating, 1, 5, null)
    if (r === null) warnings.push('rating 需为 1-5 的整数，已忽略')
    else out.rating = r
  }

  return { fields: out, warnings }
}

function parseJson(raw, fallback) {
  try {
    const v = JSON.parse(raw)
    return v === null || v === undefined ? fallback : v
  } catch {
    return fallback
  }
}

// 攻略响应体：`data` JSON 里的字段展开到顶层；authorOpenid 绝不带出
function assembleGuide(row) {
  return {
    id: row._id || row.id,
    cityName: row.city_name,
    author: row.author,
    status: row.status || 'visited',
    createdAt: row.created_at || 0,
    updatedAt: row.updated_at || 0,
    ...parseJson(row.data || '{}', {})
  }
}

function publicGuide(g) {
  const { authorOpenid, ...rest } = g
  return rest
}

function dataJsonOf(g) {
  const extra = {}
  for (const f of ['visitDate', 'guide', 'review', 'rating', 'wishNote']) {
    if (g[f] !== undefined) extra[f] = g[f]
  }
  return JSON.stringify(extra)
}

async function saveGuide(g) {
  await docSet('guides', g.id, {
    city_name: g.cityName,
    author: g.author,
    author_openid: g.authorOpenid || '',
    status: g.status || 'visited',
    created_at: g.createdAt || 0,
    updated_at: g.updatedAt || 0,
    data: dataJsonOf(g)
  })
  return g
}

async function findGuideByCityAuthor(cityName, author) {
  const rows = await whereGet('guides', { city_name: cityName, author })
  if (!rows.length) return null
  return rows[0]
}

async function guideOwnerOf(id) {
  const row = await docGet('guides', id)
  return row ? row.author_openid || '' : ''
}

async function deleteGuidesByCityOpenid(cityName, openid) {
  if (!openid) return 0
  return whereRemove('guides', { city_name: cityName, author_openid: openid })
}

async function deleteGuidesByCityAuthor(cityName, author) {
  const rows = await whereGet('guides', { city_name: cityName, author })
  const unowned = rows.filter((r) => !r.author_openid)
  if (!unowned.length) return 0
  let removed = 0
  for (const r of unowned) {
    await docRemove('guides', r._id)
    removed += 1
  }
  return removed
}

async function setupCollections() {
  const names = ['guides']
  const detail = {}
  for (const name of names) {
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
        // 首次部署后调用一次：创建所需集合（幂等）
        return await setupCollections()

      case 'listCities': {
        const status = oneOf(event.status, STATUSES, null)
        let rows = await whereGet('guides', {})
        if (status) rows = rows.filter((r) => r.status === status)
        const map = new Map()
        for (const r of rows) {
          const g = assembleGuide(r)
          if (!map.has(g.cityName)) map.set(g.cityName, [])
          map.get(g.cityName).push(g)
        }
        return { cities: [...map.entries()].map(([name, guides]) => ({ name, guides })) }
      }

      case 'cityGuides': {
        const name = str(event.cityName, LIMITS.city)
        if (!name || name.includes('/')) return fail(400, 'invalid city name')
        const rows = await whereGet('guides', { city_name: name })
        return { name, guides: rows.map(assembleGuide) }
      }

      case 'listMine': {
        if (!openid) return fail(401, 'sign in required')
        const rows = await whereGet('guides', { author_openid: openid })
        rows.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
        return { guides: rows.map(assembleGuide) }
      }

      case 'upsert': {
        const name = str(event.cityName, LIMITS.city)
        if (!name || name.includes('/')) return fail(400, 'invalid city name')
        const author = str(event.author, LIMITS.author, '匿名') || '匿名'
        const { fields, warnings } = normGuideFields(event, { creating: true })
        const now = Date.now()

        const existing = await findGuideByCityAuthor(name, author)
        if (existing) {
          const owner = existing.author_openid || ''
          if (owner && owner !== openid) {
            return fail(403, 'this guide belongs to another account')
          }
        }

        const guide = existing
          ? {
              id: existing._id,
              ...assembleGuide(existing),
              ...fields,
              authorOpenid: openid,
              updatedAt: now
            }
          : {
              id: randomUUID(),
              cityName: name,
              author,
              authorOpenid: openid,
              createdAt: now,
              updatedAt: now,
              status: 'visited',
              ...fields
            }
        await saveGuide(guide)
        return warnings.length ? { guide: publicGuide(guide), warnings } : { guide: publicGuide(guide) }
      }

      case 'retract': {
        const name = str(event.cityName, LIMITS.city)
        if (!name || name.includes('/')) return fail(400, 'invalid city name')
        // 带身份时按 openid 撤回（昵称可自报会被冒用）；匿名保留旧口径按昵称
        if (openid) {
          const removed = await deleteGuidesByCityOpenid(name, openid)
          return { ok: true, removed }
        }
        const author = str(event.author, LIMITS.author)
        if (!author) return fail(400, 'author is required')
        const removed = await deleteGuidesByCityAuthor(name, author)
        return { ok: true, removed }
      }

      case 'update': {
        const id = str(event.id, 64)
        if (!id) return fail(400, 'invalid guide id')
        const row = await docGet('guides', id)
        if (!row) return fail(404, 'not found')
        const owner = row.author_openid || ''
        if (owner && owner !== openid) return fail(403, 'this guide belongs to another account')
        const { fields, warnings } = normGuideFields(event.payload, { creating: false })
        const updated = {
          id,
          ...assembleGuide(row),
          ...fields,
          authorOpenid: owner || openid,
          updatedAt: Date.now()
        }
        await saveGuide(updated)
        const out = publicGuide(updated)
        return warnings.length ? { guide: out, warnings } : { guide: out }
      }

      case 'delete': {
        const id = str(event.id, 64)
        if (!id) return fail(400, 'invalid guide id')
        const row = await docGet('guides', id)
        if (!row) return fail(404, 'not found')
        const owner = row.author_openid || ''
        if (owner && owner !== openid) return fail(403, 'this guide belongs to another account')
        await docRemove('guides', id)
        return { ok: true }
      }

      default:
        return fail(400, 'unknown action: ' + event.action)
    }
  } catch (e) {
    console.error('[guides:error]', event.action, String((e && e.message) || e))
    return fail(500, 'internal error')
  }
}

exports._setup = setupCollections