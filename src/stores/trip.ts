import { defineStore } from 'pinia'
import type {
  Day,
  Expense,
  ItineraryItem,
  LocationShare,
  Meetup,
  Member,
  Poll,
  PollKind,
  PushResult,
  SettlementResult,
  SyncEntityKind,
  SyncMeta,
  Tombstone,
  Trip,
  TripDoc,
  TripSpaceFull,
  Vote,
  WeatherDay
} from '@/types'
import { storageFor, emptySyncMeta } from '@/repository/storage'
import { uid } from '@/utils/id'
import { useCityStore } from '@/stores/city'
import { addDays, daysBetween, todayISO, avatarColor } from '@/utils/format'
import { generateItinerary, generateItineraryAsync, type GenerateInput, type GenerateOutput, type GenStageSink } from '@/utils/itinerary'
import type { Taste } from '@/utils/taste'
import { buildPackingList } from '@/utils/packing'
import { tallyOf, type PollTally } from '@/utils/poll'
import { settle as runSettle } from '@/utils/settlement'
import { createBackend, BackendError, type BackendClient } from '@/services/backend'
import { identityValid, loginWithWechat } from '@/services/identity'
import {
  createRealtime,
  toWsUrl,
  type RealtimeController,
  type RealtimeDenied,
  type RealtimeStatus,
  type RealtimeSubInfo,
  type RealtimeUpdate
} from '@/services/realtime'
import {
  capHlc,
  createHlc,
  hlcAfter,
  recordHlc,
  type Hlc,
  type HlcState
} from '@/services/hlc'
import {
  MERGE_META_KEYS,
  dataKeysOf,
  mergeRecord,
  withRecordHlc,
  type RecordStampable
} from '@/services/lww'
import {
  SYNC_ENABLED,
  SYNC_DEBOUNCE_MS,
  CLOCK_MAX_SKEW_MS,
  REALTIME_ENABLED,
  REALTIME_PATH,
  REALTIME_PING_MS,
  REALTIME_IDLE_TIMEOUT_MS,
  REALTIME_RETRY_BASE_MS,
  REALTIME_RETRY_MAX_MS,
  REALTIME_HELLO_TIMEOUT_MS,
  BACKEND_TOKEN
} from '@/config'
import { getBackendBase } from '@/services/backendBase'

/** 待推送墓碑的本地上限，超出丢弃最旧的（正常使用远远到不了） */
const MAX_LOCAL_TOMBSTONES = 800

/** claimAllLocal 的单个结果（SyncPage 批量认领入口用，见该方法注释） */
export interface ClaimAllResult {
  id: string
  title: string
  /** claimed = 这次归到你名下；owned = 本就有归属（跳过）；failed = 失败，原因在 error */
  outcome: 'claimed' | 'owned' | 'failed'
  error?: string
}

interface State {
  trips: Trip[]
  members: Member[]
  days: Day[]
  items: ItineraryItem[]
  expenses: Expense[]
  polls: Poll[]
  votes: Vote[]
  meetups: Meetup[]
  locations: LocationShare[]
  activeTripId: string | null
  ready: boolean
  /** 同步元数据（设备号 / 版本号 / 分享码 / 待上报墓碑 / 上次同步状态） */
  sync: SyncMeta
  /** 是否有同步请求在飞 */
  syncing: boolean
  /** 给人看的一句话状态 */
  syncMessage: string
  /**
   * 实时通道状态。
   *
   * 刻意**不进** `SyncMeta` / 本地存储：连接是「此刻的状态」，进程重启后必然要重建，
   * 存下来只会得到一份上次运行时的陈旧状态（比如持久化的 'online'），
   * 而启动时它其实还没连上 —— 界面就会显示一个谎。
   */
  realtime: {
    status: RealtimeStatus
    connId: string
    lastEventAt: number
    lastError: string
  }
}

/**
 * 自动推送的去抖定时器 —— **按 store 实例各持一份**。
 *
 * 用 WeakMap 而不是模块级单例：单例意味着「最后调度的那台设备的定时器覆盖掉别人待发的」。
 * 更糟的是回调里的 `persistSync()` 会写到**当时**的存储上 —— 单例 + 多实例 = 串台。
 * 放 WeakMap 里既避免了响应式（定时器句柄塞进 state 会被代理包一层），
 * 又保证句柄随实例回收。
 */
const syncTimers = new WeakMap<object, ReturnType<typeof setTimeout>>()

/**
 * 客户端 HLC 实例 —— 同样**按 store 实例各持一份**。
 *
 * 它内部维护的 `lastT / lastC / node` 是纯数据，不需要响应式；塞进 state 会让每次
 * `stamp()` 都触发依赖通知，所以放 WeakMap。
 *
 * ⚠️ 曾经写成模块级 `let hlcClock`（全局单例），那是个真 bug 而不是风格问题：
 *   · 三台设备（三个 store 实例，测试里正是这样）共用同一个节点号，
 *     「本机节点号」这个断言形同虚设；
 *   · `save` 闭包捕获的是**第一个**创建它的 store 的 `this`，
 *     于是 B、C 的编辑把 HLC 状态写进了 A 的 `sync` —— 每台设备各自持久化自己的
 *     逻辑时钟这件事根本没发生，而 `[9]` 那条断言却会因为「恰好写到了 A」而变绿。
 *
 * 持久化仍由 `sync.hlc` 承担（save 钩子回写），冷启动由 `load()` 重建。
 */
const hlcClocks = new WeakMap<object, ReturnType<typeof createHlc>>()

/**
 * 实时通道控制器 —— 同样**按 store 实例各持一份**（WeakMap，同 hlcClocks 的理由）。
 *
 * 写成模块级单例的后果比 HLC 那次更糟：三个实例共用一条连接、一份订阅列表，
 * 而且 `token` 回调取的是**第一个**实例的身份 —— A 登录后 B、C 就一起「有权限」了。
 * 即时同步的隔离性完全失效，而测试里看起来一切正常。
 */
const realtimes = new WeakMap<object, RealtimeController>()

/**
 * backend 客户端 —— **按 store 实例各持一份**（WeakMap，同 hlcClocks 的理由）。
 *
 * 会话令牌曾是模块级变量 + `setSessionToken()` 推送式更新：三个 store 同进程时
 * A 登录会把 B、C 一起变成「已登录」，测试只能靠脚手架按设备重设全局变量，
 * 属于「用脚手架绕开产品层的状态泄漏」。现改为每实例一份 client，
 * 令牌在每次请求时经 `token()` 回调从 `this.sync.identity` 现取 ——
 * 既是天然隔离（实例各自闭包），也没有「忘了推送令牌」这类时序 bug 的容身之处。
 */
const backends = new WeakMap<object, BackendClient>()

/**
 * 单个空间的拉取去重状态（按实例各持一份）。
 *
 * 作用：通知在拉取**飞行期间**又来了时，不并发发第二个请求，而是记一笔
 * 「拉完再拉一次」。这样既不会丢更新（收敛），也不会把请求打成一堆。
 * 服务端已经有 80ms 的合并窗口，这里是第二道 —— 因为「两次通知间隔超过窗口
 * 但拉取还没回来」是真实存在的（网络慢的时候）。
 */
const pullStates = new WeakMap<object, { pulling: Set<string>; again: Set<string> }>()

