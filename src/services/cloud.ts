/**
 * 微信云开发调用封装（mp-weixin 的「云函数」通道）。
 *
 * ── 双轨适配 ──
 *
 * 迁移期间同时存在两条数据通道：
 *   1. 自托管 HTTP REST（server/，Node + SQLite）—— 本地开发 / H5 / 测试环境；
 *   2. 微信云开发（cloudfunctions/）—— 小程序正式运行。
 *
 * `hasCloud()` 是分流的唯一判据：**只有配了 env id、且运行环境确实有 `wx.cloud`**
 * 时才走云函数；否则一律回退 HTTP。于是：
 *   - Node 测试环境没有 `wx`（见 scripts/uni-mock.ts），hasCloud() 恒 false →
 *     client:smoke / city:smoke 走的还是原来的 HTTP 路径，断言不用改；
 *   - 小程序里 `wx.cloud` 恒在，hasCloud() 等价于「是否配了 VITE_CLOUD_ENV_ID」，
 *     没配就仍连自托管后端（开发期直连局域网 IP 的旧姿势仍然可用）。
 *
 * ── 协议 ──
 *
 * 云函数约定 `event = { action, ...payload, loggedIn, token }`：
 *   - `loggedIn`：**客户端自报**的账号状态（由会话令牌是否为空推导）。云环境里
 *     每个调用者都有 OPENID，但「未登录」的体验要保留（无主空间开放等），
 *     所以由客户端声明执行口径，云函数据此决定 openid 是否参与归属判定。
 *   - 成功直接返回数据对象；失败返回 `{ e: { status, message } }`，这里转成 BackendError。
 */
import { CLOUD_ENABLED, CLOUD_ENV_ID } from '@/config'
import { BackendError } from '@/services/backendError'

/** 云函数名（与 cloudfunctions/ 下的目录名一一对应） */
export type CloudFunctionName = 'auth' | 'trips' | 'guides' | 'weather'

interface WxCloudLike {
  init(opts: { env: string }): void
  callFunction(opts: {
    name: string
    data?: Record<string, unknown>
  }): Promise<{ result?: unknown }>
}

interface WxLike {
  cloud?: WxCloudLike
}

function wxCloud(): WxCloudLike | null {
  const wx = (globalThis as { wx?: WxLike }).wx
  return wx && wx.cloud && typeof wx.cloud.callFunction === 'function' ? wx.cloud : null
}

/** 当前环境是否走云函数通道（判据见文件头） */
export function hasCloud(): boolean {
  if (!CLOUD_ENABLED) return false
  return wxCloud() !== null
}

/** 云环境 id（供文档 / 调试展示） */
export function cloudEnvId(): string {
  return CLOUD_ENV_ID
}

/**
 * 初始化云开发。必须在任何 callFunction 之前调用（App.vue onLaunch 最前面）。
 * 非云环境（测试 / H5 / 未配 env id）是安全的空操作。
 */
export function initCloud(): void {
  const cloud = wxCloud()
  if (!cloud) return
  cloud.init({ env: CLOUD_ENV_ID })
}

/**
 * 调用云函数并按约定解包。
 *
 * 失败归一成 BackendError：
 *   - 云调用本身失败（网络 / 未初始化）→ status 0；
 *   - 云函数返回 `{ e: { status, message } }` → 用其中的 status。
 */
export async function callCloud<T>(
  name: CloudFunctionName,
  event: Record<string, unknown>
): Promise<T> {
  const cloud = wxCloud()
  if (!cloud) throw new BackendError('云开发不可用', 0)

  let res: { result?: unknown }
  try {
    res = await cloud.callFunction({ name, data: event })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new BackendError(msg || '云函数调用失败', 0)
  }

  const result = res?.result
  if (result && typeof result === 'object' && 'e' in (result as Record<string, unknown>)) {
    const err = (result as { e?: { status?: unknown; message?: unknown } }).e || {}
    throw new BackendError(String(err.message || '云端返回错误'), Number(err.status) || 0)
  }
  return result as T
}
