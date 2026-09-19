/**
 * 微信 openid 身份 + 无状态会话令牌。
 *
 * ── 它解决的是什么问题 ──
 *
 * 之前「谁是谁」靠**客户端自报**：攻略用自填昵称认作者、行程靠分享码认协作。
 * 于是任何人改个昵称就能冒名、服务端也**无法校验**「这个人有没有资格改这个行程」。
 * openid 是微信侧签发的、同一小程序内唯一且不可自选的标识，把它作为身份键之后，
 * 服务端才有能力回答「你是谁」和「你能不能动这条数据」。
 *
 * ── 会话令牌为什么不落库 ──
 *
 * 令牌是 `wxs_<openid>.<exp>.<sig>` 的 HMAC 签名串（sig 用 SESSION_SECRET），
 * 校验 = 重算签名 + 查过期。**无状态**：不需要 session 表、不需要清理任务、
 * 多实例部署也不用共享存储（只要 SESSION_SECRET 一致）。
 * 代价是没法「单个令牌吊销」，只能靠轮换 SESSION_SECRET 全量失效 ——
 * 对这个量级的应用是合适的取舍（换来的是零运维）。
 *
 * ⚠️ 令牌前缀 `wxs_` 是刻意的：`Authorization: Bearer` 已经被**共享密钥**
 * （`AUTH_TOKEN`，见 auth.mjs）占用了。两者语义完全不同（一个是「这个应用被允许访问」，
 * 一个是「你是哪个用户」），混在同一个头里迟早出错。
 * 所以会话令牌走独立的 `X-Session-Token` 头，共享密钥继续留在 Authorization。
 *
 * ── 环境变量 ──
 *   WX_APPID        小程序 AppID；与 WX_SECRET 同时配置才启用真实换取
 *   WX_SECRET       小程序 AppSecret（**只放服务端**，绝不要下发到客户端）
 *   SESSION_SECRET  令牌签名密钥；不配则回落到 AUTH_TOKEN，再没有就随机生成
 *                   （随机生成意味着进程重启后所有令牌失效，仅适合本地开发）
 *   SESSION_TTL_MS  令牌有效期，默认 30 天
 *   WX_DEV_LOGIN    设为 1 时，在没有 AppID/Secret 的情况下用 code 推导一个
 *                   **假的 openid**（`dev<sha1(code) 前 24 位>`），仅供本地与测试。
 *                   生产环境绝不要开 —— 它等于「自己声明自己是谁」。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** 会话令牌前缀：与共享密钥区分开 */
export const SESSION_PREFIX = 'wxs_'

/** openid / unionid 的字符集（微信签发的是 base64url 风格） */
const OPENID_RE = /^[A-Za-z0-9_-]{4,64}$/

const WX_ENDPOINT = 'https://api.weixin.qq.com/sns/jscode2session'

/** 定长摘要比较，避免长度 / 前缀泄漏 */
function digest(s) {
  return createHash('sha256').update(String(s), 'utf-8').digest()
}

