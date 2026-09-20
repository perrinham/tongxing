import type { Hlc, Identity, PersistShape, SyncMeta, SyncStatus, Tombstone } from '@/types'

const KEY = 'travel_h5_state_v1'
const META_KEY = 'travel_h5_meta_v1'
const SYNC_KEY = 'travel_sync_v1'

/**
 * 校验从存储里读出来的 HLC 状态。
 *
 * 存储里的东西一律当成不可信输入（可能被手改、可能是旧版本写的、可能半截写入），
 * 拿不准就返回 undefined 让调用方从当前时间重新起步 —— 这比带着一个畸形的
 * `t`（比如 NaN 或负数）进入比较要好，那种值会让所有排序结果失去意义。
 */
function normStoredHlc(v: unknown): Hlc | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Partial<Hlc>
  const t = Math.floor(Number(o.t))
  const c = Math.floor(Number(o.c))
  const n = typeof o.n === 'string' ? o.n : ''
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(c) || c < 0) return undefined
  if (!/^[0-9a-f]{8}$/.test(n)) return undefined
  return { t, c, n }
}

/**
 * 校验从存储里读出来的身份。
 *
 * 同样的口径：畸形就返回 undefined（当作未登录），而不是把半截数据带上网络。
 * 尤其要拦住「有 token 没 openid」这种 —— 它会让请求带着一个无法解析的令牌，
 * 服务端一律当匿名处理，用户看到的现象是「明明登录了却说我没权限」。
 *
 * ⚠️ 过期的身份**不在这里**清：清不清由 `identityValid` 在用时判断，
 * 存储层只做形态校验。否则一个临时不准的时钟会让人被静默登出。
 */
function normStoredIdentity(v: unknown): Identity | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Partial<Identity>
  const openid = typeof o.openid === 'string' ? o.openid : ''
  const token = typeof o.token === 'string' ? o.token : ''
  const expiresAt = Math.floor(Number(o.expiresAt))
  if (!openid || !token || !Number.isFinite(expiresAt) || expiresAt <= 0) return undefined
  return { openid, token, expiresAt, ...(o.dev === true ? { dev: true } : {}) }
}

const EMPTY: PersistShape = {
  version: 1,
  trips: [],
  members: [],
  days: [],
  items: [],
  expenses: [],
  polls: [],
  votes: [],
  meetups: [],
  locations: [],
  activeTripId: null
}

/**
 * SyncMeta 每个字段的归一化 spec —— **新增字段只需在这里加一条**。
 *
 * readSync 是**白名单式重建**（不是展开后覆盖）：存储里的东西一律当不可信输入
 * （可能被手改、可能是旧版本写的、可能半截写入），逐字段挑选并归一化。
 * 漏列一个字段就等于每次读取都把它悄悄丢掉，历史上有过两次真事故：
 *   · hlc 丢 → 冷启动后本机逻辑时钟从 0 起步，编辑推上去被判成落后而丢弃；
 *   · identity 丢 → 用户每次冷启动都被当作未登录（反复要求重新登录）。
 *
 * 末尾的 `satisfies Record<keyof SyncMeta, …>` 是编译期的牙：SyncMeta 加了字段
 * 而这里忘了加归一化（或拼错字段名），vue-tsc 直接报错 —— 「漏白名单」从
 * 运行期静默丢数据变成编译期失败。这是只读查表，不是可变模块状态。
 */
const SYNC_META_SPEC = {
  deviceId: (v: unknown) => (typeof v === 'string' ? v : ''),
  author: (v: unknown) => (typeof v === 'string' && v.trim() ? v : '我'),
  lastSyncAt: (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0),
  // 未知的状态串（旧版本写入的 / 手改坏的）一律归到 idle，不放进 store 的 switch
  lastStatus: (v: unknown) => {
    const ok =
      typeof v === 'string' &&
      (['idle', 'syncing', 'ok', 'offline', 'error', 'disabled'] as readonly string[]).includes(v)
    return ok ? (v as SyncStatus) : 'idle'
  },
  lastError: (v: unknown) => (typeof v === 'string' ? v : ''),
  revOf: (v: unknown) => (v && typeof v === 'object' ? (v as SyncMeta['revOf']) : {}),
  localAtOf: (v: unknown) =>
    v && typeof v === 'object' ? (v as SyncMeta['localAtOf']) : {},
  syncedAtOf: (v: unknown) =>
    v && typeof v === 'object' ? (v as SyncMeta['syncedAtOf']) : {},
  codes: (v: unknown) => (v && typeof v === 'object' ? (v as SyncMeta['codes']) : {}),
  tombstones: (v: unknown) => (Array.isArray(v) ? (v as Tombstone[]) : []),
  hlc: (v: unknown) => normStoredHlc(v),
  identity: (v: unknown) => normStoredIdentity(v) ?? null
} satisfies Record<keyof SyncMeta, (v: unknown) => unknown>

/**
 * SyncMeta 空值（全默认）。
 * store 的 state 初始化与 readSync 的兜底共用这份口径，避免两处手写字面量漂移。
 */
export function emptySyncMeta(): SyncMeta {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(SYNC_META_SPEC) as (keyof SyncMeta)[]) {
    out[k] = SYNC_META_SPEC[k](undefined)
  }
  // 每个字段都已按 spec 归一化，键集与 SyncMeta 一致（satisfies 保证），断言安全
  return out as unknown as SyncMeta
}

