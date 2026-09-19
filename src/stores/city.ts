import { defineStore } from 'pinia'
import type { CityPassport, CityStatus, CityGuide } from '@/types'
import { uid } from '@/utils/id'
import { CITY_GEO, resolveCityName, type CityGeo } from '@/data/citiesGeo'
import { geocode } from '@/services/amap'
import { createBackend, type BackendClient } from '@/services/backend'
import { identityValid } from '@/services/identity'
import { storage } from '@/repository/storage'
import { AMAP_ENABLED, BACKEND_ENABLED } from '@/config'

const NICK_KEY = 'travel_nick_v1'

/**
 * 城市足迹（护照）本地存储。
 * 与行程数据独立存放（单独 storage key），互不干扰；
 * 接后端时只需把下方 read / write 换成请求即可。
 */
const KEY = 'travel_cities_v1'

function read(): CityPassport[] {
  try {
    const raw = uni.getStorageSync(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 旧数据没有 owner（打归属标签之前写的）：归一成 ''（可认领），
    // 让「这条足迹属于谁」永远是明确的字符串比较，而不是 undefined 特例
    return (parsed as CityPassport[]).map((p) => ({ ...p, owner: p.owner || '' }))
  } catch {
    return []
  }
}

function write(list: CityPassport[]): void {
  try {
    uni.setStorageSync(KEY, JSON.stringify(list))
  } catch (e) {
    console.warn('[city] 写入失败', e)
  }
}

/**
 * 匿名条目认领：owner 为空的条目（未登录时在本机创建的）在登录身份下
 * 编辑 / 回拉时归到当前名下。已归属别人的条目绝不动 —— 那是别人的数据，
 * 归 onIdentityChanged 清出本地，而不是改个标签据为己有。
 */
function claimLocal(p: CityPassport, openid: string): void {
  if (openid && !p.owner) p.owner = openid
}

interface State {
  passports: CityPassport[]
  ready: boolean
  /** 共享攻略：按城市名聚合（来自后端，多人可见） */
  sharedGuides: Record<string, CityGuide[]>
  /** 当前用户的发布昵称 */
  nickname: string
}

function readNick(): string {
  try {
    const v = uni.getStorageSync(NICK_KEY)
    return v ? String(v) : '我'
  } catch {
    return '我'
  }
}

function writeNick(n: string): void {
  try {
    uni.setStorageSync(NICK_KEY, n)
  } catch {
    /* 忽略 */
  }
}

/**
 * backend 客户端 —— **按 store 实例各持一份**（同 trip store 的 backends）。
 *
 * 会话令牌存在行程 store 的同步元数据（travel_sync_v1）里，本 store 没有自己的
 * 登录状态 —— 所以令牌在**每次请求时**从当前设备的存储现取，而不是在 load() 时
 * 推送给某个全局变量。旧实现（restoreSessionToken + 模块级 sessionToken）有两个病：
 *   · 全局令牌在多实例（测试 / 多窗口）下会串台；
 *   · 「load() 时恢复一次」意味着登录 / 登出后必须再有机会 load() 才生效，
 *     这类时序依赖正是「取决于你先访问了哪个页面」型 bug 的温床。
 */
const backends = new WeakMap<object, BackendClient>()

function sessionTokenOf(): string {
  const id = storage.readSync().identity
  return id && identityValid(id) ? String(id.token || '') : ''
}

/**
 * 按 store 实例缓存「每城市一个在途发布」：markCity / setStatus / saveGuide
 * 连续触发时，同一城市的发布复用同一个 Promise，避免并发 upsert 打爆后端。
 */
const publishInflight = new WeakMap<object, Map<string, Promise<void>>>()

/** 当前登录身份的 openid（未登录为空串） */
function openidOf(): string {
  const id = storage.readSync().identity
  return id && identityValid(id) ? String(id.openid || '') : ''
}

export const useCityStore = defineStore('city', {
  state: (): State => ({ passports: [], ready: false, sharedGuides: {}, nickname: readNick() }),

  getters: {
    visited(state): CityPassport[] {
      return state.passports
        .filter((p) => p.status === 'visited')
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },
    wish(state): CityPassport[] {
      return state.passports
        .filter((p) => p.status === 'wish')
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },
    countVisited(state): number {
      return state.passports.filter((p) => p.status === 'visited').length
    },
    countWish(state): number {
      return state.passports.filter((p) => p.status === 'wish').length
    },
    has(state): (name: string) => boolean {
      return (name: string) => state.passports.some((p) => p.name === name.trim())
    },
    byName(state): (name: string) => CityPassport | undefined {
      return (name: string) => state.passports.find((p) => p.name === name.trim())
    },
    all(state): CityPassport[] {
      return state.passports
    },
    /** 某城市的全部共享攻略（含自己发布的） */
    sharedOf(state): (name: string) => CityGuide[] {
      return (name: string) => state.sharedGuides[resolveCityName(name)] || []
    }
  },

  actions: {
    load() {
      this.passports = read()
      this.ready = true
      this.nickname = readNick()
      // 令牌不需要在这里恢复：api() 的 token 回调每次请求现取（见 backends 的说明）
      // 已登录时重划本地数据范围并回拉自己的足迹（换设备 / 重装 / 换账号后恢复；
      // 未登录时 onIdentityChanged 直接返回，不影响离线可见性）
      void this.onIdentityChanged()
    },

    /**
     * 登录身份变化后的本地数据重划（trip store 的 login() 持久化新身份后调用；
     * load() 也走这里 —— 启动时按当前身份整理一遍）。
     *
     * 与行程 login() 的重拉是同一套路：
     *   · openid 为空（未登录 / 登出）：不动本地数据 —— 离线创建的足迹要继续可见；
     *   · 清掉「明确属于别人」的条目（owner 非空且 ≠ 当前 openid）：上个账号在
     *     本机留下的副本不能被新账号编辑 / 删除（服务端会 403，留着就是脏数据）。
     *     只清本地，**不撤回服务端** —— 那些足迹仍然属于原账号；
     *   · 认领 owner='' 的匿名条目归当前身份（本机未登录时创建的数据）；
     *   · 最后回拉自己的云端足迹并进来（失败静默，不影响本地）。
     */
    async onIdentityChanged(): Promise<void> {
      const openid = openidOf()
      if (!openid) return
      let changed = false
      const kept: CityPassport[] = []
      for (const p of this.passports) {
        if (p.owner && p.owner !== openid) {
          changed = true
          continue
        }
        if (!p.owner) {
          p.owner = openid
          changed = true
        }
        kept.push(p)
      }
      this.passports = kept
      if (changed) this.persist()
      await this.syncMine()
    },

    /** 本实例的 backend 客户端（懒创建，WeakMap 缓存，令牌每请求现取） */
    api(): BackendClient {
      let b = backends.get(this)
      if (!b) {
        b = createBackend({ token: sessionTokenOf })
        backends.set(this, b)
      }
      return b
    },

    setNick(n: string) {
      const v = (n || '').trim() || '我'
      this.nickname = v
      writeNick(v)
    },

    /**
     * 发布到后端用的作者名。
     *
     * 默认昵称「我」人人一样：两个人都用「我」时，(城市, 作者) 唯一键会互踩，
     * 后一个 upsert 会因归属校验 403 —— 发布就静默失败了。所以没起昵称时，
     * 用 openid 末 4 位派生一个稳定的兜底名（同一人恒一致，改也不影响旧数据归属）。
     */
    authorNameOf(): string {
      if (this.nickname && this.nickname !== '我') return this.nickname
      const openid = openidOf()
      return openid ? `旅人${openid.slice(-4)}` : '我'
    },

    /** 拉取某城市的共享攻略（后端不可达时静默回退，不影响本地） */
    async loadShared(name: string) {
      if (!BACKEND_ENABLED) return
      try {
        const r = await this.api().getCityGuides(name)
        this.sharedGuides[resolveCityName(name)] = r.guides || []
      } catch {
        /* 后端不可达：保留已有内容（可能为空），回退本地 */
      }
    },

    /** 把当前用户在某城市的攻略 / 评价发布到后端（按作者名 upsert，归属记 openid） */
    async publishMyGuide(name: string) {
      if (!BACKEND_ENABLED) return
      const p = this.passports.find((x) => x.name === name.trim())
      if (!p) return
      const key = resolveCityName(name)
      // 同一城市在途就复用：连点 / 连续改动不会并发打出多个 upsert
      let inflight = publishInflight.get(this)
      if (!inflight) {
        inflight = new Map()
        publishInflight.set(this, inflight)
      }
      const running = inflight.get(key)
      if (running) return running
      const task = (async () => {
        try {
          // 先让出一个微任务再读字段：markCity 后常紧跟 saveGuide（同步连续调用），
          // 去重会合并成一次发布 —— 等这个 tick 的改动都落完，发布的才是最终状态。
          await Promise.resolve()
          await this.api().upsertGuide(p.name, {
            author: this.authorNameOf(),
            status: p.status,
            visitDate: p.visitDate,
            guide: p.guide,
            review: p.review,
            rating: p.rating,
            wishNote: p.wishNote
          })
          await this.loadShared(p.name)
        } catch (e) {
          console.warn('[city] 发布到后端失败，仅保存在本地', e)
        } finally {
          inflight!.delete(key)
        }
      })()
      inflight.set(key, task)
      return task
    },

    persist() {
      write(this.passports)
    },

    coordsOf(name: string): CityGeo {
      return CITY_GEO[resolveCityName(name)] || { lat: 0, lng: 0 }
    },

    /** 异步补全坐标：先查表，表内没有再走高德地理编码 */
    async ensureCoords(p: CityPassport): Promise<void> {
      if (p.lat && p.lng) return
      const g = CITY_GEO[resolveCityName(p.name)]
      if (g && g.lat && g.lng) {
        p.lat = g.lat
        p.lng = g.lng
        this.persist()
        return
      }
      if (AMAP_ENABLED) {
        const r = await geocode(p.name)
        if (r) {
          p.lat = r.latitude
          p.lng = r.longitude
          this.persist()
        }
      }
    },

    /** 标记一个城市为去过 / 想去（已存在则切换状态） */
    markCity(name: string, status: CityStatus): CityPassport {
      const nm = name.trim()
      const openid = openidOf()
      let p = this.passports.find((x) => x.name === nm)
      if (!p) {
        const c = this.coordsOf(nm)
        p = {
          id: uid('city'),
          name: nm,
          status,
          lat: c.lat,
          lng: c.lng,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          owner: openid
        }
        this.passports.push(p)
      } else {
        claimLocal(p, openid)
        p.status = status
        p.updatedAt = Date.now()
      }
      this.persist()
      void this.ensureCoords(p)
      // 自动发布（已登录才发）：足迹改动即时同步到服务端。
      // 匿名用户保持纯本地 —— 服务端的 (城市, 作者) 唯一键没有 openid 兜底时
      // 全靠昵称区分，匿名自动发布会让「我」们互相踩踏。
      if (sessionTokenOf()) void this.publishMyGuide(nm)
      return p
    },

    setStatus(name: string, status: CityStatus) {
      const p = this.passports.find((x) => x.name === name.trim())
      if (!p) return
      claimLocal(p, openidOf())
      p.status = status
      p.updatedAt = Date.now()
      this.persist()
      if (sessionTokenOf()) void this.publishMyGuide(name)
    },

    /** 保存攻略 / 评价 / 评分 / 到访日期 / 想去理由 */
    saveGuide(
      name: string,
      payload: {
        guide?: string
        review?: string
        rating?: number
        visitDate?: string
        wishNote?: string
      }
    ) {
      const p = this.passports.find((x) => x.name === name.trim())
      if (!p) return
      claimLocal(p, openidOf())
      if (payload.guide !== undefined) p.guide = payload.guide
      if (payload.review !== undefined) p.review = payload.review
      if (payload.rating !== undefined) p.rating = payload.rating
      if (payload.visitDate !== undefined) p.visitDate = payload.visitDate
      if (payload.wishNote !== undefined) p.wishNote = payload.wishNote
      p.updatedAt = Date.now()
      this.persist()
      if (sessionTokenOf()) void this.publishMyGuide(name)
    },

    /**
     * 回拉我自己的足迹（服务端按 openid 归属过滤）。
     *
     * 用途：换设备 / 重装 / 多设备 —— 本地 storage 是按设备隔离的，登录后把
     * 「我在云端的所有足迹」并回来。合并口径：按城市名 upsert，服务端 updatedAt
     * 更新才覆盖；**只合并不删除**（本地的删除走 removeCity → 撤回，不靠拉取传播）。
     *
     * 查找已有条目时限定 owner === 当前 openid：别人的本地条目不能被我的云端
     * 数据覆盖（那会把别人的足迹改成我的内容）。只调用于 onIdentityChanged ——
     * 匿名条目在那之前已被认领，不会出现「同名城里有条无主的」导致重复建条。
     */
    async syncMine(): Promise<number> {
      if (!BACKEND_ENABLED) return 0
      if (!sessionTokenOf()) return 0
      const openid = openidOf()
      let guides: Awaited<ReturnType<BackendClient['getMyGuides']>>['guides']
      try {
        const r = await this.api().getMyGuides()
        guides = r.guides || []
      } catch (e) {
        console.warn('[city] 回拉我的足迹失败，继续用本地', e)
        return 0
      }
      // 同一城市可能有多条（改过昵称会留下旧行）：取 updatedAt 最新的一条
      const latest = new Map<string, (typeof guides)[number]>()
      for (const g of guides) {
        const name = String(g.cityName || '').trim()
        if (!name) continue
        const prev = latest.get(name)
        if (!prev || (g.updatedAt || 0) > (prev.updatedAt || 0)) latest.set(name, g)
      }
      let merged = 0
      for (const [name, g] of latest) {
        const p = this.passports.find((x) => x.name === name && x.owner === openid)
        if (!p) {
          const c = this.coordsOf(name)
          this.passports.push({
            id: uid('city'),
            name,
            status: g.status,
            lat: c.lat,
            lng: c.lng,
            visitDate: g.visitDate,
            guide: g.guide,
            review: g.review,
            rating: g.rating,
            wishNote: g.wishNote,
            createdAt: g.createdAt || Date.now(),
            updatedAt: g.updatedAt || Date.now(),
            owner: openid
          })
          merged += 1
          continue
        }
        if ((g.updatedAt || 0) > p.updatedAt) {
          p.status = g.status
          if (g.visitDate !== undefined) p.visitDate = g.visitDate
          if (g.guide !== undefined) p.guide = g.guide
          if (g.review !== undefined) p.review = g.review
          if (g.rating !== undefined) p.rating = g.rating
          if (g.wishNote !== undefined) p.wishNote = g.wishNote
          p.updatedAt = g.updatedAt || Date.now()
          merged += 1
        }
      }
      if (merged) this.persist()
      return merged
    },

    /**
     * 拉「服务端记在我名下的」全部足迹（按 openid 归属过滤），**不合并进本地**。
     *
     * 与 `syncMine()` 的分工：那边是「回拉并合并」，用于换设备恢复；这边是给
     * 「我的攻略」管理页一个**云端视角** —— 要看的是服务端到底存了什么，
     * 包括改过昵称留下的旧行、以及本机已经没有副本的那些。
     *
     * 失败时**抛出**（由界面显示）：这一页存在的意义就是对照，静默返回空数组
     * 会让它显示成「云端没有记录」，而真实原因可能是网络不通。
     */
    async fetchMyCloud(): Promise<CityGuide[]> {
      if (!BACKEND_ENABLED) throw new Error('未启用云同步')
      if (!sessionTokenOf()) throw new Error('尚未登录')
      const r = await this.api().getMyGuides()
      return r.guides || []
    },

    /**
     * 按 id 撤回云端的一条记录（服务端校验归属，别人的删不掉）。
     *
     * 为什么不用 `retractMyGuide(name)`：那个按 (城市, 作者名) 删，只能删
     * 「当前昵称下」的那一条 —— 改过昵称留下的旧行正好删不到，而清理旧行
     * 正是管理页的主要用途之一。
     */
    async deleteCloudGuide(id: string, cityName?: string): Promise<void> {
      if (!BACKEND_ENABLED) throw new Error('未启用云同步')
      await this.api().deleteGuide(id)
      // 顺手作废本机的共享缓存：留着它，回到足迹页会看到刚删掉的那条还在
      if (cityName) delete this.sharedGuides[resolveCityName(cityName)]
    },

    /** 撤回我在某城市发布到后端的攻略（删除城市时由 removeCity 自动调用） */
    async retractMyGuide(name: string) {
      if (!BACKEND_ENABLED) return
      try {
        await this.api().retractGuide(name.trim(), this.authorNameOf())
        delete this.sharedGuides[resolveCityName(name)]
      } catch (e) {
        console.warn('[city] 撤回后端攻略失败', e)
      }
    },

    removeCity(name: string) {
      const nm = name.trim()
      this.passports = this.passports.filter((x) => x.name !== nm)
      this.persist()
      // 本地删除与云端撤回一体：只删本地会让别人的广场里永远留着这条足迹
      void this.retractMyGuide(nm)
    }
  }
})
