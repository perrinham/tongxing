/** 行程空间 */

/** 行李清单里的单件：group 是分组 key（见 utils/packing 的 PACKING_GROUPS），done = 已装包 */
export interface PackingItem {
  title: string
  group: string
  done: boolean
}

/** 行李清单整体（trip.packing 字段，整块参与字段级 LWW） */
export interface PackingList {
  /** 生成时间：用来识别「自动生成、可整体重造」 */
  builtAt: number
  items: PackingItem[]
}

export interface Trip {
  id: string
  title: string
  destination: string
  startDate: string
  endDate: string
  currency: string
  /** 人均预算，0 表示未设置 */
  budget: number
  memberIds: string[]
  createdAt: number
  /** 是否已完成结算 */
  settledAt?: number
  /**
   * 行李清单（AI 按行程信息生成，用户可增删勾选）。
   * 整体作为**单个字段**参与字段级 LWW 合并 —— 清单不是高频并发编辑对象，
   * 整块粒度够用；服务端/云函数的 normTrip 各有一份同款裁剪孪生（40 项上限）。
   */
  packing?: PackingList
  /**
   * 最后修改时间。云端同步靠它做 last-write-wins 比较，
   * 因此**任何改动都必须刷新这个字段**（见 stores/trip.ts 的 touch）。
   */
  updatedAt?: number
  /** 本次修改的 HLC，参与云端 LWW 比较；老记录没有则回退用 updatedAt */
  hlc?: Hlc
  /**
   * 字段级时间戳：每个可合并字段各带一个 HLC。
   *
   * 记录级 hlc 只能回答「这条记录谁最后改的」，答不了「哪个字段谁最后改的」——
   * 于是两人分别改同一条记录的不同字段时会丢一边。有了这张映射就能逐字段比。
   *
   * **映射必须是完整的**（每个可合并字段都有值）：缺字段会退回记录级 hlc，
   * 而记录级 hlc 是各字段戳的最大值，会被别的字段的编辑顶高 → 反而更容易盖掉别人。
   * 老记录没有这个字段，整体退到记录级语义，不需要迁移。
   */
  fhlc?: Record<string, Hlc>
}

/** 同行成员 */
export interface Member {
  id: string
  tripId: string
  name: string
  /** 头像色块索引 */
  colorIndex: number
  /** 分摊权重，默认 1 */
  weight: number
  isSelf?: boolean
  updatedAt?: number
  /** 本次修改的 HLC，参与云端 LWW 比较；老记录没有则回退用 updatedAt */
  hlc?: Hlc
  /**
   * 字段级时间戳：每个可合并字段各带一个 HLC。
   *
   * 记录级 hlc 只能回答「这条记录谁最后改的」，答不了「哪个字段谁最后改的」——
   * 于是两人分别改同一条记录的不同字段时会丢一边。有了这张映射就能逐字段比。
   *
   * **映射必须是完整的**（每个可合并字段都有值）：缺字段会退回记录级 hlc，
   * 而记录级 hlc 是各字段戳的最大值，会被别的字段的编辑顶高 → 反而更容易盖掉别人。
   * 老记录没有这个字段，整体退到记录级语义，不需要迁移。
   */
  fhlc?: Record<string, Hlc>
}

/** 行程中的一天 */
export interface Day {
  id: string
  tripId: string
  date: string
  index: number
  title: string
  note: string
  updatedAt?: number
  /** 本次修改的 HLC，参与云端 LWW 比较；老记录没有则回退用 updatedAt */
  hlc?: Hlc
  /**
   * 字段级时间戳：每个可合并字段各带一个 HLC。
   *
   * 记录级 hlc 只能回答「这条记录谁最后改的」，答不了「哪个字段谁最后改的」——
   * 于是两人分别改同一条记录的不同字段时会丢一边。有了这张映射就能逐字段比。
   *
   * **映射必须是完整的**（每个可合并字段都有值）：缺字段会退回记录级 hlc，
   * 而记录级 hlc 是各字段戳的最大值，会被别的字段的编辑顶高 → 反而更容易盖掉别人。
   * 老记录没有这个字段，整体退到记录级语义，不需要迁移。
   */
  fhlc?: Record<string, Hlc>
}

