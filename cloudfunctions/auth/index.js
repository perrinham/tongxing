/**
 * 身份云函数 —— server/routes/auth.mjs 的云端移植。
 *
 * 与自托管的不同：**不需要拿 code 去找微信换 openid**。云函数调用本身已经由微信
 * 完成身份认证，`cloud.getWXContext().OPENID` 就是当前调用者的稳定身份（拿到即真）。
 * `code` 仍要求存在（客户端 uni.login 流程不变），但不再对外网发起请求 ——
 * 这同时解决了自托管那个「401 与 503 混淆」的运维坑：云端永不 503。
 *
 * 令牌策略（已在计划第 5 节拍板）：无状态自签名 `cloud:<OPENID>`，expiresAt = 现在 + 30 天。
 * 服务端**不落库**，与自托管 identity.mjs 同样理由：
 *   - 无状态令牌没有可撤销的服务端会话，登出动作只发生在客户端（删本地令牌）；
 *   - 换设备时按 openid 回拉本地库（trips list withDoc / guides listMine），令牌不迁移。
 *
 * event：{ action, loggedIn, code?, token? }
 * action：wxLogin | authMe | logout | health
 * 成功返回数据对象；失败返回 { e: { status, message } }。
 */

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const { str } = require('./_lib/util')

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000

function fail(status, message) {
  return { e: { status, message } }
}

function issue(openid) {
  return {
    openid,
    token: 'cloud:' + openid,
    expiresAt: Date.now() + TOKEN_TTL_MS
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const openid = String(OPENID || '')

  try {
    switch (event.action) {
      case 'wxLogin': {
        const code = str(event.code, 512)
        if (!code) return fail(400, 'code required')
        if (!openid) return fail(401, 'wx rejected code')
        return { ...issue(openid), dev: false }
      }

      case 'authMe': {
        // 会话有效性：客户端自报的令牌存在且形态匹配；OPENID 以调用上下文为准
        const token = str(event.token, 128)
        if (!token || !token.startsWith('cloud:')) return fail(401, 'no valid session')
        return { openid, expiresAt: Date.now() + TOKEN_TTL_MS }
      }

      case 'logout':
        return { ok: true, stateless: true }

      case 'health':
        return { ok: true, version: 'cloud', authRequired: false, mode: 'cloud' }

      default:
        return fail(400, 'unknown action: ' + event.action)
    }
  } catch (e) {
    console.error('[auth:error]', event.action, String((e && e.message) || e))
    return fail(500, 'internal error')
  }
}