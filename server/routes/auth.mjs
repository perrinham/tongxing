/**
 * 登录路由：用微信 code 换 openid，并签发无状态会话令牌。
 *
 * 与会话令牌相关的说明（为什么不落库、为什么不走 Authorization 头）见 lib/identity.mjs。
 *
 * 状态码语义刻意区分开，调用方才能正确处理：
 *   200 拿到身份
 *   400 code 缺失 / 形态不对        → 客户端 bug，重试无用
 *   401 微信拒了这个 code           → code 已用过或过期，**应该重新 uni.login 拿新 code**
 *   503 服务端没配 AppID/Secret     → 运维问题，不是用户问题，重启无用
 *   502 连不上微信                  → 网络问题，可以重试
 * 「401 与 503 混淆」是最容易踩的坑：如果把「没配置」也回 401，
 * 用户会看到「登录失败」而运维永远收不到信号。
 */

import { str } from '../lib/util.mjs'
import { normOpenid } from '../lib/identity.mjs'

export function createAuthRouter({ http, identity, log }) {
  async function wxLogin(req, res) {
    const body = await http.readBody(req)
    if (!body.ok) return http.fail(req, res, body.status, body.error)

    const code = str(body.value?.code, 512)
    if (!code) return http.fail(req, res, 400, 'code required')

    const out = await identity.loginWithCode(code)
    if (!out.ok) {
      if (out.reason === 'not-configured') {
        log.warn('微信登录被调用，但服务端未配置 WX_APPID / WX_SECRET，且未开启开发登录')
        return http.fail(req, res, 503, 'wx login not configured', { reason: out.reason })
      }
      if (out.reason === 'wx-unreachable') {
        log.error('连不上微信 jscode2session', { detail: out.detail })
        return http.fail(req, res, 502, 'wx unreachable')
      }
      // 微信侧的错误细节只进日志，不回给客户端（可能含 appid 线索）
      log.warn('微信拒绝了登录 code', { reason: out.reason, detail: out.detail })
      return http.fail(req, res, 401, 'wx rejected code', { reason: out.reason })
    }

    const session = identity.issue(out.openid)
    if (!session) return http.fail(req, res, 500, 'could not issue session')

    log.info('登录成功', { openid: out.openid.slice(0, 8), dev: !!out.dev })
    return http.send(req, res, 200, {
      openid: session.openid,
      token: session.token,
      expiresAt: session.expiresAt,
      dev: !!out.dev
    })
  }

  function me(req, res) {
    const me = identity.fromRequest(req)
    if (!me) return http.fail(req, res, 401, 'no valid session')
    return http.send(req, res, 200, { openid: me.openid, expiresAt: me.expiresAt })
  }

  /**
   * 「登出」。
   *
   * 令牌是无状态的，服务端**没有**需要清理的会话记录 —— 真正的登出动作在客户端
   * （把本地令牌删掉）。这里存在只是为了给客户端一个约定的收口点，
   * 顺便让「客户端删了但服务端还能用」这件事在文档里显式可见。
   */
  function logout(req, res) {
    return http.send(req, res, 200, { ok: true, stateless: true })
  }

  async function handle(req, res, url) {
    const p = url.pathname
    if (p !== '/api/auth/wx' && p !== '/api/auth/me' && p !== '/api/auth/logout') return false

    if (p === '/api/auth/wx') {
      if (req.method !== 'POST') return http.methodNotAllowed(req, res, ['POST', 'OPTIONS'])
      return wxLogin(req, res)
    }
    if (p === '/api/auth/me') {
      if (req.method !== 'GET') return http.methodNotAllowed(req, res, ['GET', 'OPTIONS'])
      return me(req, res)
    }
    if (req.method !== 'POST') return http.methodNotAllowed(req, res, ['POST', 'OPTIONS'])
    return logout(req, res)
  }

  // normOpenid 在路由层也 export 一下，方便其它路由做「身份键必须是合法 openid」的断言
  return { handle, normOpenid }
}