export type ItemType = 'spot' | 'food' | 'transport' | 'stay' | 'other'

/** 行程项 */
export interface ItineraryItem {
  id: string
  dayId: string
  tripId: string
  order: number
  /** HH:mm，空表示未定时 */
  time: string
  type: ItemType
  title: string
  address: string
  lat: number
  lng: number
  /** 预估花费（每人） */
  cost: number
  /** 建议停留分钟数 */
  duration: number
  note: string
  /** 已打卡 */
  done: boolean
  /**
   * 行程核验收讫时间戳（ms），0/缺省 = 待核实。AI 生成的条目先标记，
   * 用户点「现场确认」后写时间戳走 updateItem 正常盖章参与同步。
   */
  verifiedAt?: number
  updatedAt?: number
  /** 本次修改的 HLC，参与云端 LWW 比较；老记录没有则回退用 updatedAt */
  hlc?: Hlc
  /**
   * 字段级时间戳：每个可合并字段各带一个 HLC。
   *
   * 记录级 hlc 只能回答「这条记录谁最后改的」，答不了「哪个字段谁最后改的」——
   * 于是两人分别改同一条记录的不同字段时会丢一边。有了这张映射就能逐字段比。
   *
   * **映射必须是完整的**（每个可合并字段都有值）：缺字段会退回记录级 hlc，
   * 而记录级 hlc 是各字段戳的最大值，会被别的字段的编辑顶高 → 反而更容易盖掉别人。
   * 老记录没有这个字段，整体退到记录级语义，不需要迁移。
   */
  fhlc?: Record<string, Hlc>
}

export type ExpenseCategory =
  | 'food'
  | 'transport'
  | 'stay'
  | 'ticket'
  | 'shopping'
  | 'entertain'
  | 'other'

/** 投票的主题：给行程定出发日期 / 目的地 */
export type PollKind = 'date' | 'destination'

/** 投票状态：进行中 / 已结束（可应用到行程） */
export type PollStatus = 'open' | 'closed'

/** 一个投票候选选项 */
export interface PollOption {
  id: string
  /** 展示值：日期候选是 'YYYY-MM-DD'，目的地候选是城市名 */
  label: string
}

/**
 * 一次投票：成员给行程的候选日期 / 候选目的地投票。
 *
 * 同步语义与 member/item 等一致（独立记录 + 字段级 HLC）：选项列表整体当一个
 * 字段合并（发起票时定，之后不改），每张票是**另一类记录** Vote —— 拆开才能
 * 并发不丢票（整块 ballots 当字符串字段会被最后写的人整体覆盖）。
 */
export interface Poll {
  id: string
  tripId: string
  kind: PollKind
  title: string
  options: PollOption[]
  status: PollStatus
  /** 已采纳的选项 id（「应用于行程」时落到这里，之后 result 不再参与 LWW 变更） */
  result?: string
  createdAt: number
  updatedAt?: number
  /** 本次修改的 HLC，参与云端 LWW 比较；老记录没有则回退用 updatedAt */
  hlc?: Hlc
  /**
   * 字段级时间戳：每个可合并字段各带一个 HLC。
   *
   * 记录级 hlc 只能回答「这条记录谁最后改的」，答不了「哪个字段谁最后改的」——
   * 于是两人分别改同一条记录的不同字段时会丢一边。有了这张映射就能逐字段比。
   *
   * **映射必须是完整的**（每个可合并字段都有值）：缺字段会退回记录级 hlc，
   * 而记录级 hlc 是各字段戳的最大值，会被别的字段的编辑顶高 → 反而更容易盖掉别人。
   * 老记录没有这个字段，整体退到记录级语义，不需要迁移。
   */
  fhlc?: Record<string, Hlc>
}

