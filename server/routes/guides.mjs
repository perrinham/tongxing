/**
 * 城市攻略 / 评价路由。
 *
 * 语义（与旧版一致，保证前端与既有测试不回归）：
 *   GET    /api/cities                       所有城市 + 各自攻略（?status=visited|wish 过滤）
 *   GET    /api/cities/:name                 单个城市 + 攻略列表
 *   POST   /api/cities/:name/guides          按 (城市, 昵称) upsert
 *   PUT    /api/cities/:name/guides          同上（等价的 upsert）
 *   DELETE /api/cities/:name/guides?author=  按作者撤回
 *   PUT    /api/guides/:id                   按 id 更新
 *   DELETE /api/guides/:id                   按 id 删除
 *
 * 全部写入字段走白名单归一 + 长度截断，超长返回 warnings 便于排查。
 * 存储访问一律通过 lib/db.mjs，路由本身不感知底层是 SQLite 还是别的。
 */

import { randomUUID } from 'node:crypto'
import {
  isPlainObject,
  isSafeId,
  isoDate,
  int,
  oneOf,
  safeDecode,
  str,
  wasTruncated
} from '../lib/util.mjs'

const STATUSES = ['visited', 'wish']

/** 字段 → 上限（与前端输入框的 maxlength 对齐） */
const LIMITS = {
  author: 24,
  city: 40,
  guide: 5000,
  review: 2000,
  wishNote: 500
}

/**
 * 归一攻略字段。
 * @returns {{fields: object, warnings: string[]}}
 */