export const useTripStore = defineStore('trip', {
  state: (): State => ({
    trips: [],
    members: [],
    days: [],
    items: [],
    expenses: [],
    polls: [],
    votes: [],
    meetups: [],
    locations: [],
    activeTripId: null,
    ready: false,
    // 与 storage.emptySyncMeta() 同一口径（默认值只在 storage.ts 的 spec 里写一份），
    // load() 时会被 storage.readSync() 的结果整体替换。
    sync: emptySyncMeta(),
    syncing: false,
    syncMessage: '',
    realtime: { status: 'idle', connId: '', lastEventAt: 0, lastError: '' }
  }),

  getters: {
    activeTrip(state): Trip | null {
      return state.trips.find((t) => t.id === state.activeTripId) || null
    },
    membersOf(): (tripId: string) => Member[] {
      return (tripId: string) => this.members.filter((m) => m.tripId === tripId)
    },
    daysOf(): (tripId: string) => Day[] {
      return (tripId: string) =>
        this.days.filter((d) => d.tripId === tripId).sort((a, b) => a.index - b.index)
    },
    itemsOf(): (tripId: string) => ItineraryItem[] {
      return (tripId: string) => this.items.filter((i) => i.tripId === tripId)
    },
    itemsOfDay(): (dayId: string) => ItineraryItem[] {
      return (dayId: string) =>
        this.items.filter((i) => i.dayId === dayId).sort((a, b) => a.order - b.order)
    },
    expensesOf(): (tripId: string) => Expense[] {
      return (tripId: string) =>
        this.expenses
          .filter((e) => e.tripId === tripId)
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt))
    },
    pollsOf(): (tripId: string) => Poll[] {
      return (tripId: string) =>
        this.polls.filter((p) => p.tripId === tripId).sort((a, b) => b.createdAt - a.createdAt)
    },
    votesOf(): (pollId: string) => Vote[] {
      return (pollId: string) => this.votes.filter((v) => v.pollId === pollId)
    },
    /** 某次投票的计票投影（实名票 + 分布 + 胜者）；不存在返回 null */
    tallyOf(): (pollId: string) => PollTally | null {
      return (pollId: string) => {
        const poll = this.polls.find((p) => p.id === pollId)
        if (!poll) return null
        return tallyOf(poll, this.votes.filter((v) => v.pollId === pollId), this.members)
      }
    },
    /** 当前成员在某次投票里投的选项 */
    myVoteOf(): (pollId: string) => string | null {
      return (pollId: string) => {
        const self = this.members.find((m) => m.isSelf)
        if (!self) return null
        return this.votes.find((v) => v.pollId === pollId && v.memberId === self.id)?.optionId ?? null
      }
    },
    /** 某行程的集合点（每行程至多一条）；没定返回 null */
    meetupOf(): (tripId: string) => Meetup | null {
      return (tripId: string) => this.meetups.find((m) => m.tripId === tripId) ?? null
    },
    /** 某行程所有成员的当前位置（记录存在 = 正在共享） */
    memberLocationsOf(): (tripId: string) => LocationShare[] {
      return (tripId: string) => this.locations.filter((l) => l.tripId === tripId)
    },
    /** 本机是否正在共享某行程的位置（= 有我的位置记录） */
    isSharingLocation(): (tripId: string) => boolean {
      return (tripId: string) => {
        const self = this.members.find((m) => m.isSelf && m.tripId === tripId)
        if (!self) return false
        return this.locations.some((l) => l.tripId === tripId && l.memberId === self.id)
      }
    },
    /** 行程预估花费（按行程项 cost × 人数） */
    estimateOf(): (tripId: string) => number {
      return (tripId: string) => {
        const people = this.members.filter((m) => m.tripId === tripId).length || 1
        return this.items
          .filter((i) => i.tripId === tripId)
          .reduce((s, i) => s + i.cost * people, 0)
      }
    },
    /** 实际已记账总额 */
    spentOf(): (tripId: string) => number {
      return (tripId: string) =>
        this.expenses
          .filter((e) => e.tripId === tripId)
          .reduce((s, e) => s + (Number.isFinite(e.amount) ? e.amount : 0), 0)
      },
    memberById(): (id: string) => Member | undefined {
      return (id: string) => this.members.find((m) => m.id === id)
    },
    tripsSorted(state): Trip[] {
      return [...state.trips].sort((a, b) => b.createdAt - a.createdAt)
    },

    /** 有未推送改动的行程 id */
    dirtyTripIds(state): string[] {
      const ids = new Set<string>()
      for (const t of state.trips) {
        const local = state.sync.localAtOf[t.id] ?? 0
        const synced = state.sync.syncedAtOf[t.id] ?? 0
        if (local > synced) ids.add(t.id)
      }
      for (const tb of state.sync.tombstones) {
        if (tb.tripId) ids.add(tb.tripId)
      }
      return [...ids]
    },

    /** 同步状态给人看的文案 */
    syncStatusText(state): string {
      if (!SYNC_ENABLED) return '未开启'
      switch (state.sync.lastStatus) {
        case 'syncing':
          return '同步中…'
        case 'ok':
          return '已同步'
        case 'offline':
          return '离线，稍后自动重试'
        case 'error':
          return '同步失败'
        case 'disabled':
          return '未开启'
        default:
          return state.sync.lastSyncAt ? '已同步' : '尚未同步'
      }
    },

    /**
     * 实时通道给人看的文案。
     *
     * 与 `syncStatusText` 分开显示（界面上是两行）：它们是**两条独立通道**，
     * 实时断了不代表同步坏了 —— 改动照样会推上去，只是别人要等下一轮才看到。
     * 合成一句话会让「实时断了」看起来像「同步坏了」，用户会以为数据要丢。
     */
    realtimeStatusText(state): string {
      if (!REALTIME_ENABLED) return '实时未开启'
      switch (state.realtime.status) {
        case 'online':
          return '实时已连接'
        case 'connecting':
          return '实时连接中…'
        case 'offline':
          return state.realtime.lastError === 'unauthorized'
            ? '实时被拒（密钥或身份不对）'
            : '实时已断开，自动重连中'
        case 'stopped':
          return '实时已停止'
        default:
          return '实时未启动'
      }
    }
  },

  actions: {
    load() {
      const s = storageFor(this).read()
      this.trips = s.trips
      this.members = s.members
      this.days = s.days
      this.items = s.items
      this.expenses = s.expenses
      this.polls = s.polls
      this.votes = s.votes
      this.meetups = s.meetups
      this.locations = s.locations
      this.activeTripId = s.activeTripId
      if (!this.activeTripId && this.trips.length) {
        this.activeTripId = this.tripsSorted[0].id
      }
      this.sync = storageFor(this).readSync()
      // 同步元数据是刚读出来的，旧实例里的 HLC 状态作废，下次取用时重建
      hlcClocks.delete(this)
      // 令牌不需要在这里「推给网络层」：backend 实例的 token 回调每次请求现取
      // this.sync.identity（见 api()），登录 / 登出 / 换令牌后自动生效。
      // 实时状态不持久化（见 State 里 realtime 的说明），load 后回到「未启动」。
      // 若已有控制器在跑就不动它 —— load 只是「重读本地」，不该顺手掐掉一条活着的连接。
      if (!realtimes.has(this)) {
        this.realtime.status = 'idle'
        this.realtime.connId = ''
        this.realtime.lastError = ''
      }
      this.ready = true
    },
    /**
     * 写本地。
     * @param opts.sync 传 false 表示这次变更不参与云端同步（清空数据、导入时用）
     */
    persist(opts: { sync?: boolean } = {}) {
      storageFor(this).write({
        version: 1,
        trips: this.trips,
        members: this.members,
        days: this.days,
        items: this.items,
        expenses: this.expenses,
        polls: this.polls,
        votes: this.votes,
        meetups: this.meetups,
        locations: this.locations,
        activeTripId: this.activeTripId
      })
      storageFor(this).touch()
      if (opts.sync !== false) this.scheduleSync()
    },

    // ---------- 同步基础设施 ----------

    persistSync() {
      this.sync.tombstones = this.sync.tombstones.slice(-MAX_LOCAL_TOMBSTONES)
      storageFor(this).writeSync(this.sync)
    },

    /**
     * 取本机 HLC（首次调用时用持久化状态建，之后复用）。
     *
     * `save` 只回写到内存里的 `this.sync.hlc`，**不立刻落盘** —— 每次编辑都同步写一次
     * 同步元数据是没必要的开销。现有的每条写路径都会经 `commit()` / `pushTrip()` 等
     * 走到 `persistSync()`，那时一并落盘即可。
     */
    clock() {
      let c = hlcClocks.get(this)
      if (!c) {
        c = createHlc({
          state: (this.sync.hlc as HlcState | undefined) ?? null,
          maxSkewMs: CLOCK_MAX_SKEW_MS,
          save: (s: HlcState) => {
            this.sync.hlc = s
          }
        })
        hlcClocks.set(this, c)
      }
      return c
    },

    /**
     * 给记录打修改时间戳。**所有写路径都必须经过它或 `stampFields`。**
     *
     * 同时写三样东西，分工不同：
     *   · `updatedAt` —— **诚实的物理时间**，给人看、给本地排序用；
     *   · `hlc`       —— 记录级逻辑时间（= 各字段戳的最大值），用于跟删除墓碑比先后；
     *   · `fhlc`      —— **每个字段各自的时间戳**，云端逐字段比「谁更新」用的就是它。
     *
     * 只写 `updatedAt` 不写 `hlc` 是曾经的 bug：本地记录里还留着上一轮从云端
     * 带回来的陈旧 `hlc`，推送时服务端优先采信它，编辑被**静默丢弃**。
     *
     * @param fields 本次改动涉及的字段名。
     *   传了就只顶这些字段（**这才有字段级合并的价值**：只改预算不会连带把标题
     *   的时间戳一起顶高，别人刚改的标题不会被你手里的旧值盖掉）。
     *   不传 = 整条记录都算改动，适合新建 / 整体重写。
     */
    stampFields(
      recs: Array<RecordStampable | null | undefined>,
      fields?: string[]
    ): Hlc {
      const h = this.clock().stamp()
      const phys = Date.now()
      for (const r of recs) {
        if (!r) continue
        // 1) 先把字段戳映射**补全**：缺的字段用它当前的记录级戳兜底。
        //    「完整映射」是字段级合并的前提，见 src/services/lww.ts 的文件头。
        const base = recordHlc(r.hlc, r.updatedAt ?? phys)
        const next: Record<string, Hlc> = {}
        for (const k of dataKeysOf(r)) {
          const cur = r.fhlc?.[k]
          next[k] = cur && Number(cur.t) > 0 ? cur : base
        }
        // 2) 再顶掉本次真正改动的字段。
        //    记录上还没有这个键也照样先登记 —— 调用方「先赋值再 stamp」是惯例，
        //    但反过来（先 stamp 后赋值）也不该把这个戳丢掉。
        if (fields) {
          for (const f of fields) if (!MERGE_META_KEYS.has(f)) next[f] = { ...h }
        } else {
          for (const k of Object.keys(next)) next[k] = { ...h }
        }
        // 3) 丢掉记录上并不存在的键，免得 fhlc 里越积越多垃圾
        for (const k of Object.keys(next)) if (!(k in r)) delete next[k]
        Object.assign(r, withRecordHlc(r, next))
      }
      return h
    },

    /** `stamp` 的简写：整条记录都算改动 */
    stamp(...recs: Array<RecordStampable | null | undefined>): Hlc {
      return this.stampFields(recs)
    },

    /** 记一条删除墓碑：删除必须显式表达，否则会被离线设备的旧快照复活 */
    addTombstone(kind: SyncEntityKind, id: string, tripId?: string) {
      const h = this.clock().stamp()
      this.sync.tombstones = this.sync.tombstones.filter(
        (t) => !(t.kind === kind && t.id === id)
      )
      this.sync.tombstones.push({
        kind,
        id,
        deletedAt: Date.now(),
        hlc: { ...h },
        tripId
      })
      if (tripId) this.markLocalChange(tripId)
      this.persistSync()
    },

    /** 标记某个行程「本机有未推送的改动」 */
    markLocalChange(tripId: string) {
      // 只许前进：时钟回拨（NTP 纠偏）后若 localAtOf < syncedAtOf，行程会被
      // 判净、编辑静默不推 —— 脏标记取 max 抵御回拨；再保底压过上次推送戳
      // 一毫秒，堵住「推送成功后时钟才回拨」的残余窗口
      // （local == synced 会被判净，这次编辑就滞留本地永远推不出去了）
      const prev = this.sync.localAtOf[tripId] || 0
      this.sync.localAtOf[tripId] = Math.max(
        prev,
        Date.now(),
        (this.sync.syncedAtOf[tripId] || 0) + 1
      )
    },

    /**
     * 一次用户改动的收尾：补全字段戳 + 标记脏 + 写本地 + 安排推送。
     *
     * **所有会改动行程数据的 action 都必须以 commit 结尾，而不是 persist。**
     * 只改子记录（比如加一笔账单）时，Trip 记录本身的 updatedAt 不会变，
     * 若仍用旧逻辑判断「要不要推」，这笔账单就会永远留在本地推不上去。
     *
     * 这里额外走一遍 `ensureFieldStamps`：新建路径不少（建行程 / 加成员 / 加账单 /
     * 复制行程 / 导入），逐个去 `stamp` 迟早会漏一个 —— 而漏了的记录会因为没有
     * 字段戳而退回记录级语义，正是字段级合并要避免的。放在这个唯一收口处补全，
     * 新增写路径就不用再记得这件事。
     */
    commit(tripId: string) {
      this.ensureFieldStamps(tripId)
      this.markLocalChange(tripId)
      this.persist()
      // 同步元数据（localAtOf / hlc / 墓碑）必须与业务数据同批落盘：
      // 只写业务数据的话，去抖窗口内进程被杀会丢「有未推送改动」的标记，
      // 该行程从此判净、编辑永不推送；hlc 断档还会让新戳落后于已推送的戳。
      this.persistSync()
    },

    /**
     * 给某行程下所有记录补全 `fhlc`（只补，不顶时间戳）。
     *
     * 用「记录级戳」给缺失字段兜底是安全的：新建记录的各字段本来就诞生于同一时刻。
     * 已经有字段戳的字段一律不动 —— 那是别人改过的痕迹，顶掉就等于篡改历史。
     */
    ensureFieldStamps(tripId: string) {
      const recs: RecordStampable[] = [
        ...this.trips.filter((t) => t.id === tripId),
        ...this.members.filter((r) => r.tripId === tripId),
        ...this.days.filter((r) => r.tripId === tripId),
        ...this.items.filter((r) => r.tripId === tripId),
        ...this.expenses.filter((r) => r.tripId === tripId),
        ...this.polls.filter((r) => r.tripId === tripId),
        ...this.votes.filter((r) => r.tripId === tripId),
        ...this.meetups.filter((r) => r.tripId === tripId),
        ...this.locations.filter((r) => r.tripId === tripId)
      ]
      for (const r of recs) {
        const keys = dataKeysOf(r)
        if (!keys.length) continue
        const missing = keys.some((k) => !r.fhlc?.[k])
        if (!missing) continue
        const base = recordHlc(r.hlc, r.updatedAt ?? Date.now())
        const next: Record<string, Hlc> = {}
        for (const k of keys) {
          const cur = r.fhlc?.[k]
          next[k] = cur && Number(cur.t) > 0 ? cur : base
        }
        Object.assign(r, withRecordHlc(r, next))
      }
    },

    /** 本地改动后延迟推送，避免连续编辑把请求打得太密 */
    scheduleSync() {
      if (!SYNC_ENABLED) return
      // 顺带把「本机有哪些行程」同步给实时通道：本地新建 / 删除行程会走到这里，
      // 而订阅集合必须跟着变。集合没变时 setSpaces 是空操作。
      this.syncRealtimeSpaces()
      const prev = syncTimers.get(this)
      if (prev) clearTimeout(prev)
      syncTimers.set(
        this,
        setTimeout(() => {
          syncTimers.delete(this)
          void this.syncAll()
        }, SYNC_DEBOUNCE_MS)
      )
    },

    setActiveTrip(id: string) {
      this.activeTripId = id
      this.persist()
    },

    // ---------- 行程 ----------

    createTrip(input: {
      title: string
      destination: string
      startDate: string
      endDate: string
      budget: number
      memberNames: string[]
    }): Trip {
      const tripId = uid('trip')
      const start = input.startDate || todayISO()
      const end = input.endDate || addDays(start, 1)

      const trip: Trip = {
        id: tripId,
        title: input.title || `${input.destination}之行`,
        destination: input.destination,
        startDate: start,
        endDate: end,
        currency: '¥',
        budget: input.budget || 0,
        memberIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }

      const names = input.memberNames.filter((n) => n.trim())
      const finalNames = names.length ? names : ['我']
      const members: Member[] = finalNames.map((name, idx) => ({
        id: uid('mem'),
        tripId,
        name: name.trim(),
        colorIndex: idx,
        weight: 1,
        isSelf: idx === 0,
        updatedAt: Date.now()
      }))

      trip.memberIds = members.map((m) => m.id)

      const dayCount = daysBetween(start, end)
      const days: Day[] = Array.from({ length: dayCount }, (_, i) => ({
        id: uid('day'),
        tripId,
        date: addDays(start, i),
        index: i,
        title: `第 ${i + 1} 天`,
        note: '',
        updatedAt: Date.now()
      }))

      this.trips.push(trip)
      this.members.push(...members)
      this.days.push(...days)
      this.activeTripId = tripId
      this.commit(tripId)
      return trip
    },

    updateTrip(id: string, patch: Partial<Trip>) {
      const t = this.trips.find((x) => x.id === id)
      if (!t) return
      Object.assign(t, patch)
      // 只顶 patch 里那几个字段：这次改动没碰到的字段保持原有时间戳，
      // 别人刚改的那些字段就不会被本机手里的旧值盖掉。
      this.stampFields([t], Object.keys(patch))
      // 日期变化时同步天数
      if (patch.startDate || patch.endDate) {
        this.syncDays(id)
      }
      this.commit(id)
    },

    /** 让天数与起止日期保持一致，已有天保留内容 */
    syncDays(tripId: string) {
      const trip = this.trips.find((t) => t.id === tripId)
      if (!trip) return
      const want = daysBetween(trip.startDate, trip.endDate)
      const existing = this.days
        .filter((d) => d.tripId === tripId)
        .sort((a, b) => a.index - b.index)

      if (existing.length < want) {
        for (let i = existing.length; i < want; i += 1) {
          this.days.push({
            id: uid('day'),
            tripId,
            date: addDays(trip.startDate, i),
            index: i,
            title: `第 ${i + 1} 天`,
            note: '',
            updatedAt: Date.now()
          })
        }
      } else if (existing.length > want) {
        const removed = existing.slice(want)
        const removedIds = new Set(removed.map((d) => d.id))
        this.days = this.days.filter((d) => !removedIds.has(d.id))
        this.items = this.items.filter((i) => !removedIds.has(i.dayId))
        // 被裁掉的天与其中的行程项都要留墓碑，否则同步时会被别的设备推回来
        for (const d of removed) this.addTombstone('day', d.id, tripId)
      }

      // 重排日期与编号
      this.days
        .filter((d) => d.tripId === tripId)
        .sort((a, b) => a.index - b.index)
        .forEach((d, i) => {
          d.index = i
          d.date = addDays(trip.startDate, i)
          if (!d.title || /^第 \d+ 天$/.test(d.title)) d.title = `第 ${i + 1} 天`
        })
      // 重排只动了日期 / 序号 / 自动标题；note 等用户内容没碰，别顶它的戳
      this.stampFields(this.days.filter((d) => d.tripId === tripId), [
        'index',
        'date',
        'title'
      ])
    },

    /**
     * 只清本地副本：不记墓碑、不 commit —— 行程本身仍完整存在于服务端，
     * 这不是一次「删除」同步事件，只是本机不再持有它（与 removeTrip 的区别就在墓碑）。
     */
    dropLocalCopy(id: string) {
      this.trips = this.trips.filter((t) => t.id !== id)
      const dayIds = new Set(this.days.filter((d) => d.tripId === id).map((d) => d.id))
      this.days = this.days.filter((d) => d.tripId !== id)
      this.items = this.items.filter((i) => i.tripId !== id && !dayIds.has(i.dayId))
      this.members = this.members.filter((m) => m.tripId !== id)
      this.expenses = this.expenses.filter((e) => e.tripId !== id)
      this.polls = this.polls.filter((p) => p.tripId !== id)
      this.votes = this.votes.filter((v) => v.tripId !== id)
      this.meetups = this.meetups.filter((m) => m.tripId !== id)
      this.locations = this.locations.filter((l) => l.tripId !== id)
      if (this.activeTripId === id) {
        this.activeTripId = this.tripsSorted[0]?.id || null
      }
      delete this.sync.revOf[id]
      delete this.sync.syncedAtOf[id]
      delete this.sync.localAtOf[id]
      delete this.sync.codes[id]
    },

    removeTrip(id: string) {
      this.dropLocalCopy(id)
      // 只给行程本身留墓碑：子记录随空间一起被隐藏，
      // 而「删行程后又有人改」时以改为准（记录时间更新于墓碑），语义才自然。
      this.addTombstone('trip', id, id)
      this.commit(id)
    },

    // ---------- 成员 ----------

    addMember(tripId: string, name: string): Member {
      const m: Member = {
        id: uid('mem'),
        tripId,
        name: name.trim() || `成员${this.members.filter((x) => x.tripId === tripId).length + 1}`,
        colorIndex: this.members.filter((x) => x.tripId === tripId).length,
        weight: 1,
        isSelf: false,
        updatedAt: Date.now()
      }
      this.members.push(m)
      const t = this.trips.find((x) => x.id === tripId)
      if (t) {
        t.memberIds.push(m.id)
        this.stampFields([t], ['memberIds'])
      }
      this.commit(tripId)
      return m
    },

    updateMember(id: string, patch: Partial<Member>) {
      const m = this.members.find((x) => x.id === id)
      if (!m) return
      Object.assign(m, patch)
      this.stampFields([m], Object.keys(patch))
      this.commit(m.tripId)
    },

    /**
     * 批量把「我」标记到某个成员上（其余成员的 isSelf 一并清掉）。
     *
     * 与逐个 updateMember 的区别：一次 commit / 一次持久化 —— 成员页每切一次
     * 「标记为我」就是 N 次 assign + N 次字段戳 + N 次全量写盘的写放大，
     * 收口成一个 action 后只在末尾落一次盘。
     */
    setSelfMember(tripId: string, memberId: string) {
      const targets = this.members.filter((m) => m.tripId === tripId)
      const touched = targets.filter((m) => (m.id === memberId) !== !!m.isSelf)
      if (!touched.length) return
      for (const m of touched) m.isSelf = m.id === memberId
      this.stampFields(touched, ['isSelf'])
      this.commit(tripId)
    },

    removeMember(id: string) {
      const m = this.members.find((x) => x.id === id)
      if (!m) return
      const tripId = m.tripId
      this.members = this.members.filter((x) => x.id !== id)
      const t = this.trips.find((x) => x.id === tripId)
      if (t) {
        t.memberIds = t.memberIds.filter((x) => x !== id)
        this.stampFields([t], ['memberIds'])
      }
      // 该成员参与的账单需要剔除或转移
      const touched: Expense[] = []
      this.expenses = this.expenses.map((e) => {
        if (e.tripId !== tripId) return e
        let next = e
        if (e.payerId === id) {
          const other = this.members.find((x) => x.tripId === tripId)
          if (other) next = { ...next, payerId: other.id }
        }
        const parts = next.participants.filter((p) => p.memberId !== id)
        const merged = {
          ...next,
          participants: parts.length
            ? parts
            : // 唯一参与人刚被删：回退为剩余成员均摊 —— 留下含已删 id 的
              // 参与人会在结算时被静默丢弃，净额不守恒、转账算错
              this.members
                .filter((m) => m.tripId === tripId)
                .map((m) => ({ memberId: m.id, share: 1 }))
        }
        touched.push(merged)
        return merged
      })
      // 被牵连的账单只改了付款人 / 参与人，其余字段（金额、备注…）不该跟着变旧
      this.stampFields(touched, ['payerId', 'participants'])
      this.addTombstone('member', id, tripId)
      this.commit(tripId)
    },

    // ---------- 投票 ----------

    /**
     * 发起一次投票：候选由发起人手动列出（日期 = 若干 'YYYY-MM-DD'，目的地 = 城市名）。
     * 重复标签、空白标签会被过滤；全部非法则返回 null。
     */
    createPoll(input: {
      tripId: string
      kind: PollKind
      title?: string
      options: string[]
    }): string | null {
      const trip = this.trips.find((t) => t.id === input.tripId)
      if (!trip) return null
      const seen = new Set<string>()
      const labels: string[] = []
      for (const label of input.options) {
        const clean = (label || '').trim()
        if (!clean || seen.has(clean)) continue
        seen.add(clean)
        labels.push(clean)
      }
      if (!labels.length) return null
      const poll: Poll = {
        id: uid('poll'),
        tripId: input.tripId,
        kind: input.kind,
        title: (input.title || '').trim() || (input.kind === 'date' ? '哪天出发？' : '去哪儿？'),
        options: labels.map((label) => ({ id: uid('opt'), label })),
        status: 'open',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      this.polls.push(poll)
      this.stamp(poll)
      this.commit(input.tripId)
      return poll.id
    },

    /**
     * 投票 / 改票：每成员每投票一票（Vote.id = `${pollId}_${memberId}`），改票覆盖自己的旧票。
     * id 用下划线拼接是因为服务端 isSafeId 的字符集是 `[A-Za-z0-9_-]`，冒号会整条被拒。
     */
    castVote(pollId: string, memberId: string, optionId: string) {
      const poll = this.polls.find((p) => p.id === pollId)
      if (!poll || poll.status !== 'open') return
      if (!poll.options.some((o) => o.id === optionId)) return
      const tripId = poll.tripId
      const vote = this.votes.find((v) => v.pollId === pollId && v.memberId === memberId)
      if (vote) {
        if (vote.optionId === optionId) return
        vote.optionId = optionId
        this.stampFields([vote], ['optionId'])
      } else {
        const v: Vote = {
          id: `${pollId}_${memberId}`,
          tripId,
          pollId,
          memberId,
          optionId,
          updatedAt: Date.now()
        }
        this.stamp(v)
        this.votes.push(v)
      }
      this.commit(tripId)
    },

    /** 结束投票：定格胜者（无票时不动 result，留着等应用按钮） */
    closePoll(pollId: string) {
      const poll = this.polls.find((p) => p.id === pollId)
      if (!poll || poll.status === 'closed') return
      const t = this.tallyOf(pollId)
      poll.status = 'closed'
      if (t?.winner && !poll.result) poll.result = t.winner.option.id
      this.stampFields([poll], ['status', ...(poll.result ? ['result'] : [])])
      this.commit(poll.tripId)
    },

    /**
     * 把已结束投票的结果应用到行程：
     *   · date 投票：候选日期写入 startDate，endDate 按行程原天数顺延；
     *   · destination 投票：候选城市写入 destination。
     * 仅投票 closed 且已有采纳结果时可应用。
     */
    applyPollResult(pollId: string) {
      const poll = this.polls.find((p) => p.id === pollId)
      if (!poll || poll.status !== 'closed' || !poll.result) return
      const trip = this.trips.find((t) => t.id === poll.tripId)
      const option = poll.options.find((o) => o.id === poll.result)
      if (!trip || !option) return
      if (poll.kind === 'destination') {
        trip.destination = option.label
        this.stampFields([trip], ['destination'])
      } else {
        const days = daysBetween(trip.startDate, trip.endDate)
        trip.startDate = option.label
        trip.endDate = addDays(option.label, days - 1)
        this.stampFields([trip], ['startDate', 'endDate'])
      }
      this.commit(poll.tripId)
    },

    /** 删除投票：连带它的票一起删（各自墓碑，防止离线旧快照复活） */
    removePoll(pollId: string) {
      const poll = this.polls.find((p) => p.id === pollId)
      if (!poll) return
      const tripId = poll.tripId
      for (const v of this.votes.filter((x) => x.pollId === pollId)) {
        this.addTombstone('vote', v.id, tripId)
      }
      this.votes = this.votes.filter((x) => x.pollId !== pollId)
      this.addTombstone('poll', pollId, tripId)
      this.polls = this.polls.filter((p) => p.id !== pollId)
      this.commit(tripId)
    },

    // ---------- 集合点 / 共享位置 ----------

    /** 定/改集合点（每行程至多一条，id = `meetup_<tripId>`；改就是更新它） */
    setMeetup(
      tripId: string,
      input: { title: string; address: string; lat: number; lng: number }
    ) {
      const trip = this.trips.find((t) => t.id === tripId)
      if (!trip) return false
      const cur = this.meetups.find((m) => m.tripId === tripId)
      if (cur) {
        cur.title = (input.title || '').trim() || '集合点'
        cur.address = (input.address || '').trim()
        cur.lat = input.lat
        cur.lng = input.lng
        this.stampFields([cur], ['title', 'address', 'lat', 'lng'])
      } else {
        const m: Meetup = {
          id: `meetup_${tripId}`,
          tripId,
          title: (input.title || '').trim() || '集合点',
          address: (input.address || '').trim(),
          lat: input.lat,
          lng: input.lng,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        this.stamp(m)
        this.meetups.push(m)
      }
      this.commit(tripId)
      return true
    },

    /** 清除集合点（墓碑；离线成员下次同步后也看不到它） */
    removeMeetup(tripId: string) {
      const cur = this.meetups.find((m) => m.tripId === tripId)
      if (!cur) return
      this.addTombstone('meetup', cur.id, tripId)
      this.meetups = this.meetups.filter((m) => m.tripId !== tripId)
      this.commit(tripId)
    },

    /**
     * 上报本机位置（共享位置）：我自己在行程里的一条 `location` 记录，
     * id = `loc_<memberId>`，更新即覆盖旧坐标，两个成员同时上报互不覆盖。
     * 记录不存在时先创建（= 开启共享）。UI 层的定时器只负责周期性地调它。
     */
    updateLocation(tripId: string, lat: number, lng: number, accuracy = 0) {
      const self = this.members.find((m) => m.isSelf && m.tripId === tripId)
      if (!self) return false
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
      const cur = this.locations.find((l) => l.tripId === tripId && l.memberId === self.id)
      if (cur) {
        cur.lat = lat
        cur.lng = lng
        cur.accuracy = accuracy
        this.stampFields([cur], ['lat', 'lng', 'accuracy'])
      } else {
        const l: LocationShare = {
          id: `loc_${self.id}`,
          tripId,
          memberId: self.id,
          lat,
          lng,
          accuracy,
          updatedAt: Date.now()
        }
        this.stamp(l)
        this.locations.push(l)
      }
      this.commit(tripId)
      return true
    },

    /** 停止共享位置（删掉我的位置记录，墓碑同步；别人地图上不再显示我） */
    stopSharing(tripId: string) {
      const self = this.members.find((m) => m.isSelf && m.tripId === tripId)
      const cur = self && this.locations.find((l) => l.tripId === tripId && l.memberId === self.id)
      if (!cur) return
      this.addTombstone('location', cur.id, tripId)
      this.locations = this.locations.filter((l) => l.id !== cur.id)
      this.commit(tripId)
    },

    avatarOf(memberId: string): string {
      const m = this.members.find((x) => x.id === memberId)
      return avatarColor(m?.colorIndex ?? 0)
    },

    // ---------- 行程项 ----------

    generate(tripId: string, input: GenerateInput): string {
      const trip = this.trips.find((t) => t.id === tripId)
      if (!trip) return ''
      return this.applyGenerate(
        tripId,
        input,
        generateItinerary(input)
      )
    },

    /**
     * 异步生成：本地 6 城未命中时先拉高德在线库，抓不到则抛错（页面层展示重试提示，
     * 不做静默回退 —— 旧版会兜底成成都的行程）。
     * 页面层统一走这个。
     */
    async generateAsync(
      tripId: string,
      input: GenerateInput,
      onStage?: GenStageSink,
      opts?: {
        weather?: Map<string, WeatherDay> | Promise<Map<string, WeatherDay> | undefined>
        /** 口味画像（utils/taste，从足迹推断），样本 ≥2 才生效 */
        taste?: Taste
        /**
         * 同目的地已打卡 POI 名（重访降权）。缺省自动从历史行程收——
         * 同目的地行程里 done/verified 过的项名；白给一个 [] 则完全关闭。
         */
        revisit?: string[]
      }
    ): Promise<string> {
      const trip = this.trips.find((t) => t.id === tripId)
      if (!trip) return ''
      const revisit = opts?.revisit ?? this.revisitNamesFor(input.destination)
      const out = await generateItineraryAsync(input, onStage, { ...opts, revisit })
      return this.applyGenerate(tripId, input, out)
    },

    /**
     * 同目的地历史行程里用户已打卡/已核实过的项名 —— 重访降权信号
     * （「这次换个新鲜点」）。generateAsync 在清旧行程项**之前**调用，
     * 所以同一行程重排再生成时，上次的打卡也计入。
     */
    revisitNamesFor(destination: string): string[] {
      const dest = destination.trim()
      if (!dest) return []
      const names: string[] = []
      for (const t of this.trips) {
        if (t.destination !== dest) continue
        for (const it of this.items) {
          if (it.tripId !== t.id) continue
          if (!it.done && !it.verifiedAt) continue
          if (it.title && !names.includes(it.title)) names.push(it.title)
        }
      }
      return names
    },

    /** 把生成结果写进行程空间（清旧 -> 写新 -> 戳字段 -> commit） */
    applyGenerate(tripId: string, input: GenerateInput, out: GenerateOutput): string {
      const trip = this.trips.find((t) => t.id === tripId)
      if (!trip) return ''

      // 清掉旧的行程项与天，重新生成（旧记录留墓碑，避免同步时被别的设备推回来）
      for (const d of this.days.filter((d) => d.tripId === tripId)) {
        this.addTombstone('day', d.id, tripId)
      }
      for (const i of this.items.filter((i) => i.tripId === tripId)) {
        this.addTombstone('item', i.id, tripId)
      }
      this.items = this.items.filter((i) => i.tripId !== tripId)
      this.days = this.days.filter((d) => d.tripId !== tripId)

      out.days.forEach((d) => {
        d.tripId = tripId
        this.days.push(d)
      })
      out.items.forEach((i) => {
        i.tripId = tripId
        this.items.push(i)
      })

      trip.destination = input.destination || trip.destination
      trip.startDate = input.startDate
      trip.endDate = input.endDate
      this.stampFields([trip], ['destination', 'startDate', 'endDate'])
      // 行程重排后行李清单跟着重造（内部自带 stamp + commit）
      this.buildPacking(tripId)
      this.stamp(...out.days, ...out.items)
      this.commit(tripId)
      return out.summary
    },

    addItem(dayId: string, item: Partial<ItineraryItem>) {
      const day = this.days.find((d) => d.id === dayId)
      if (!day) return
      const siblings = this.items.filter((i) => i.dayId === dayId)
      const next: ItineraryItem = {
        id: uid('item'),
        dayId,
        tripId: day.tripId,
        order: siblings.length,
        time: item.time || '10:00',
        type: item.type || 'spot',
        title: item.title || '新安排',
        address: item.address || '',
        lat: item.lat || 0,
        lng: item.lng || 0,
        cost: item.cost || 0,
        duration: item.duration || 90,
        note: item.note || '',
        done: false,
        updatedAt: Date.now()
      }
      this.items.push(next)
      this.commit(day.tripId)
    },

    updateItem(id: string, patch: Partial<ItineraryItem>) {
      const item = this.items.find((i) => i.id === id)
      if (!item) return
      Object.assign(item, patch)
      this.stampFields([item], Object.keys(patch))
      this.commit(item.tripId)
    },

    removeItem(id: string) {
      const item = this.items.find((i) => i.id === id)
      if (!item) return
      const { dayId, tripId } = item
      this.items = this.items.filter((i) => i.id !== id)
      this.reorder(dayId)
      this.addTombstone('item', id, tripId)
      this.commit(tripId)
    },

    /** 把某个点在同一天内上移/下移 */
    moveItem(id: string, dir: -1 | 1) {
      const item = this.items.find((i) => i.id === id)
      if (!item) return
      const list = this.items
        .filter((i) => i.dayId === item.dayId)
        .sort((a, b) => a.order - b.order)
      const idx = list.findIndex((i) => i.id === id)
      const target = idx + dir
      if (target < 0 || target >= list.length) return
      const tmp = list[idx]
      list[idx] = list[target]
      list[target] = tmp
      list.forEach((it, i) => {
        it.order = i
      })
      this.stampFields(list, ['order'])
      this.commit(item.tripId)
    },

    reorder(dayId: string) {
      const list = this.items
        .filter((i) => i.dayId === dayId)
        .sort((a, b) => a.order - b.order)
      list.forEach((it, i) => {
        it.order = i
      })
      this.stampFields(list, ['order'])
    },

    /** 用前一项的结束时间重排当天时间轴 */
    rescheduleDay(dayId: string, startTime = '09:00') {
      const list = this.items
        .filter((i) => i.dayId === dayId)
        .sort((a, b) => a.order - b.order)
      let cursor = startTime
      list.forEach((it) => {
        it.time = cursor
        const [h, m] = cursor.split(':').map(Number)
        const total = h * 60 + m + (it.duration || 90) + 30
        cursor = `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
      })
      this.stampFields(list, ['time'])
      const anyItem = list[0]
      if (anyItem) this.commit(anyItem.tripId)
    },

    updateDay(dayId: string, patch: Partial<Day>) {
      const d = this.days.find((x) => x.id === dayId)
      if (!d) return
      Object.assign(d, patch)
      this.stampFields([d], Object.keys(patch))
      this.commit(d.tripId)
    },

    // ---------- 行李清单 ----------
    //
    // 挂在 trip.packing 这个**单个字段**上整块合并，不建独立实体 ——
    // 清单不是高频并发编辑对象，一件一件踩 LWW 的成本不划算。

    /**
     * 按当前行程信息生成/重造清单。触发点：
     *   · applyGenerate（生成行程收尾自动建）；
     *   · 行程页「重新生成」按钮（手动建,适合没走过生成的本地行程）。
     */
    buildPacking(tripId: string) {
      const trip = this.trips.find((t) => t.id === tripId)
      if (!trip) return
      const dayCount = this.days.filter((d) => d.tripId === tripId).length
      // 没排过日程的行程（手建后直接不生成了）：按起止日期差数天数
      let days = dayCount
      if (!days) {
        const span = Date.parse(trip.endDate) - Date.parse(trip.startDate)
        days = Number.isFinite(span) ? Math.round(span / 86_400_000) + 1 : 1
      }
      const items = this.items.filter((i) => i.tripId === tripId)
      trip.packing = {
        builtAt: Date.now(),
        items: buildPackingList({
          destination: trip.destination,
          days,
          startDate: trip.startDate,
          hasStay: items.some((i) => i.type === 'stay'),
          hasTransit: items.some((i) => i.type === 'transport')
        })
      }
      this.stampFields([trip], ['packing'])
      this.commit(tripId)
    },

    togglePacking(tripId: string, index: number) {
      const trip = this.trips.find((t) => t.id === tripId)
      const p = trip?.packing
      if (!trip || !p || !p.items[index]) return
      p.items = p.items.map((x, i) => (i === index ? { ...x, done: !x.done } : x))
      this.stampFields([trip], ['packing'])
      this.commit(tripId)
    },

    addPackingItem(tripId: string, title: string) {
      const trip = this.trips.find((t) => t.id === tripId)
      if (!trip || !title.trim()) return
      // 最多 40 项 —— 与服务端裁剪孪生一致，超限就不再加（顶多少记一件）
      if ((trip.packing?.items.length || 0) >= 40) return
      trip.packing = {
        builtAt: trip.packing?.builtAt || Date.now(),
        items: [
          ...(trip.packing?.items || []),
          { title: title.trim().slice(0, 24), group: 'misc', done: false }
        ]
      }
      this.stampFields([trip], ['packing'])
      this.commit(tripId)
    },

    removePackingItem(tripId: string, index: number) {
      const trip = this.trips.find((t) => t.id === tripId)
      const p = trip?.packing
      if (!trip || !p || !p.items[index]) return
      trip.packing = { builtAt: p.builtAt, items: p.items.filter((_, i) => i !== index) }
      if (!trip.packing.items.length) delete trip.packing // 清空即整个字段摘掉
      this.stampFields([trip], ['packing'])
      this.commit(tripId)
    },

    // ---------- 避雷清单 ----------
    //
    // 与行李清单同为「单字段整块 LWW」：avoid?: AvoidItem[]（裸数组，无外壳）。
    // 没有勾选语义 —— 雷不是待办，记下就是结论；没有自动生成 —— 坑是这座城
    // 具体大小、哪些口子会咬人，规则表不可能知道，只有走过的人知道。

    /** 署名取添加当时的成员名（成员改名不改历史署名，像账单的 payer 一样） */
    addAvoid(tripId: string, title: string) {
      const trip = this.trips.find((t) => t.id === tripId)
      if (!trip || !title.trim()) return
      // 上限 40 与服务端裁剪孪生一致；超限就不加了
      if ((trip.avoid?.length || 0) >= 40) return
      const self = this.membersOf(tripId).find((m) => m.isSelf)
      trip.avoid = [
        ...(trip.avoid || []),
        { title: title.trim().slice(0, 40), who: self?.name || '' }
      ]
      this.stampFields([trip], ['avoid'])
      this.commit(tripId)
    },

    removeAvoid(tripId: string, index: number) {
      const trip = this.trips.find((t) => t.id === tripId)
      if (!trip || !trip.avoid?.[index]) return
      trip.avoid = trip.avoid.filter((_, i) => i !== index)
      if (!trip.avoid.length) delete trip.avoid // 清空即整个字段摘掉
      this.stampFields([trip], ['avoid'])
      this.commit(tripId)
    },

    // ---------- 记账 ----------

    addExpense(input: Omit<Expense, 'id' | 'createdAt'>): Expense {
      const now = Date.now()
      const e: Expense = {
        ...input,
        id: uid('exp'),
        createdAt: now,
        updatedAt: now
      }
      this.expenses.push(e)
      this.commit(input.tripId)
      return e
    },

    updateExpense(id: string, patch: Partial<Expense>) {
      const e = this.expenses.find((x) => x.id === id)
      if (!e) return
      Object.assign(e, patch)
      this.stampFields([e], Object.keys(patch))
      this.commit(e.tripId)
    },

    removeExpense(id: string) {
      const e = this.expenses.find((x) => x.id === id)
      if (!e) return
      this.expenses = this.expenses.filter((x) => x.id !== id)
      this.addTombstone('expense', id, e.tripId)
      this.commit(e.tripId)
    },

    markSettled(tripId: string, settled: boolean) {
      const t = this.trips.find((x) => x.id === tripId)
      if (!t) return
      t.settledAt = settled ? Date.now() : undefined
      this.stampFields([t], ['settledAt'])
      this.commit(tripId)
    },

    // ---------- 结算 ----------

    settlementOf(tripId: string): SettlementResult {
      const members = this.members.filter((m) => m.tripId === tripId)
      const expenses = this.expenses.filter((e) => e.tripId === tripId)
      return runSettle(members, expenses)
    },

    // ---------- 导入导出 ----------

    exportTrip(tripId: string): string {
      const trip = this.trips.find((t) => t.id === tripId)
      if (!trip) return ''
      const payload = {
        app: 'travel-h5',
        version: 1,
        exportedAt: new Date().toISOString(),
        trip,
        members: this.members.filter((m) => m.tripId === tripId),
        days: this.days.filter((d) => d.tripId === tripId),
        items: this.items.filter((i) => i.tripId === tripId),
        expenses: this.expenses.filter((e) => e.tripId === tripId)
      }
      return JSON.stringify(payload, null, 2)
    },

    importTrip(json: string): { ok: boolean; message: string } {
      try {
        const data = JSON.parse(json)
        if (!data || !data.trip) return { ok: false, message: '文件格式不对，缺少行程数据' }

        const idMap = new Map<string, string>()
        const newTripId = uid('trip')
        idMap.set(data.trip.id, newTripId)

        const trip: Trip = {
          ...data.trip,
          id: newTripId,
          title: `${data.trip.title}（导入）`,
          memberIds: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          settledAt: undefined
        }

        const members: Member[] = (data.members || []).map((m: Member) => {
          const nid = uid('mem')
          idMap.set(m.id, nid)
          return { ...m, id: nid, tripId: newTripId, updatedAt: Date.now() }
        })
        trip.memberIds = members.map((m) => m.id)

        const days: Day[] = (data.days || []).map((d: Day) => {
          const nid = uid('day')
          idMap.set(d.id, nid)
          return { ...d, id: nid, tripId: newTripId, updatedAt: Date.now() }
        })

        const items: ItineraryItem[] = (data.items || []).map((i: ItineraryItem) => ({
          ...i,
          id: uid('item'),
          tripId: newTripId,
          dayId: idMap.get(i.dayId) || i.dayId,
          updatedAt: Date.now()
        }))

        const expenses: Expense[] = (data.expenses || []).map((e: Expense) => ({
          ...e,
          id: uid('exp'),
          tripId: newTripId,
          payerId: idMap.get(e.payerId) || e.payerId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          participants: (e.participants || []).map((p) => ({
            ...p,
            memberId: idMap.get(p.memberId) || p.memberId
          }))
        }))

        this.trips.push(trip)
        this.members.push(...members)
        this.days.push(...days)
        this.items.push(...items)
        this.expenses.push(...expenses)
        this.activeTripId = newTripId
        this.commit(newTripId)
        return { ok: true, message: `已导入「${trip.title}」` }
      } catch (e) {
        return { ok: false, message: '解析失败，请确认是导出的 JSON 文件' }
      }
    },

    resetAll() {
      // 清空本地 ≠ 删除云端：这里只是把本机数据抹掉，
      // 所以 persist 时不触发同步（否则会把空快照推上去）。
      storageFor(this).clear()
      this.trips = []
      this.members = []
      this.days = []
      this.items = []
      this.expenses = []
      this.polls = []
      this.votes = []
      this.meetups = []
      this.locations = []
      this.activeTripId = null
      this.sync = {
        ...emptySyncMeta(),
        deviceId: this.sync.deviceId,
        author: this.sync.author,
        // hlc 必须保留：重置后到下次全量拉取前的编辑仍靠 HLC 定序，
        // 从零起步会拿到更小的戳，推上去被判旧丢弃
        hlc: this.sync.hlc
      }
      this.persistSync()
      this.persist({ sync: false })
    },

    // ---------- 云端同步 ----------

    /**
     * 保证本机有设备标识（`deviceId`）。
     *
     * ⚠️ 这**不是**「身份」。`deviceId` 只是这台设备的审计标记，
     * 服务端拿它分辨「同一批改动是不是同一台设备推的」，不做任何授权判定。
     * 真正决定「你是谁、你能改哪个行程」的是 `sync.identity`（见 login / logout）。
     * 早先这个方法叫 ensureIdentity，接账号体系后改名，免得两件事被混为一谈。
     */
    ensureDeviceId() {
      if (!this.sync.deviceId) {
        this.sync.deviceId = uid('dev')
        this.persistSync()
      }
    },

    // ---------- 账号身份（微信 openid） ----------

    /**
     * 本实例的 backend 客户端（懒创建，WeakMap 缓存）。
     *
     * 令牌用**回调**而不是传值：登录 / 登出 / 续期都会改变它，
     * 回调让每次请求都拿到当前生效的那份 —— 与 realtimeController 的 token 同一模式。
     */
    api(): BackendClient {
      let b = backends.get(this)
      if (!b) {
        b = createBackend({
          token: () => (identityValid(this.sync.identity) ? String(this.sync.identity?.token || '') : '')
        })
        backends.set(this, b)
      }
      return b
    },

    /** 是否已登录且令牌未临期 */
    isLoggedIn(): boolean {
      return identityValid(this.sync.identity)
    },

    /**
     * 微信登录。失败时抛错，由界面提示（不要在这里静默降级 ——
     * 「后端没配 AppID」这类问题必须让人看见，否则表现为「点了没反应」）。
     */
    async login(): Promise<void> {
      const id = await loginWithWechat(this.api())
      this.sync.identity = id
      this.persistSync()
      // 足迹的本地数据同样要按新身份重划：认领匿名的（本机未登录时标的）、
      // 清掉别人的（上个账号留下的副本）。fire-and-forget：足迹同步失败
      // 不影响登录流程本身（onIdentityChanged 内部自吞错误）。
      void useCityStore().onIdentityChanged()
      // 身份变了，可见范围随之变化：重拉一次，并清掉「来自服务端（有 revOf）、
      // 但新身份下已不可见」的本地副本 —— 典型是未登录时被并进来的别人行程，
      // 留着它 TripViewPage 会按「本地有 → 可编辑」误判出越权入口；也覆盖
      // 「被移出成员」的场景。只清有 revOf 的：纯离线创建的本地行程绝不能动。
      // 拉取失败（离线）时跳过清理 —— 不能按不完整的数据删，下次同步再清。
      try {
        await this.pullAll()
        const visible = new Set((await this.api().listSpaces(false)).spaces.map((s) => s.id))
        let pruned = false
        for (const t of [...this.trips]) {
          if (this.sync.revOf[t.id] && !visible.has(t.id)) {
            this.dropLocalCopy(t.id)
            pruned = true
          }
        }
        if (pruned) this.persist({ sync: false })
      } catch {
        /* 离线：本次不清 */
      }
      // 令牌变了 → 已建立的实时连接仍然带着旧身份（之前可能是匿名的），必须重握手
      this.restartRealtime()
    },

    /**
     * 登出。
     *
     * 令牌是无状态的，服务端没有会话表要清 —— 这里只需要**在本地把它删掉**。
     * 代价是：删掉的那份在过期前仍然有效（谁截获了它就能继续用）。
     * 要立刻全量失效只能轮换服务端 SESSION_SECRET，属于部署动作，不是用户动作。
     */
    logout() {
      this.sync.identity = null
      this.persistSync()
      // 登出后能看到的范围变小了：旧连接还带着「已登录」的身份，
      // 不重握手就会继续收到「有主空间」的推送（而本机已经没有权限读它了）
      this.restartRealtime()
    },

    /**
     * 认领无归属的行程（接账号体系之前创建的）。
     * 需要该行程的分享码 —— 它是旧权限模型下的访问凭证。
     */
    async claimTrip(tripId: string, code: string): Promise<void> {
      await this.api().claimSpace(tripId, code.trim().toUpperCase())
      await this.pullAll()
      this.persist({ sync: false })
      // 认领会**改变权限模型**，服务端会顺手踢掉非成员的订阅（见 hub.dropSubscribers）。
      // 本机本来是「无主可订阅」，现在成了「owner 可订阅」，重握手一次最干净。
      this.restartRealtime()
    },

    /**
     * 批量认领：把本机所有「已上云」的行程逐个认领一遍（SyncPage 的批量入口）。
     *
     * 候选 = 本地有分享码（sync.codes）的行程 —— 有码 = 服务端已存在；
     * 没码的行程云端还没有，登录后第一次推送就会直接归到名下，无需认领。
     *
     * 服务端没有只读的归属查询，认领本身就是探针：
     *   · 200 → 原本无主，这次归到你名下（claimed）；
     *   · 409 → 已经有归属（可能就是你自己的，也可能是别人名下的）→ 跳过（owned）；
     *   · 其它 → 如实报 failed，**不能**混进「跳过」里 —— 网络断和「不用认领」
     *     是两回事，混在一起会让用户以为都办妥了。
     * 全部跑完且确有新认领时才 pullAll + 重握手一次：逐个做会多打 N 次全量。
     */
    async claimAllLocal(): Promise<ClaimAllResult[]> {
      const results: ClaimAllResult[] = []
      for (const t of this.trips) {
        const code = this.sync.codes[t.id]
        if (!code) continue
        try {
          await this.api().claimSpace(t.id, code)
          results.push({ id: t.id, title: t.title, outcome: 'claimed' })
        } catch (e) {
          if (e instanceof BackendError && e.status === 409) {
            results.push({ id: t.id, title: t.title, outcome: 'owned' })
          } else {
            results.push({
              id: t.id,
              title: t.title,
              outcome: 'failed',
              error: e instanceof Error ? e.message : String(e)
            })
          }
        }
      }
      if (results.some((r) => r.outcome === 'claimed')) {
        await this.pullAll()
        this.persist({ sync: false })
        this.restartRealtime()
      }
      return results
    },

    setAuthor(name: string) {
      this.sync.author = (name || '').trim().slice(0, 24) || '我'
      this.persistSync()
    },

    // ---------- 实时同步（WebSocket） ----------

    /**
     * 取（必要时创建）本实例的实时控制器。
     *
     * `token` 用**回调**而不是传值：令牌会在登录 / 登出 / 续期时变化，
     * 传值的话每次都要重建控制器（并丢掉订阅列表）；回调每次 hello 时现取，
     * 永远是最新的那一份。
     */
    realtimeController(): RealtimeController {
      let rt = realtimes.get(this)
      if (rt) return rt
      rt = createRealtime({
        url: toWsUrl(getBackendBase(), REALTIME_PATH),
        token: () => (identityValid(this.sync.identity) ? String(this.sync.identity?.token || '') : ''),
        key: () => BACKEND_TOKEN,
        deviceId: () => this.sync.deviceId,
        timing: {
          retryBaseMs: REALTIME_RETRY_BASE_MS,
          retryMaxMs: REALTIME_RETRY_MAX_MS,
          helloTimeoutMs: REALTIME_HELLO_TIMEOUT_MS,
          idleTimeoutMs: REALTIME_IDLE_TIMEOUT_MS,
          idleCheckMs: Math.max(5_000, Math.round(REALTIME_PING_MS / 2))
        },
        onStatus: (status, detail) => {
          this.realtime.status = status
          this.realtime.connId = rt ? rt.connId : ''
          if (detail) this.realtime.lastError = detail
        },
        onUpdate: (u) => {
          this.realtime.lastEventAt = Date.now()
          // 通知只说「这个空间变了」，不带内容 —— 真正的合并仍然走 pullSpace，
          // 与推送响应共用同一套逐字段合并逻辑（理由见 services/realtime.ts 文件头）。
          this.queuePull(u.id)
        },
        onSubscribed: (accepted, denied) => this.onRealtimeSubscribed(accepted, denied)
      })
      realtimes.set(this, rt)
      return rt
    },

    /**
     * 订阅响应：这里承担**断线期间的补偿**。
     *
     * 服务端在 `accepted` 里带上了每个空间当前的 rev。本机记录的 rev 对不上，
     * 就说明「我离线这段时间它变过」—— 补拉一次。这是「通知可能丢」这件事的
     * 兜底：实时通道按加速层设计，正确性靠 rev 比对而不是靠消息不丢。
     */
    onRealtimeSubscribed(accepted: RealtimeSubInfo[], denied: RealtimeDenied[]) {
      const stale: string[] = []
      for (const s of accepted || []) {
        if (!s?.id || !s.exists) continue
        // 用 `?? -1` 而不是 `?? 0`：rev 从 0 开始（尚未有任何变更），
        // 用 0 当默认值会让「服务端 rev 是 0、本地没有记录」判成一致而漏拉一次。
        if (Number(s.rev) !== (this.sync.revOf[s.id] ?? -1)) stale.push(String(s.id))
      }
      for (const d of denied || []) {
        // 权限被收回（典型：无主行程被别人认领）：清掉本地记的 rev，
        // 免得下次重连又按「rev 不一致」去拉一个自己已经读不到的空间。
        if (d?.reason === 'access-revoked' && d.id) delete this.sync.revOf[String(d.id)]
      }
      if (stale.length) void this.pullMany(stale)
    },

    /** 启动实时通道（幂等，重复调用不会双开连接） */
    startRealtime() {
      if (!REALTIME_ENABLED) return
      this.ensureDeviceId()
      this.realtimeController().start()
      this.syncRealtimeSpaces()
    },

    /** 停止实时通道（不再自动重连） */
    stopRealtime() {
      const rt = realtimes.get(this)
      if (rt) rt.stop()
      this.realtime.status = 'stopped'
      this.realtime.connId = ''
    },

    /**
     * 回到前台 / 登录状态变化后调用。
     *
     * 已经 online 就什么都不做（否则每次切前台都会把连接断开重连，
     * 白丢一次握手 + 一次全量订阅）。没连上则立刻重连，不等退避到时间。
     */
    resumeRealtime() {
      if (!REALTIME_ENABLED) return
      this.ensureDeviceId()
      const rt = realtimes.get(this)
      if (rt) {
        // 必须走 start() 而不是 restart()：onHide 已把通道 stop() 掉（stopped=true），
        // restart 的 wasRunning=!stopped 判断恒为 false，只会落到 idle 直接返回、
        // 不发起连接 —— 一次后台/前台循环后实时通道就永久失活了。
        // start() 是幂等的「现在就要通」：已在线/连接中不动，停过就重连，有退避计时则立即连。
        if (rt.status !== 'online') rt.start()
      } else {
        this.realtimeController().start()
      }
      this.syncRealtimeSpaces()
    },

    /**
     * 登录 / 登出 / 认领后必须重连：令牌变了，能收到的范围也变了。
     * 只在本地改一下 `sync.identity` 是不够的 —— 已建立的连接仍然带着旧身份。
     */
    restartRealtime() {
      if (!REALTIME_ENABLED) return
      const rt = realtimes.get(this)
      if (!rt) return
      rt.restart()
      this.syncRealtimeSpaces()
    },

    /** 把「本机有哪些行程」同步给实时通道（差量下发，集合没变时是空操作） */
    syncRealtimeSpaces() {
      const rt = realtimes.get(this)
      if (!rt) return
      rt.setSpaces(this.trips.map((t) => t.id))
    },

    /**
     * 排队拉取一个空间。
     *
     * 正在拉的时候又来通知 → 记一笔「拉完再拉」，而不是并发第二个请求，
     * 也不是直接丢掉。丢掉会漏更新（拉取快照可能早于第二次改动），
     * 并发则会在大空间上把带宽打满。
     */
    queuePull(tripId: string) {
      let st = pullStates.get(this)
      if (!st) {
        st = { pulling: new Set(), again: new Set() }
        pullStates.set(this, st)
      }
      if (st.pulling.has(tripId)) {
        st.again.add(tripId)
        return
      }
      st.pulling.add(tripId)
      // 失败要留痕：设计上靠「下次通知 / 冷启动重拉」自愈，但连 warn 都没有的话，
      // 「不报错、只是不对」这类问题（同步没跟上）在排查时一条线索都不会有
      void this.pullSpace(tripId)
        .catch((e) => {
          console.warn('[sync] 实时通知触发的拉取失败，等待下次通知/冷启动自愈', tripId, e)
          return false
        })
        .then(() => {
          st.pulling.delete(tripId)
          // 飞行期间又变过 → 再拉一次，并且这次不再排下一轮（改动已包含在新快照里）
          if (st.again.delete(tripId)) this.queuePull(tripId)
        })
    },

    /** 顺序拉取多个空间（避免并发轰后端；单个失败不影响其它） */
    async pullMany(ids: string[]): Promise<void> {
      for (const id of ids) {
        try {
          await this.pullSpace(id)
        } catch {
          /* 单个空间拉失败不中断其余：下次通知/下次 cold start 会自愈 */
        }
      }
    },

    /**
     * 拉取**单个**空间并合并。
     *
     * 与 `pullAll` 的区别：不带 `?withDoc=1` 的全量列表，只取这一个。
     * 实时通知到达时用它 —— 一条通知就全量重拉，在大行程上代价太高。
     *
     * 刻意**不动** `syncedAtOf`：本地若有未推送的改动（localAtOf > syncedAtOf），
     * 拉取之后它仍然算脏，稍后照推不误。这正是「别人拉走了我的改动」这类 bug 的来源。
     */
    async pullSpace(tripId: string): Promise<boolean> {
      if (!SYNC_ENABLED) return false
      // 空间已不在本地集合（登出剪除 / dropLocalCopy / 本地已删）就只退订、不拉取：
      // applyServerDoc 会把服务端快照原样合并进来，已删除的本地副本会被它复活。
      // 两个检查点：发起前拦掉明确的死活计，网络往返期间被 drop 的靠第二个挡。
      if (!this.trips.some((t) => t.id === tripId)) {
        this.syncRealtimeSpaces()
        return false
      }
      try {
        const r = await this.api().getSpace(tripId)
        const s = r.space
        if (!s?.doc) return false
        if (!this.trips.some((t) => t.id === tripId)) {
          this.syncRealtimeSpaces()
          return false
        }
        this.applyServerDoc(s.id, s.doc, !!s.deleted, s.tombstones || [])
        this.sync.revOf[s.id] = s.rev
        if (s.code) this.sync.codes[s.id] = s.code
        this.persistSync()
        // 服务端新增的空间（比如别人先把本机没有的行程推上来了）也要纳入订阅
        this.syncRealtimeSpaces()
        return true
      } catch (e) {
        // 404 = 服务端没有这个空间（从未推上去过，或已被彻底清掉）。
        // 不是错误：本机的新行程在第一次推送前就是这个状态。
        if (e instanceof BackendError && e.status === 404) return false
        throw e
      }
    },

    /** 取某行程的完整文档（上传的最小单位） */
    docOf(tripId: string): TripDoc | null {
      const trip = this.trips.find((t) => t.id === tripId)
      if (!trip) return null
      return {
        trip,
        members: this.members.filter((m) => m.tripId === tripId),
        days: this.days.filter((d) => d.tripId === tripId),
        items: this.items.filter((i) => i.tripId === tripId),
        expenses: this.expenses.filter((e) => e.tripId === tripId),
        polls: this.polls.filter((p) => p.tripId === tripId),
        votes: this.votes.filter((v) => v.tripId === tripId),
        meetups: this.meetups.filter((m) => m.tripId === tripId),
        locations: this.locations.filter((l) => l.tripId === tripId)
      }
    },

    /**
     * 把服务端文档合并进本地（**逐字段** LWW）。
     *
     * 拉取与推送响应共用这一套逻辑，规则：
     *  · 同一个字段，谁的时间戳更新取谁 → 于是「服务端改了标题、本地改着金额」两边都在
     *  · 服务端独有 / 本地独有的记录都保留（后者是还没推上去的新记录，不能丢）
     *  · 任一侧墓碑标记删除的记录 → 剔除，不拉回来
     *
     * @param serverTombstones 服务端当前的墓碑列表。
     *   **必须传**：否则无法区分「这条记录是服务端删掉了」和「本地还没推上去」——
     *   两者在数据上都表现为「本地有、远端没有」，缺了墓碑就只能选择保留，
     *   于是别人删掉的东西会永远留在自己这儿。
     */
    applyServerDoc(
      tripId: string,
      doc: TripDoc | null,
      deleted = false,
      serverTombstones: Tombstone[] = []
    ) {
      const localTrip = this.trips.find((t) => t.id === tripId) || null
      const localMembers = this.members.filter((r) => r.tripId === tripId)
      const localDays = this.days.filter((r) => r.tripId === tripId)
      const localItems = this.items.filter((r) => r.tripId === tripId)
      const localExpenses = this.expenses.filter((r) => r.tripId === tripId)
      const localPolls = this.polls.filter((r) => r.tripId === tripId)
      const localVotes = this.votes.filter((r) => r.tripId === tripId)
      const localMeetups = this.meetups.filter((r) => r.tripId === tripId)
      const localLocations = this.locations.filter((r) => r.tripId === tripId)

      // 先无条件摘掉这个行程的所有本地记录，下面再按合并结果放回去
      this.trips = this.trips.filter((t) => t.id !== tripId)
      this.members = this.members.filter((r) => r.tripId !== tripId)
      this.days = this.days.filter((r) => r.tripId !== tripId)
      this.items = this.items.filter((r) => r.tripId !== tripId)
      this.expenses = this.expenses.filter((r) => r.tripId !== tripId)
      this.polls = this.polls.filter((r) => r.tripId !== tripId)
      this.votes = this.votes.filter((r) => r.tripId !== tripId)
      this.meetups = this.meetups.filter((r) => r.tripId !== tripId)
      this.locations = this.locations.filter((r) => r.tripId !== tripId)

      if (deleted || !doc || !doc.trip) {
        if (this.activeTripId === tripId) {
          this.activeTripId = this.tripsSorted[0]?.id || null
        }
        // 服务端说这个行程没了：把本地相关的同步元数据一并清掉，避免留下悬挂状态
        delete this.sync.revOf[tripId]
        delete this.sync.syncedAtOf[tripId]
        delete this.sync.localAtOf[tripId]
        delete this.sync.codes[tripId]
        this.persist({ sync: false })
        return
      }

      // 合并口径统一走 HLC：`recordHlc(rec.hlc, rec.updatedAt)` 取「记录自己的 hlc」
      // 与「记录自己的 updatedAt」中较晚者。没有 hlc 的老记录退化成 updatedAt
      // （节点号用全零），与服务端归一化后的值完全相等 —— 两端同一个函数，结论不可能分叉。
      const keyOf = (kind: string, id: string) => kind + ':' + id
      const hlcOf = (r: { hlc?: Hlc; updatedAt?: number }) => recordHlc(r.hlc, r.updatedAt ?? 0)

      // 收到别家的记录 = 「我已见过这个时刻」。先 observe，再考虑编辑：
      // 此后本机产生的任何戳都严格晚于它，因果关系就是这样被保住的。
      const clock = this.clock()
      const observeAll = (list: Array<{ hlc?: Hlc; updatedAt?: number }>) => {
        for (const r of list) clock.observe(r.hlc, r.updatedAt ?? 0)
      }
      observeAll([
        doc.trip,
        ...(doc.members ?? []),
        ...(doc.days ?? []),
        ...(doc.items ?? []),
        ...(doc.expenses ?? []),
        ...(doc.polls ?? []),
        ...(doc.votes ?? []),
        ...(doc.meetups ?? []),
        ...(doc.locations ?? [])
      ])
      observeAll(serverTombstones.map((t) => ({ hlc: t.hlc, updatedAt: t.deletedAt })))

      const tombOf = new Map<string, Hlc>()
      for (const t of [
        ...this.sync.tombstones.filter((x) => x.tripId === tripId),
        ...serverTombstones
      ]) {
        const key = keyOf(t.kind, t.id)
        const h = recordHlc(t.hlc, t.deletedAt)
        const prev = tombOf.get(key)
        if (!prev || hlcAfter(h, prev)) tombOf.set(key, h)
      }

      /** 记录是否已被墓碑「盖过」：删除晚于最后一次修改 ⇒ 该剔除 */
      const buried = (
        kind: SyncEntityKind,
        rec: { id: string; hlc?: Hlc; updatedAt?: number }
      ) => {
        const tomb = tombOf.get(keyOf(kind, rec.id))
        return tomb !== undefined && !hlcAfter(hlcOf(rec), tomb)
      }

      const mergeList = <T extends RecordStampable>(
        kind: SyncEntityKind,
        local: T[],
        remote: T[]
      ): T[] => {
        const remoteIds = new Set(remote.map((r) => r.id))
        const localById = new Map(local.map((r) => [r.id, r]))
        const out = new Map<string, T>()

        for (const r of remote) {
          if (buried(kind, r)) continue
          const l = localById.get(r.id)
          // **逐字段合并**，base = 服务端那一版（平局归服务端，与服务端同一个口径）。
          //
          // 这里必须逐字段，不能整条二选一：保留整条本地会丢掉服务端刚改的字段，
          // 取整条服务端则会丢掉本地**还没推上去**的字段改动 —— 后者是真正的数据丢失，
          // 因为那份改动再也不会出现在下一次推送里。
          // cap 与服务端合并口径一致（双方都先封顶再比较）：不封顶的话，
          // 时钟快 >60s 的设备会在字段比较里永远赢，两端各自保留己方值、静默分叉。
          out.set(r.id, l ? mergeRecord<T>(r, l, (h) => capHlc(h, Date.now(), CLOCK_MAX_SKEW_MS)).rec : r)
        }

        // 本地独有的记录：远端还没有（本地新增、尚未推送），必须留下
        for (const l of local) {
          if (remoteIds.has(l.id)) continue
          if (buried(kind, l)) continue
          out.set(l.id, l)
        }
        return [...out.values()]
      }

      const keepTrip = localTrip
        ? mergeRecord<Trip>(doc.trip, localTrip, (h) => capHlc(h, Date.now(), CLOCK_MAX_SKEW_MS)).rec
        : doc.trip

      this.trips = [...this.trips, keepTrip]
      this.members = [...this.members, ...mergeList('member', localMembers, doc.members ?? [])]
      this.days = [...this.days, ...mergeList('day', localDays, doc.days ?? [])]
      this.items = [...this.items, ...mergeList('item', localItems, doc.items ?? [])]
      this.expenses = [...this.expenses, ...mergeList('expense', localExpenses, doc.expenses ?? [])]
      this.polls = [...this.polls, ...mergeList('poll', localPolls, doc.polls ?? [])]
      this.votes = [...this.votes, ...mergeList('vote', localVotes, doc.votes ?? [])]
      this.meetups = [...this.meetups, ...mergeList('meetup', localMeetups, doc.meetups ?? [])]
      this.locations = [...this.locations, ...mergeList('location', localLocations, doc.locations ?? [])]
      this.persist({ sync: false })
    },

    /** 推送单个行程；成功返回服务端结果，失败抛错（墓碑与版本号保持不动，等下次重试） */
    async pushTrip(tripId: string): Promise<PushResult> {
      this.ensureDeviceId()
      const doc = this.docOf(tripId)
      const pending = this.sync.tombstones.filter((t) => t.tripId === tripId || t.id === tripId)
      if (!doc && !pending.length) {
        throw new Error('本地已无该行程，且没有待同步的删除记录')
      }
      const stampAt = this.sync.localAtOf[tripId] ?? 0

      const res = await this.api().pushSpace(
        tripId,
        {
          author: this.sync.author,
          deviceId: this.sync.deviceId,
          baseRev: this.sync.revOf[tripId] ?? null,
          doc,
          // 只发服务端认的字段。
          // hlc 必须一起带上：没有它，服务端只能拿 deletedAt 排队 ——
          // 「看到别人的改动之后才删的」这件事就表达不出来，删除可能被对方的旧内容盖回去。
          tombstones: pending.map((t) => ({
            kind: t.kind,
            id: t.id,
            deletedAt: t.deletedAt,
            ...(t.hlc ? { hlc: t.hlc } : {})
          }))
        },
        // 本机实时连接 id：服务端据此**不把通知发回给我**（我已经从响应里拿到合并结果）。
        // 用连接 id 而不是设备 id —— 同一台设备开两个标签页时 deviceId 是共享的，
        // 按设备排除会让另一个标签页收不到更新。
        realtimes.get(this)?.connId || ''
      )

      // 推送成功后才清墓碑：失败就留着下次重试，否则删除会静默丢失
      const sent = new Set(pending.map((t) => t.kind + ':' + t.id))
      this.sync.tombstones = this.sync.tombstones.filter((t) => !sent.has(t.kind + ':' + t.id))
      this.sync.revOf[tripId] = res.serverRev
      if (res.space?.code) this.sync.codes[tripId] = res.space.code
      // 记录「推送的是哪个时间点的本地状态」：请求飞行期间的改动不会被误判为已同步
      this.sync.syncedAtOf[tripId] = stampAt
      this.applyServerDoc(tripId, res.doc, res.space?.deleted, res.tombstones)
      this.persistSync()
      return res
    },

    /** 拉取云端全部空间并合并进本地 */
    async pullAll(): Promise<number> {
      const r = await this.api().listSpaces(true)
      let n = 0
      for (const s of r.spaces as TripSpaceFull[]) {
        if (!s.doc) continue
        this.applyServerDoc(s.id, s.doc, s.deleted, s.tombstones)
        this.sync.revOf[s.id] = s.rev
        if (s.code) this.sync.codes[s.id] = s.code
        // 刻意不动 syncedAtOf：拉取只是把服务端内容并进来，
        // 本地若有更新的改动（localAtOf > syncedAtOf）就仍然算脏，稍后照推不误。
        n += 1
      }
      this.persistSync()
      // 服务端可能有许多本机还没有的空间（别人先建的），订阅集合要跟着扩
      this.syncRealtimeSpaces()
      return n
    },
    /**
     * 完整同步：先拉（合别人的改动）→ 再推（自己的脏数据）→ 再拉一次（拿回合并结果）。
     * 后端不可达时只置状态，不抛错、不影响本地使用。
     */
    async syncAll(): Promise<void> {
      if (!SYNC_ENABLED) {
        this.sync.lastStatus = 'disabled'
        return
      }
      if (this.syncing) return
      this.syncing = true
      this.sync.lastStatus = 'syncing'
      try {
        this.ensureDeviceId()
        await this.pullAll()
        const dirty = this.dirtyTripIds
        for (const id of dirty) {
          await this.pushTrip(id)
        }
        if (dirty.length) await this.pullAll()
        this.sync.lastStatus = 'ok'
        this.sync.lastSyncAt = Date.now()
        this.sync.lastError = ''
        this.syncMessage = dirty.length ? `已同步 ${dirty.length} 个行程` : '已是最新'
      } catch (e) {
        const offline = e instanceof BackendError ? e.status === 0 : true
        this.sync.lastStatus = offline ? 'offline' : 'error'
        this.sync.lastError = e instanceof Error ? e.message : String(e)
        this.syncMessage = offline ? '连不上后端，改动已存在本机' : this.sync.lastError
      } finally {
        this.syncing = false
        this.persistSync()
      }
    },

    /** 凭分享码加入别人的行程 */
    async joinByCode(code: string): Promise<Trip> {
      this.ensureDeviceId()
      const normalized = code.trim().toUpperCase()
      // 优先走 POST /join：带会话令牌时服务端会**把当前用户登记为成员**，
      // 之后才有写权限（只读的 GET by-code 不会登记，加入后一改就 403）。
      // 老服务端没有这个接口 → 404，回退到 GET 版，仍是「只加人、不登记」的旧语义。
      let space: TripSpaceFull
      try {
        space = (await this.api().joinSpace(normalized)).space
      } catch (e) {
        if (e instanceof BackendError && e.status === 404) {
          space = (await this.api().getSpaceByCode(normalized)).space
        } else {
          throw e
        }
      }
      if (!space?.doc?.trip) throw new Error('这个分享码对应的行程是空的')
      if (space.deleted) throw new Error('这个行程已被发起人删除')

      this.applyServerDoc(space.id, space.doc, false, space.tombstones)
      this.sync.revOf[space.id] = space.rev
      this.sync.codes[space.id] = space.code
      // 只有当本地对这个行程没有任何未推送改动时，才把它标记为已同步；
      // 否则（本地已有更新的改动）保持不变，稍后照推。
      if (!this.sync.localAtOf[space.id]) this.sync.syncedAtOf[space.id] = 0
      this.activeTripId = space.id
      this.persistSync()
      this.persist({ sync: false })
      // 新加入的行程要立刻订阅上：否则「加入之后别人改了我看不到」，
      // 要等到下一次本地改动触发 scheduleSync 才补上 —— 而用户刚加入时往往什么都不改。
      this.syncRealtimeSpaces()
      return space.doc.trip
    },

    /** 取分享码；本地没有就先推一次让服务端分配 */
    async shareCodeOf(tripId: string): Promise<string> {
      const cached = this.sync.codes[tripId]
      if (cached) return cached
      const res = await this.pushTrip(tripId)
      return res.space.code
    },

    /** 探活：给「云同步」页展示后端是否可达 */
    async pingBackend(): Promise<boolean> {
      try {
        const r = await this.api().health()
        return !!r.ok
      } catch {
        return false
      }
    },

    /** 一键生成示例行程：成都 4 天 + 一组真实账单，用来看全套效果 */
    createDemoTrip(): Trip {
      const start = addDays(todayISO(), 14)
      const end = addDays(start, 3)

      const trip = this.createTrip({
        title: '成都四日 · 吃遍烟火',
        destination: '成都',
        startDate: start,
        endDate: end,
        budget: 3500,
        memberNames: ['我', '阿哲', '小林', 'Yuki']
      })

      this.generate(trip.id, {
        destination: '成都',
        startDate: start,
        endDate: end,
        peopleCount: 4,
        prefs: ['food', 'history', 'night'],
        pace: 'normal'
      })

      const members = this.members.filter((m) => m.tripId === trip.id)
      const [me, a, b, c] = members
      const d0 = addDays(start, 0)
      const d1 = addDays(start, 1)
      const d2 = addDays(start, 2)

      const seed: Array<{
        title: string
        amount: number
        category: Expense['category']
        date: string
        payer: Member
        participants: Member[]
        splitMode: Expense['splitMode']
        note?: string
      }> = [
        { title: '机场往返打车', amount: 186, category: 'transport', date: d0, payer: me, participants: members, splitMode: 'even', note: '两辆车' },
        { title: '蜀九香火锅', amount: 428, category: 'food', date: d0, payer: a, participants: members, splitMode: 'even' },
        { title: '宽窄巷子茶歇', amount: 96, category: 'food', date: d0, payer: b, participants: [b, c], splitMode: 'even', note: '我俩人喝了个茶' },
        { title: '熊猫基地门票', amount: 220, category: 'ticket', date: d1, payer: me, participants: members, splitMode: 'even' },
        { title: '民宿两晚', amount: 1560, category: 'stay', date: d1, payer: c, participants: members, splitMode: 'even' },
        { title: '建设巷小吃', amount: 158, category: 'food', date: d1, payer: b, participants: members, splitMode: 'even' },
        { title: '都江堰包车', amount: 520, category: 'transport', date: d2, payer: a, participants: members, splitMode: 'even' },
        { title: '都江堰门票', amount: 320, category: 'ticket', date: d2, payer: me, participants: members, splitMode: 'even' },
        { title: '手信·张飞牛肉', amount: 210, category: 'shopping', date: d2, payer: c, participants: [c], splitMode: 'custom' }
      ]

      seed.forEach((s) => {
        this.addExpense({
          tripId: trip.id,
          title: s.title,
          amount: s.amount,
          category: s.category,
          date: s.date,
          payerId: s.payer.id,
          participants: s.participants.map((p) => ({
            memberId: p.id,
            // 自定义分摊模式下，份额即绝对金额；其余模式用权重 1
            share: s.splitMode === 'custom' ? s.amount : 1
          })),
          splitMode: s.splitMode,
          note: s.note || ''
        })
      })

      return trip
    }
  }
})