/**
 * 一张票：某成员在某个投票里选了哪个选项。
 *
 * id = `${pollId}_${memberId}` —— 成员与投票唯一对应，改票就是更新自己这条
 * 记录（字段级并发安全，两个成员同时投互不覆盖）。
 * ⚠️ 分隔符必须是下划线：服务端 isSafeId 字符集是 `[A-Za-z0-9_-]`，冒号会整条被拒。
 */
export interface Vote {
  id: string
  tripId: string
  pollId: string
  memberId: string
  optionId: string
  updatedAt?: number
  /** 本次修改的 HLC，参与云端 LWW 比较；老记录没有则回退用 updatedAt */
  hlc?: Hlc
  /**
   * 字段级时间戳：每个可合并字段各带一个 HLC。
   *
   * 记录级 hlc 只能回答「这条记录谁最后改的」，答不了「哪个字段谁最后改的」——
   * 于是两人分别改同一条记录的不同字段时会丢一边。有了这张映射就能逐字段比。
   *
   * **映射必须是完整的**（每个可合并字段都有值）：缺字段会退回记录级 hlc，
   * 而记录级 hlc 是各字段戳的最大值，会被别的字段的编辑顶高 → 反而更容易盖掉别人。
   * 老记录没有这个字段，整体退到记录级语义，不需要迁移。
   */
  fhlc?: Record<string, Hlc>
}

/** 集合点：行程里约定的一处汇合地点。每行程至多一条（id = `meetup_<tripId>`）。 */
export interface Meetup {
  id: string
  tripId: string
  /** 地点名称（如「春熙路地铁站 A 口」） */
  title: string
  address: string
  lat: number
  lng: number
  createdAt: number
  updatedAt?: number
  /** 本次修改的 HLC，参与云端 LWW 比较；老记录没有则回退用 updatedAt */
  hlc?: Hlc
  /**
   * 字段级时间戳：每个可合并字段各带一个 HLC。
   *
   * 记录级 hlc 只能回答「这条记录谁最后改的」，答不了「哪个字段谁最后改的」——
   * 于是两人分别改同一条记录的不同字段时会丢一边。有了这张映射就能逐字段比。
   *
   * **映射必须是完整的**（每个可合并字段都有值）：缺字段会退回记录级 hlc，
   * 而记录级 hlc 是各字段戳的最大值，会被别的字段的编辑顶高 → 反而更容易盖掉别人。
   * 老记录没有这个字段，整体退到记录级语义，不需要迁移。
   */
  fhlc?: Record<string, Hlc>
}

/**
 * 成员实时位置（共享）：每个人在行程里留一条当前位置。
 *
 * id = `loc_<memberId>` —— 成员与位置记录唯一对应，上报就是更新自己这条；
 * 记录存在 = 正在共享，删除（墓碑）= 停止共享。
 * ⚠️ id 里的分隔符用下划线：lww 的服务端 isSafeId 字符集是 `[A-Za-z0-9_-]`。
 */
export interface LocationShare {
  id: string
  tripId: string
  memberId: string
  lat: number
  lng: number
  /** 定位精度（米），来自 getLocation 的 accuracy；0 表示未知 */
  accuracy?: number
  updatedAt?: number
  /** 本次修改的 HLC，参与云端 LWW 比较；老记录没有则回退用 updatedAt */
  hlc?: Hlc
  /**
   * 字段级时间戳：每个可合并字段各带一个 HLC。
   *
   * 记录级 hlc 只能回答「这条记录谁最后改的」，答不了「哪个字段谁最后改的」——
   * 于是两人分别改同一条记录的不同字段时会丢一边。有了这张映射就能逐字段比。
   *
   * **映射必须是完整的**（每个可合并字段都有值）：缺字段会退回记录级 hlc，
   * 而记录级 hlc 是各字段戳的最大值，会被别的字段的编辑顶高 → 反而更容易盖掉别人。
   * 老记录没有这个字段，整体退到记录级语义，不需要迁移。
   */
  fhlc?: Record<string, Hlc>
}