/**
 * 存储后端：与 uni 同步存储三件套同形的最小接口。
 *
 * 抽出来是为了给「多实例互抹」一个**结构性**解法：测试夹具（A/B/C 三台设备）
 * 给每个 store 实例注入固定到自己设备 sheet 的后端，隔离点从「调用时刻的
 * 全局上下文」（mock.state.device）移到「实例创建时的绑定」—— store 内部的
 * 去抖定时器 / 异步链晚点触发时，读写依然落在自己的存储里。
 * 键名不变，所以断言用的 `mock.read(dev, KEY)` 口径不受影响。
 */
export interface StorageBackend {
  getStorageSync(key: string): string
  setStorageSync(key: string, value: string): void
  removeStorageSync(key: string): void
}

/** 默认后端：uni 同步存储（生产唯一路径） */
const uniBackend: StorageBackend = {
  getStorageSync: (key) => uni.getStorageSync(key),
  setStorageSync: (key, value) => uni.setStorageSync(key, value),
  removeStorageSync: (key) => uni.removeStorageSync(key)
}

/**
 * 存储适配层。
 * 小程序走 uni 同步存储；接入后端时只需替换 read/write 两个实现，
 * 上层 store 与页面完全不用改。
 */
export function createStorage(backend: StorageBackend = uniBackend) {
  function read(): PersistShape {
    try {
      const raw = backend.getStorageSync(KEY)
      if (!raw) return { ...EMPTY }
      const parsed = JSON.parse(raw) as PersistShape
      // 数组字段统一校验数组性：损坏/被手改的存储里这些键可能是对象或标量，
      // 只兜 `?? []` 挡不住 `{"trips":{}}` 这类形状（与上面 tombstones 的口径一致）
      return {
        version: parsed.version ?? 1,
        trips: Array.isArray(parsed.trips) ? parsed.trips : [],
        members: Array.isArray(parsed.members) ? parsed.members : [],
        days: Array.isArray(parsed.days) ? parsed.days : [],
        items: Array.isArray(parsed.items) ? parsed.items : [],
        expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
        polls: Array.isArray(parsed.polls) ? parsed.polls : [],
        votes: Array.isArray(parsed.votes) ? parsed.votes : [],
        meetups: Array.isArray(parsed.meetups) ? parsed.meetups : [],
        locations: Array.isArray(parsed.locations) ? parsed.locations : [],
        activeTripId: parsed.activeTripId ?? null
      }
    } catch {
      return { ...EMPTY }
    }
  }

  function write(state: PersistShape): void {
    try {
      backend.setStorageSync(KEY, JSON.stringify(state))
    } catch (e) {
      console.warn('[storage] 写入失败', e)
    }
  }

  return {
    read,
    write,
    clear(): void {
      try {
        backend.removeStorageSync(KEY)
      } catch {
        /* 忽略 */
      }
    },
    /** 记录上次操作时间，用于「我的」页面展示 */
    touch(): void {
      try {
        backend.setStorageSync(META_KEY, String(Date.now()))
      } catch {
        /* 忽略 */
      }
    },
    lastActive(): number {
      try {
        const v = backend.getStorageSync(META_KEY)
        return v ? Number(v) : 0
      } catch {
        return 0
      }
    },

    // ───────────── 同步元数据 ─────────────
    // 与业务数据分开存：即使同步元数据损坏，本地行程也不会丢。

    readSync(): SyncMeta {
      try {
        const raw = backend.getStorageSync(SYNC_KEY)
        if (!raw) return emptySyncMeta()
        const p = JSON.parse(raw) as Partial<SyncMeta>
        // 白名单式重建：逐字段过归一化函数，而不是展开后覆盖。
        // 所有字段恒过归一化 —— 字段缺失时归一化结果与默认值一致，行为可预期。
        const out = emptySyncMeta() as unknown as Record<string, unknown>
        for (const k of Object.keys(SYNC_META_SPEC) as (keyof SyncMeta)[]) {
          out[k] = SYNC_META_SPEC[k](p[k])
        }
        return out as unknown as SyncMeta
      } catch {
        return emptySyncMeta()
      }
    },

    writeSync(meta: SyncMeta): void {
      try {
        backend.setStorageSync(SYNC_KEY, JSON.stringify(meta))
      } catch (e) {
        console.warn('[storage] 同步元数据写入失败', e)
      }
    },

    /** 清空全部本地数据（含同步元数据） */
    clearAll(): void {
      for (const k of [KEY, META_KEY, SYNC_KEY]) {
        try {
          backend.removeStorageSync(k)
        } catch {
          /* 忽略 */
        }
      }
    }
  }
}

export type StorageLike = ReturnType<typeof createStorage>

/**
 * 生产默认实例：uni 存储 + 全局键名。
 * 单实例应用里与历史行为完全一致（键名、读写路径都没变）。
 */
export const storage = createStorage()

// ───────────── 按 store 实例绑定 ─────────────
// 与 hlcClocks / backends / realtimes 同一套 WeakMap 模式：实例态不进模块级
// 可变单例。store 的动作里一律用 storageFor(this)，未绑定的实例回退默认
// storage —— 生产（单实例）路径不变，测试夹具按设备绑定后互不干扰。
const boundStorages = new WeakMap<object, StorageLike>()

/** 把某个 store 实例的存储读写绑定到指定后端（测试夹具按设备隔离用） */
export function bindStorage(store: object, s: StorageLike): void {
  boundStorages.set(store, s)
}

/** 取 store 实例绑定的存储；未绑定回退默认实例 */
export function storageFor(store: object): StorageLike {
  return boundStorages.get(store) ?? storage
}