function safeEqual(a, b) {
  return timingSafeEqual(digest(a), digest(b))
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function isOpenid(v) {
  return typeof v === 'string' && OPENID_RE.test(v)
}

/**
 * 把任意输入归一成合法 openid；不合法返回空串。
 *
 * 归一化发生在**入库之前**：身份键会被拼进 SQL 与令牌，任何未清洗的字符
 * 都是注入面。只允许 base64url 字符集 + 长度上限，其余一律拒绝（不是截断 ——
 * 截断会制造出两个不同的 openid 归一成同一个的碰撞）。
 */
export function normOpenid(v) {
  const s = typeof v === 'string' ? v.trim() : ''
  return isOpenid(s) ? s : ''
}

export function createIdentity({
  appid = '',
  secret = '',
  sessionSecret = '',
  ttlMs = 30 * 24 * 3600 * 1000,
  devLogin = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000
} = {}) {
  const hasWx = String(appid).trim().length > 0 && String(secret).trim().length > 0
  const secretSeed = String(sessionSecret).trim()
  /** 缺失时随机生成：能用，但重启即失效 —— 调用方在启动日志里警告 */
  const ephemeralSecret = secretSeed ? '' : b64url(randomBytes(32))
  const signingKey = secretSeed || ephemeralSecret
  const ttl = Math.min(Math.max(Number(ttlMs) || 0, 60_000), 365 * 24 * 3600 * 1000)

  function sign(openid, exp) {
    return b64url(createHmac('sha256', signingKey).update(`${openid}.${exp}`).digest()).slice(0, 43)
  }

  /** 造一个会话令牌 */
  function issue(openid, now = Date.now()) {
    const id = normOpenid(openid)
    if (!id) return null
    const exp = now + ttl
    return { openid: id, token: `${SESSION_PREFIX}${id}.${exp}.${sign(id, exp)}`, expiresAt: exp }
  }

  /**
   * 校验会话令牌。
   * @returns {{ ok: boolean, openid?: string, expiresAt?: number, reason: string }}
   */
  function verify(token, now = Date.now()) {
    const raw = typeof token === 'string' ? token.trim() : ''
    if (!raw) return { ok: false, reason: 'missing-session' }
    if (!raw.startsWith(SESSION_PREFIX)) return { ok: false, reason: 'bad-prefix' }

    const parts = raw.slice(SESSION_PREFIX.length).split('.')
    if (parts.length !== 3) return { ok: false, reason: 'malformed' }
    const [openid, expRaw, sig] = parts
    if (!isOpenid(openid)) return { ok: false, reason: 'bad-openid' }

    const exp = Number(expRaw)
    if (!Number.isFinite(exp)) return { ok: false, reason: 'bad-exp' }
    if (!safeEqual(sig, sign(openid, exp))) return { ok: false, reason: 'bad-signature' }
    // 过期检查放在签名之后：否则可以拿伪造令牌探测「这个 exp 过没过期」
    if (exp <= now) return { ok: false, reason: 'expired', openid }

    return { ok: true, openid, expiresAt: exp, reason: 'session' }
  }

  /**
   * 用微信登录 code 换 openid。
   *
   * 三条分支，调用方必须能区分「拿到了身份」和「服务端没配好」——
   * 后者应该回 503 让运维看得见，而不是 401 让用户以为是自己的问题。
   *
   * @returns {Promise<{ ok: boolean, openid?: string, dev?: boolean, reason: string }>}
   */
  async function loginWithCode(code) {
    const c = typeof code === 'string' ? code.trim() : ''
    if (!c || c.length > 512) return { ok: false, reason: 'missing-code' }

    if (hasWx) {
      const url =
        `${WX_ENDPOINT}?appid=${encodeURIComponent(appid)}` +
        `&secret=${encodeURIComponent(secret)}` +
        `&js_code=${encodeURIComponent(c)}&grant_type=authorization_code`
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      let data
      try {
        const res = await fetchImpl(url, { signal: ac.signal })
        data = await res.json()
      } catch (err) {
        return { ok: false, reason: 'wx-unreachable', detail: String(err?.message || err) }
      } finally {
        clearTimeout(timer)
      }
      // ⚠️ 微信的错误体里带 errmsg，但**绝不要**回给客户端：
      // 它可能包含 appid / secret 相关线索。只记 reason，细节写日志。
      if (!data || typeof data !== 'object' || !data.openid) {
        return { ok: false, reason: 'wx-rejected', detail: String(data?.errmsg || '').slice(0, 120) }
      }
      const openid = normOpenid(data.openid)
      if (!openid) return { ok: false, reason: 'wx-bad-openid' }
      return { ok: true, openid, reason: 'wx' }
    }

    if (devLogin) {
      // 仅供本地与测试：用 code 推导一个可复现的假 openid（同一 code 同一身份）
      const h = createHash('sha1').update(`dev:${c}`).digest('hex').slice(0, 24)
      return { ok: true, openid: `dev${h}`, dev: true, reason: 'dev-login' }
    }

    return { ok: false, reason: 'not-configured' }
  }

  /** 从请求里取会话身份（不抛错；无令牌返回 null） */
  function fromRequest(req, now = Date.now()) {
    const token = req?.headers?.['x-session-token'] || ''
    const v = verify(Array.isArray(token) ? token[0] : token, now)
    return v.ok ? { openid: v.openid, expiresAt: v.expiresAt } : null
  }

  return {
    /** 配了 AppID/Secret（真实换取可用） */
    wxConfigured: hasWx,
    /** 开了开发登录（**生产必须关**） */
    devLogin: !!devLogin && !hasWx,
    /** 签名密钥是一次性的（重启后旧令牌全失效） */
    ephemeralSecret: !secretSeed,
    ttlMs: ttl,
    issue,
    verify,
    loginWithCode,
    fromRequest
  }
}