export type SplitMode = 'even' | 'weight' | 'custom'

/** 参与分摊的人 */
export interface Participant {
  memberId: string
  /** 分摊份额。even 模式忽略；weight 模式为权重；custom 模式为绝对金额 */
  share: number
}

/** 一笔账 */
export interface Expense {
  id: string
  tripId: string
  title: string
  amount: number
  category: ExpenseCategory
  date: string
  /** 谁付的 */
  payerId: string
  /** 为谁付 */
  participants: Participant[]
  splitMode: SplitMode
  note: string
  createdAt: number
  updatedAt?: number
  /** 本次修改的 HLC，参与云端 LWW 比较；老记录没有则回退用 updatedAt */
  hlc?: Hlc
  /**
   * 字段级时间戳：每个可合并字段各带一个 HLC。
   *
   * 记录级 hlc 只能回答「这条记录谁最后改的」，答不了「哪个字段谁最后改的」——
   * 于是两人分别改同一条记录的不同字段时会丢一边。有了这张映射就能逐字段比。
   *
   * **映射必须是完整的**（每个可合并字段都有值）：缺字段会退回记录级 hlc，
   * 而记录级 hlc 是各字段戳的最大值，会被别的字段的编辑顶高 → 反而更容易盖掉别人。
   * 老记录没有这个字段，整体退到记录级语义，不需要迁移。
   */
  fhlc?: Record<string, Hlc>
}

/** 结算结果：一笔转账 */
export interface Transfer {
  fromId: string
  toId: string
  amount: number
}

/** 个人净额 */
export interface NetBalance {
  memberId: string
  /** 正数为应收，负数为应付 */
  net: number
  paid: number
  shouldPay: number
}

/** 结算看板数据 */
export interface SettlementResult {
  total: number
  perCapita: number
  balances: NetBalance[]
  transfers: Transfer[]
  /** 分类汇总 */
  byCategory: { category: ExpenseCategory; amount: number }[]
}

/** 城市足迹状态 */
export type CityStatus = 'visited' | 'wish'

/** 城市护照：用户标记去过 / 想去，并附攻略与评价 */
export interface CityPassport {
  id: string
  /** 城市名（如「成都」） */
  name: string
  status: CityStatus
  /** gcj-02 坐标，与微信 <map> 一致 */
  lat: number
  lng: number
  /** 到访日期（去过时填写），ISO 日期 */
  visitDate?: string
  /** 攻略 */
  guide?: string
  /** 评价 */
  review?: string
  /** 评分 1-5 */
  rating?: number
  /** 想去理由（想去时填写） */
  wishNote?: string
  createdAt: number
  updatedAt: number
  /**
   * 归属 openid。''=本机匿名创建（未登录时留下的本地数据），登录后由
   * onIdentityChanged 认领；换账号登录时，属于别人的条目会被清出本地
   * （只清本地不撤回服务端 —— 那些足迹仍然属于原账号）。
   */
  owner: string
}

/**
 * 共享的城市攻略 / 评价（来自后端，多人可见）。
 * 想去的人读去过的人写的攻略，靠它实现。
 */
export interface CityGuide {
  id: string
  /** 城市名 */
  cityName: string
  /** 作者昵称 */
  author: string
  status: CityStatus
  /** 到访日期（去过时填写），ISO 日期 */
  visitDate?: string
  /** 攻略 */
  guide?: string
  /** 评价 */
  review?: string
  /** 评分 1-5 */
  rating?: number
  /** 想去理由（想去时填写） */
  wishNote?: string
  createdAt: number
  updatedAt: number
}

export interface PersistShape {
  version: number
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
}

// ───────────────────────── 天气 ─────────────────────────

/** 逐日天气（/api/weather 返回元素）。code 是 WMO 天气码，文案/图标映射在 src/utils/weather.ts */
export interface WeatherDay {
  date: string
  /** WMO weather code；-1 表示上游未提供 */
  code: number
  tmax: number | null
  tmin: number | null
}

