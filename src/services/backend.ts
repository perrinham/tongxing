/**
 * 共享后端客户端。
 *
 * 用 uni.request 封装 REST 调用，统一处理：
 *  - 鉴权头（X-Api-Key / Bearer，见 config.BACKEND_TOKEN）
 *  - 超时（小程序默认 60s，太长了，用户会以为卡死）
 *  - 幂等重试：网络抖动时自动重试 GET 与「推送快照」这类幂等请求。
 *    注意 **POST /api/trips/:id 是幂等的**（服务端按实体 LWW 合并，重复投递无副作用），
 *    所以这里敢重试它；换成非幂等接口必须关掉 retry。
 *
 * 后端不可达时 Promise 会 reject，由调用方回退本地，不阻塞 UI。
 */
import { BACKEND_ENABLED, BACKEND_TOKEN, REQUEST_TIMEOUT_MS } from '@/config'
import { getBackendBase } from '@/services/backendBase'
import type {
  CityGuide,
  CityStatus,
  DiscoverTrip,
  PushResult,
  TripDoc,
  TripSpaceBrief,
  TripSpaceFull,
  Tombstone,
  WeatherReply
} from '@/types'

export interface CityGuidePayload {
  author: string
  status: CityStatus
  visitDate?: string
  guide?: string
  review?: string
  rating?: number
  wishNote?: string
}

export interface PushPayload {
  author: string
  deviceId: string
  baseRev: number | null
  doc: TripDoc | null
  tombstones: Tombstone[]
}

export class BackendError extends Error {
  status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'BackendError'
    this.status = status
  }
}

/**
 * 会话令牌（微信身份）—— 通过**工厂参数的回调**注入，见 createBackend。
 *
 * ⚠️ 与 `BACKEND_TOKEN`（共享密钥，走 Authorization / X-Api-Key）是**两套**凭据：
 *   共享密钥 = 这个客户端能不能访问后端（部署级门禁）
 *   会话令牌 = 你是哪个用户（身份，服务端做归属判定的唯一依据）
 * 混用会导致「谁都能以别人的身份写入」，所以刻意放在不同的头里。
 *
 * ⚠️ 为什么令牌不是模块级变量（曾踩过）：旧实现是 `let sessionToken` +
 * `setSessionToken()`，测试里三个 store 同进程时 A 登录会连带把 B、C 变成
 * 「已登录」，403 类断言只能靠测试脚手架按设备重设全局变量才能测到 ——
 * 修复手段（脚手架）比疾病（全局可变状态）还绕。现改为每个 store 实例
 * 各持一份 backend（WeakMap），令牌在**每次发请求时**经 `token()` 现取：
 * 登录 / 登出 / 续期后无需任何「推送令牌」的动作，也不可能串台。
 */

export interface BackendOptions {
  /**
   * 会话令牌现取回调（每次构造请求头时调用）。
   * 返回空串 = 匿名请求。不传 = 永远匿名。
   */
  token?: () => string
}

/** 构造请求头。connId 是实时连接 id（每实例各一，显式传参，不放模块级）。 */
function makeHeaders(sessionToken: string, connId: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (BACKEND_TOKEN) h['X-Api-Key'] = BACKEND_TOKEN
  if (sessionToken) h['X-Session-Token'] = sessionToken
  if (connId) h['X-Conn-Id'] = connId
  return h
}

/** 4xx 是「请求本身有问题」，重试没意义；5xx 与网络错误才值得重试 */
function worthRetry(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function once<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  sessionToken = '',
  connId = ''
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    uni.request({
      url: getBackendBase() + path,
      method,
      data: body as Record<string, unknown> | undefined,
      header: makeHeaders(sessionToken, connId),
      timeout: REQUEST_TIMEOUT_MS,
      success: (res) => {
        const code = res.statusCode
        if (code >= 200 && code < 300) {
          resolve(res.data as T)
        } else {
          const msg =
            (res.data as { error?: string } | undefined)?.error || `后端返回 ${code}`
          reject(new BackendError(msg, code))
        }
      },
      fail: (err: { errMsg?: string }) => {
        reject(new BackendError(err?.errMsg || '网络请求失败', 0))
      }
    })
  })
}

async function req<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  opts: { retry?: number; connId?: string; token?: () => string } = {}
): Promise<T> {
  const attempts = (opts.retry ?? 0) + 1
  const connId = opts.connId || ''
  const token = opts.token || (() => '')
  let lastErr: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      // 令牌每次尝试都现取：重试期间如果登录态刚好续期/登出，用的也是最新那份
      return await once<T>(method, path, body, token(), connId)
    } catch (e) {
      lastErr = e
      const status = e instanceof BackendError ? e.status : 0
      if (i === attempts - 1 || !worthRetry(status)) break
      // 退避：400ms、1200ms，避免瞬间把请求打满
      await delay(400 * Math.pow(3, i))
    }
  }
  throw lastErr instanceof Error ? lastErr : new BackendError('请求失败', 0)
}

