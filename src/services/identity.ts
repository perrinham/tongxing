/**
 * 微信登录（客户端侧）。
 *
 * 流程：`uni.login()` 拿一次性 code → 交给后端换 openid → 后端签一个无状态会话令牌。
 * **AppSecret 绝不下发到客户端**，换 openid 必须在服务端做（见 server/lib/identity.mjs）。
 *
 * 这一层刻意只做「拿身份」这一件事，不碰 store：
 * 登录状态存在 `SyncMeta.identity`（见 src/stores/trip.ts），
 * 这里只负责与微信、后端交互并做形态校验，方便在 Node 里单测。
 *
 * ⚠️ code 是**一次性**的：`uni.login` 拿到的 code 用掉即失效，所以整条链路不能重试。
 * 失败（比如后端没配 AppID）时调用方应降级为匿名，而不是把用户卡在登录页。
 */

import type { BackendClient } from '@/services/backend'
import type { Identity } from '@/types'

/** 令牌提前这么多视为「该续了」，避免请求正好卡在过期边界上 */
const RENEW_MARGIN_MS = 60_000

/**
 * 身份是否可用（形态完整 + 未临期）。
 *
 * 抽成纯函数是为了能在单测里注入 `now` —— 「过期判定」这种东西靠
 * 「跑的时候刚好没过期」来验证是完全不可靠的。
 */
export function identityValid(id: Identity | null | undefined, now = Date.now()): boolean {
  if (!id) return false
  if (!id.openid || !id.token) return false
  if (!Number.isFinite(id.expiresAt) || id.expiresAt <= 0) return false
  return id.expiresAt - RENEW_MARGIN_MS > now
}

/** 取一个微信登录 code */
function wxLoginCode(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    uni.login({
      provider: 'weixin',
      success: (res: { code?: string }) => {
        const c = String(res?.code || '')
        if (c) resolve(c)
        else reject(new Error('uni.login 没有返回 code'))
      },
      fail: (err: { errMsg?: string }) => {
        reject(new Error(err?.errMsg || 'uni.login 失败'))
      }
    })
  })
}

/**
 * 登录并返回身份。
 *
 * @param api 调用方自己的 backend 实例（wxLogin 是登录**前**的请求，任意实例皆可；
 *   显式传参而不是模块内自建，是为了让 identity 层与网络层解耦，也方便测试注入）
 * @throws 失败时抛错，调用方决定是否降级为匿名（不要在这里吞掉错误，
 *   否则「后端没配 AppID」这种运维问题在客户端会表现为「点了没反应」）
 */
export async function loginWithWechat(api: Pick<BackendClient, 'wxLogin'>): Promise<Identity> {
  const code = await wxLoginCode()
  const res = await api.wxLogin(code)
  const id: Identity = {
    openid: String(res.openid || ''),
    token: String(res.token || ''),
    expiresAt: Math.floor(Number(res.expiresAt) || 0),
    ...(res.dev ? { dev: true } : {})
  }
  if (!identityValid(id)) throw new Error('登录返回的身份不完整')
  return id
}

/**
 * 把登录失败翻译成给用户看的一句话。
 *
 * 服务端刻意把状态码分开（见 routes/auth.mjs），这里就必须跟着分开 ——
 * 全都显示「登录失败」的话，用户不知道是该重试、还是该找人配 AppID。
 */
export function loginErrorText(e: unknown): string {
  const status = (e as { status?: number } | null)?.status
  const raw = e instanceof Error ? e.message : String(e)
  if (status === 503) return '后端还没配置微信登录（WX_APPID / WX_SECRET），暂时只能用分享码协作'
  if (status === 502) return '连不上微信服务，稍后再试'
  if (status === 401) return '微信登录凭证已失效，请重试'
  if (status === 0) return '网络不通，登录失败'
  return raw || '登录失败'
}

/** 提供一个便于界面展示的短标识（openid 本身不该直接显示给用户） */
export function shortIdentity(id: Identity | null | undefined): string {
  if (!id?.openid) return ''
  return id.openid.length > 10 ? `${id.openid.slice(0, 6)}…${id.openid.slice(-4)}` : id.openid
}