/** GET /api/weather 响应（服务端代理 Open-Meteo，见 server/routes/weather.mjs） */
export interface WeatherReply {
  place: string
  resolved: { name: string; lat: number; lng: number }
  days: WeatherDay[]
  /** true = 行程长度超过预报上限（免费档 16 天），只覆盖前段 */
  truncated?: boolean
  /** 数据来源标识：open-meteo / mock（测试） */
  source: string
}

/** 天气本地缓存条目（离线可用，见 src/utils/weather.ts） */
export interface WeatherCacheEntry {
  /** 抓取时间戳（ms）。超过 TTL 后变 stale —— 仍可用于断网降级，但不再当新鲜数据 */
  at: number
  days: WeatherDay[]
}

/** 天气本地缓存整体形状：key = weatherCacheKey(...) */
export type WeatherCache = Record<string, WeatherCacheEntry>

// ───────────────────────── 云端同步 ─────────────────────────

/**
 * 混合逻辑时钟（HLC）。
 *
 * 云端「谁更新」比的不是各设备的 `Date.now()`，而是这个三元组：
 * 先比 `t`，再比 `c`，最后比 `n`，构成全序。
 *
 * · `t` 物理毫秒。收到别人的戳时会被推到不早于对方，所以它可能「跑在物理时间前面」——
 *   这是刻意的：因果关系就靠它表达（我看到 A 才改的 ⇒ 我一定排在 A 之后）。
 * · `c` 同毫秒内的自增计数，兜住「同一毫秒改两次」。
 * · `n` 8 位十六进制节点号，只在同 t 同 c 时做最后的定序，不承载语义。
 *
 * 语义与 `server/lib/hlc.mjs` 严格一致，两侧不可各自改动。
 */
export interface Hlc {
  t: number
  c: number
  n: string
}

/** 可参与同步的实体类型 */
export type SyncEntityKind = 'trip' | 'member' | 'day' | 'item' | 'expense' | 'poll' | 'vote' | 'meetup' | 'location'

/**
 * 删除墓碑。
 * 删除必须显式记录，不能靠「快照里没有这条」来表达 ——
 * 否则一台离线设备的旧快照会把已删记录整批推回来（复活）。
 */
export interface Tombstone {
  kind: SyncEntityKind
  id: string
  deletedAt: number
  /** 删除时刻的 HLC；缺省时服务端退化成用 deletedAt 排队（老记录兼容） */
  hlc?: Hlc
  /**
   * 该记录所属行程。仅客户端使用：本地删除后记录已不存在，
   * 靠它才能在推送时知道这个墓碑该发给哪个行程空间（服务端会忽略该字段）。
   */
  tripId?: string
}

/** 一个行程空间的完整文档（上传 / 下载的单位） */
export interface TripDoc {
  trip: Trip | null
  members: Member[]
  days: Day[]
  items: ItineraryItem[]
  expenses: Expense[]
  polls: Poll[]
  votes: Vote[]
  meetups: Meetup[]
  locations: LocationShare[]
}

/** 云端空间概要（列表用，不含文档体） */
export interface TripSpaceBrief {
  id: string
  code: string
  rev: number
  deleted: boolean
  title: string
  destination: string
  startDate: string
  endDate: string
  updatedAt: number
  updatedBy: string
  counts: {
    members: number
    days: number
    items: number
    expenses: number
    polls: number
    votes: number
    meetups: number
    locations: number
  }
}

/** 云端空间全量（含文档体与墓碑） */
export interface TripSpaceFull extends TripSpaceBrief {
  doc: TripDoc
  tombstones: Tombstone[]
}

/**
 * 发现广场条目。
 *
 * 与 TripSpaceBrief 的差异：附 `mine` 标记（owner 或成员 = 我参与的空间）；
 * `code` 变为可选 —— 服务端对非 mine 条目剥掉分享码（code = 加入即写权，
 * 广场只读浏览不能把写权广播出去）。
 */