/** backend 客户端接口（store 按实例各持一份，见 createBackend） */
export interface BackendClient {
  enabled: boolean
  health(): Promise<{ ok: boolean; version?: string; authRequired?: boolean }>
  wxLogin(code: string): Promise<{ openid: string; token: string; expiresAt: number; dev?: boolean }>
  authMe(): Promise<{ openid: string; expiresAt: number }>
  getCityGuides(name: string): Promise<{ name: string; guides: CityGuide[] }>
  getAllCities(status?: CityStatus): Promise<{ cities: { name: string; guides: CityGuide[] }[] }>
  getMyGuides(): Promise<{ guides: CityGuide[] }>
  upsertGuide(name: string, payload: CityGuidePayload): Promise<{ guide: CityGuide }>
  retractGuide(name: string, author: string): Promise<{ ok: boolean; removed: number }>
  updateGuide(id: string, payload: Partial<CityGuidePayload>): Promise<{ guide: CityGuide }>
  deleteGuide(id: string): Promise<{ ok: boolean }>
  listSpaces(withDoc?: boolean): Promise<{ spaces: (TripSpaceBrief | TripSpaceFull)[] }>
  listDiscoverTrips(): Promise<{ trips: DiscoverTrip[] }>
  getWeather(place: string, start: string, end: string): Promise<WeatherReply>
  getSpace(id: string): Promise<{ space: TripSpaceFull }>
  getSpaceByCode(code: string): Promise<{ space: TripSpaceFull }>
  joinSpace(code: string): Promise<{ space: TripSpaceFull; joined: boolean }>
  claimSpace(id: string, code: string): Promise<{ ok: boolean }>
  pushSpace(id: string, payload: PushPayload, connId?: string): Promise<PushResult>
  deleteSpace(id: string, connId?: string): Promise<{ ok: boolean; deleted?: boolean }>
}

/**
 * 创建一个 backend 客户端实例。
 *
 * 每个调用方（trip store / city store）各持一份 —— 与 createRealtime / createHlc
 * 同一个理由：模块级单例 + 模块级可变令牌在多实例场景下会串台。
 * 实例本身**无可变状态**：令牌是每次请求现取的回调，连接 id 是显式传参。
 */