function normGuideFields(raw, { creating }) {
  const out = {}
  const warnings = []
  if (!isPlainObject(raw)) return { fields: out, warnings }

  // status：非法值忽略（保持原值），新建时默认 visited
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

export function createGuidesRouter({ http, db, log }) {
  function cityNameOf(raw) {
    const name = safeDecode(raw)
    if (name === null) return null
    const clean = str(name, LIMITS.city)
    return clean && !clean.includes('/') ? clean : null
  }

  /**
   * 出响应前剥掉 `authorOpenid`。
   *
   * db 侧已经保证列表不带这个字段了，但写入路径需要把 openid 传给 saveGuide，
   * 那个对象就顺手带着它 —— 于是「同一个对象既用于落库、又用于响应」这个便利
   * 就成了泄漏点。所有响应统一过这一道，避免以后新增接口时漏掉。
   */
  function publicGuide(g) {
    const { authorOpenid, ...rest } = g
    return rest
  }

  async function upsert(req, res, name) {
    const body = await http.readBody(req)
    if (!body.ok) return http.fail(req, res, body.status, body.error)

    const author = str(body.value.author, LIMITS.author, '匿名') || '匿名'
    const { fields, warnings } = normGuideFields(body.value, { creating: true })

    const now = Date.now()
    const openid = req.identity?.openid || ''
    const existing = db.findGuideByCityAuthor(name, author)

    // 归属校验：同名攻略已经属于**另一个** openid 时不许覆盖。
    //
    // 这正是接 openid 要解决的问题：以前 (城市, 昵称) 是唯一键、且昵称完全由客户端自报，
    // 于是「把昵称改成别人的」就能改掉、甚至删掉别人的攻略。现在有归属的行只认本人。
    //
    // 归属为空的行（接账号体系之前写的）允许被认领 —— 它在旧模型下本来就没有可校验的主人，
    // 而且这正是老数据进入账号体系的迁移路径。认领会在日志里留痕。
    if (existing) {
      const owner = db.guideOwnerOf(existing.id)
      if (owner && owner !== openid) {
        log.warn('拒绝覆盖他人攻略', { city: name, author, owner: owner.slice(0, 8) })
        return http.fail(req, res, 403, 'this guide belongs to another account')
      }
      if (!owner && openid) log.info('无主攻略被认领', { city: name, author, openid: openid.slice(0, 8) })
    }

    const guide = existing
      ? { ...existing, ...fields, authorOpenid: openid, updatedAt: now }
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
    db.saveGuide(guide)

    log.info('guide upsert', {
      city: name,
      author,
      created: !existing,
      identified: !!openid,
      warnings: warnings.length
    })
    return http.send(
      req,
      res,
      200,
      warnings.length ? { guide: publicGuide(guide), warnings } : { guide: publicGuide(guide) }
    )
  }

  /**
   * @returns {Promise<boolean>} 是否已处理该请求
   */
  async function handle(req, res, url) {
    const p = url.pathname

    // 我的足迹（按 openid 归属）：登录后回拉自己的全部攻略/评价到本地。
    // 客户端的 upsert 走 (城市, 昵称) 定位，昵称可改；只有 openid 是稳定主键，
    // 所以「哪些是我的」必须由服务端按归属回答，不能靠客户端自报昵称筛选。
    if (p === '/api/my/guides') {
      if (req.method !== 'GET') return http.methodNotAllowed(req, res, ['GET', 'OPTIONS'])
      const openid = req.identity?.openid || ''
      if (!openid) return http.fail(req, res, 401, 'sign in required')
      return http.send(req, res, 200, { guides: db.listGuidesByOpenid(openid) })
    }

    // 聚合列表
    if (p === '/api/cities') {
      if (req.method !== 'GET') return http.methodNotAllowed(req, res, ['GET', 'OPTIONS'])
      const status = oneOf(url.searchParams.get('status'), STATUSES, null)
      const map = new Map()
      for (const g of db.listGuides({ status })) {
        if (!map.has(g.cityName)) map.set(g.cityName, [])
        map.get(g.cityName).push(g)
      }
      return http.send(req, res, 200, {
        cities: [...map.entries()].map(([name, guides]) => ({ name, guides }))
      })
    }

    // ---- /api/cities/:name/guides ----
    const guidesMatch = p.match(/^\/api\/cities\/([^/]+)\/guides$/)
    if (guidesMatch) {
      const name = cityNameOf(guidesMatch[1])
      if (!name) return http.fail(req, res, 400, 'invalid city name')

      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        await upsert(req, res, name)
        return true
      }
      if (req.method === 'DELETE') {
        const openid = req.identity?.openid || ''
        // 带身份时**按 openid 撤回**，而不是按客户端自报的昵称 ——
        // 昵称是自报的，用它做删除条件等于「改个昵称就能删掉别人的攻略」。
        if (openid) {
          const removed = db.deleteGuidesByCityOpenid(name, openid)
          log.info('guide withdraw', { city: name, byOpenid: openid.slice(0, 8), removed })
          return http.send(req, res, 200, { ok: true, removed })
        }
        // 未登录：保留旧口径（按昵称），否则未接账号体系的部署会整块失效
        const author = str(url.searchParams.get('author'), LIMITS.author)
        if (!author) return http.fail(req, res, 400, 'author is required')
        const removed = db.deleteGuidesByCityAuthor(name, author)
        log.info('guide withdraw', { city: name, author, removed, legacy: true })
        return http.send(req, res, 200, { ok: true, removed })
      }
      return http.methodNotAllowed(req, res, ['POST', 'PUT', 'DELETE', 'OPTIONS'])
    }

    // ---- /api/cities/:name ----
    const cityMatch = p.match(/^\/api\/cities\/([^/]+)$/)
    if (cityMatch) {
      const name = cityNameOf(cityMatch[1])
      if (!name) return http.fail(req, res, 400, 'invalid city name')
      if (req.method !== 'GET') return http.methodNotAllowed(req, res, ['GET', 'OPTIONS'])
      return http.send(req, res, 200, { name, guides: db.listGuidesOfCity(name) })
    }

    // ---- /api/guides/:id ----
    const guideMatch = p.match(/^\/api\/guides\/([^/]+)$/)
    if (guideMatch) {
      const id = safeDecode(guideMatch[1])
      if (id === null || !isSafeId(id)) return http.fail(req, res, 400, 'invalid guide id')
      const guide = db.findGuideById(id)
      if (!guide) return http.fail(req, res, 404, 'not found')

      if (req.method === 'PUT' || req.method === 'PATCH') {
        const body = await http.readBody(req)
        if (!body.ok) return http.fail(req, res, body.status, body.error)
        const openid = req.identity?.openid || ''
        const owner = db.guideOwnerOf(id)
        // 有归属的攻略只有本人能改；无归属的（老数据）保持旧口径
        if (owner && owner !== openid) {
          log.warn('拒绝修改他人攻略', { id, owner: owner.slice(0, 8) })
          return http.fail(req, res, 403, 'this guide belongs to another account')
        }
        const { fields, warnings } = normGuideFields(body.value, { creating: false })
        const updated = { ...guide, ...fields, authorOpenid: owner || openid, updatedAt: Date.now() }
        db.saveGuide(updated)
        const out = publicGuide(updated)
        return http.send(req, res, 200, warnings.length ? { guide: out, warnings } : { guide: out })
      }
      if (req.method === 'DELETE') {
        const openid = req.identity?.openid || ''
        const owner = db.guideOwnerOf(id)
        if (owner && owner !== openid) {
          log.warn('拒绝删除他人攻略', { id, owner: owner.slice(0, 8) })
          return http.fail(req, res, 403, 'this guide belongs to another account')
        }
        db.deleteGuideById(id)
        return http.send(req, res, 200, { ok: true })
      }
      return http.methodNotAllowed(req, res, ['PUT', 'DELETE', 'OPTIONS'])
    }

    return false
  }

  return { handle }
}