export interface DiscoverTrip extends Omit<TripSpaceBrief, 'code'> {
  code?: string
  mine: boolean
}

/** 推送合并结果 */
export interface PushResult {
  space: TripSpaceBrief
  doc: TripDoc
  tombstones: Tombstone[]
  applied: { added: number; updated: number; removed: number; conflicts: number }
  /** 服务端内容是否因本次推送而变化 */
  changed: boolean
  /** 本地 baseRev 与服务端不一致（说明别人改过），但仍按 LWW 合并了 */
  staleBase: boolean
  serverRev: number
  /**
   * 本次推送里有几条记录的时间戳明显超前服务端（> MAX_CLOCK_SKEW_MS）。
   * 大于 0 时说明本机或同行某台设备的时间可能不准，值得提示用户。
   * 注意服务端**不会**因此改写任何时间戳，只是把比较口径封顶（见 lib/hlc.mjs）。
   */
  skewed?: number
}

export type SyncStatus = 'idle' | 'syncing' | 'ok' | 'offline' | 'error' | 'disabled'

/**
 * 微信身份（登录后拿到）。
 *
 * `openid` 是微信侧签发的、同一小程序内唯一且**不可自选**的标识，服务端用它
 * 回答「你是谁」以及「这个行程 / 这条攻略归不归你」。`token` 是服务端签的无状态
 * 会话令牌（见 server/lib/identity.mjs），后续请求通过 `X-Session-Token` 带上。
 *
 * 令牌是**无状态**的：服务端没有会话表，所以「登出」只需在本地把它删掉
 * （服务端那份在过期前仍然有效，这是无状态方案的已知代价）。
 */
export interface Identity {
  openid: string
  token: string
  /** 毫秒时间戳；到期后需要重新 uni.login */
  expiresAt: number
  /** 服务端处于开发登录模式（仅本地 / 测试），界面上会提示 */
  dev?: boolean
}

/** 同步元数据（本地存储，与业务数据分开） */
export interface SyncMeta {
  /** 本机标识，用于服务端审计「谁改的」 */
  deviceId: string
  /** 推送时署的名字（同行的人靠它分辨改动来源） */
  author: string
  /** 上次成功同步时间 */
  lastSyncAt: number
  lastStatus: SyncStatus
  lastError: string
  /** tripId -> 服务端 rev */
  revOf: Record<string, number>
  /**
   * tripId -> 本机最后一次修改该行程（含其成员 / 行程项 / 账单）的时间。
   *
   * 为什么不直接用 Trip.updatedAt 判断「要不要推」：
   * 改一笔账单并不会、也不应该改动 Trip 记录本身（否则 LWW 会让
   * 「改了账单的人」连带把行程标题覆盖成自己手里的旧值）。
   * 所以本地改动用一个独立的时钟记录，与参与合并的 updatedAt 解耦。
   */
  localAtOf: Record<string, number>
  /** tripId -> 上次推送成功时 localAtOf 的值 */
  syncedAtOf: Record<string, number>
  /** tripId -> 分享码 */
  codes: Record<string, string>
  /** 待上报的删除墓碑 */
  tombstones: Tombstone[]
  /**
   * 本机 HLC 的持久状态（上次 stamp / observe 之后的值）。
   *
   * **必须持久化**：否则每次冷启动都从 `t = 0` 起步，手机时钟若落后于上次见过的
   * 服务端时间戳，冷启动后的第一次编辑会拿到一个更小的 HLC，
   * 因果关系当场断裂 —— 编辑推上去会被判成落后而丢弃。
   */
  hlc?: Hlc
  /**
   * 微信身份（登录后写入）。
   *
   * 与 `deviceId` 是两码事：`deviceId` 标识**这台设备**，只用于服务端审计；
   * `identity.openid` 标识**这个人**，是服务端做归属与授权判定的唯一依据。
   * 同一台设备换个人登录，`deviceId` 不变、`openid` 变。
   */
  identity?: Identity | null
}