export function createBackend(opts: BackendOptions = {}): BackendClient {
  const token = opts.token || (() => '')
  return {
    enabled: BACKEND_ENABLED,

    /** 健康检查（用于「云同步」页展示后端是否可达） */
    health(): Promise<{ ok: boolean; version?: string; authRequired?: boolean }> {
      return req('GET', '/api/health', undefined, { token })
    },

    // ───────────── 身份 ─────────────

    /**
     * 用微信登录 code 换身份。
     *
     * ⚠️ **不能重试**：code 是一次性的，微信侧用掉就失效，重试必然失败并让用户
     * 看到一次莫名其妙的报错。所以这里刻意不传 `retry`（默认 0）。
     */
    wxLogin(code: string): Promise<{
      openid: string
      token: string
      expiresAt: number
      dev?: boolean
    }> {
      return req('POST', '/api/auth/wx', { code }, { token })
    },

    /** 校验当前会话令牌是否仍然有效 */
    authMe(): Promise<{ openid: string; expiresAt: number }> {
      return req('GET', '/api/auth/me', undefined, { token })
    },

    // ───────────── 城市攻略 ─────────────

    /** 拉取某城市所有共享攻略 */
    getCityGuides(name: string): Promise<{ name: string; guides: CityGuide[] }> {
      return req('GET', '/api/cities/' + encodeURIComponent(name), undefined, { token, retry: 1 })
    },

    /** 拉取全部城市（概览用，可选按状态过滤） */
    getAllCities(status?: CityStatus): Promise<{ cities: { name: string; guides: CityGuide[] }[] }> {
      return req('GET', '/api/cities' + (status ? '?status=' + status : ''), undefined, {
        token,
        retry: 1
      })
    },

    /** 拉取我自己的全部足迹（服务端按 openid 归属过滤；登录后回拉 / 换设备恢复用） */
    getMyGuides(): Promise<{ guides: CityGuide[] }> {
      return req('GET', '/api/my/guides', undefined, { token, retry: 1 })
    },

    /** 按 (城市, 作者) upsert 一条攻略 —— 「我的攻略」发布 / 更新 */
    upsertGuide(name: string, payload: CityGuidePayload): Promise<{ guide: CityGuide }> {
      return req('POST', '/api/cities/' + encodeURIComponent(name) + '/guides', payload, {
        token,
        retry: 1
      })
    },

    /** 按作者撤回：删除我在该城市发布的攻略（删城市时同步撤回） */
    retractGuide(name: string, author: string): Promise<{ ok: boolean; removed: number }> {
      return req(
        'DELETE',
        '/api/cities/' + encodeURIComponent(name) + '/guides?author=' + encodeURIComponent(author),
        undefined,
        { token }
      )
    },

    /** 更新某条攻略 */
    updateGuide(id: string, payload: Partial<CityGuidePayload>): Promise<{ guide: CityGuide }> {
      return req('PUT', '/api/guides/' + encodeURIComponent(id), payload, { token, retry: 1 })
    },

    /** 删除某条攻略 */
    deleteGuide(id: string): Promise<{ ok: boolean }> {
      return req('DELETE', '/api/guides/' + encodeURIComponent(id), undefined, { token })
    },

    // ───────────── 行程空间同步 ─────────────

    /** 云端空间列表；withDoc=true 时附带全量文档（首次同步/整体拉取用） */
    listSpaces(withDoc = false): Promise<{ spaces: (TripSpaceBrief | TripSpaceFull)[] }> {
      return req('GET', '/api/trips' + (withDoc ? '?withDoc=1' : ''), undefined, { token, retry: 1 })
    },

    /**
     * 发现广场：全部登录用户可见的未删除行程（只读浏览）。
     * 非 mine 条目服务端已剥 code —— 广场条目不进入本地同步库。
     */
    listDiscoverTrips(): Promise<{ trips: DiscoverTrip[] }> {
      return req('GET', '/api/trips/discover', undefined, { token, retry: 1 })
    },

    /** 逐日天气（服务端代理 Open-Meteo）。GET 幂等，失败由调用方静默降级 */
    getWeather(place: string, start: string, end: string): Promise<WeatherReply> {
      const q =
        `place=${encodeURIComponent(place)}` +
        `&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
      return req('GET', `/api/weather?${q}`, undefined, { token, retry: 1 })
    },

    getSpace(id: string): Promise<{ space: TripSpaceFull }> {
      return req('GET', '/api/trips/' + encodeURIComponent(id), undefined, { token, retry: 1 })
    },

    /** 按分享码加入 */
    getSpaceByCode(code: string): Promise<{ space: TripSpaceFull }> {
      return req('GET', '/api/trips/by-code/' + encodeURIComponent(code), undefined, {
        token,
        retry: 1
      })
    },

    /**
     * 凭分享码加入（**会登记成员身份**，所以是 POST）。
     *
     * 与 `getSpaceByCode` 的区别：带会话令牌调用时，服务端会把当前用户登记为该空间成员，
     * 之后才有写权限。无身份调用与 GET 版等价（不登记）。
     * 不重试：重复登记是幂等的，但这个请求失败通常意味着「码不对 / 身份不对」，
     * 重试只会把用户多等几秒。
     */
    joinSpace(code: string): Promise<{ space: TripSpaceFull; joined: boolean }> {
      return req('POST', '/api/trips/join', { code }, { token })
    },

    /**
     * 认领一个无归属的行程（接账号体系之前创建的）。
     * 需要出示该行程的分享码 —— 分享码正是旧权限模型下的访问凭证。
     */
    claimSpace(id: string, code: string): Promise<{ ok: boolean }> {
      return req('POST', '/api/trips/' + encodeURIComponent(id) + '/claim', { code }, { token })
    },

    /**
     * 推送本地快照并合并。
     * 幂等：同一份快照重复推送不会产生副作用，所以允许重试。
     *
     * @param connId 本机实时连接 id。服务端据此把本连接排除在广播之外 ——
     *   它已经是合并结果的接收方，不需要再收到「这个地方变了，去拉一下吧」。
     */
    pushSpace(id: string, payload: PushPayload, connId = ''): Promise<PushResult> {
      return req('POST', '/api/trips/' + encodeURIComponent(id), payload, { retry: 1, connId, token })
    },

    /** 删除云端空间 */
    deleteSpace(id: string, connId = ''): Promise<{ ok: boolean; deleted?: boolean }> {
      return req('DELETE', '/api/trips/' + encodeURIComponent(id), undefined, { connId, token })
    }
  }
}
