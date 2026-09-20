/**
 * 字段级 LWW 合并（last-write-wins **per field**）—— 客户端孪生。
 *
 * ⚠️ 本文件是 `server/lib/lww.mjs` 的孪生实现。服务端是 .mjs、客户端是 .ts，
 * 在「零依赖 + 小程序不能引 Node 内置模块」的约束下没法共享同一份源码，
 * 只能各写一份。**改一边必须同步改另一边**，两侧各有一组字面量断言钉住行为
 * （`server/smoke.mjs` 的 [16] 与 `scripts/client-sync-test.mjs` 的 [10]）。
 *
 * ── 为什么客户端也要这一份 ──
 *
 * 只在服务端做字段级合并是不够的，有一个真实的数据丢失窗口：
 *
 *   客户端的本地改动是**未推送**的（比如改了金额，戳 H2），此时拉下来服务端的新版本
 *   （别人改了标题，戳 H3）。若按「记录级比大小」判定，本地整条 H3 落败 →
 *   本地那条金额改动被服务端版本覆盖 → 推上去时它已经不在了，**改动丢失**。
 *
 * 逐字段合并就没这个问题：本地金额（H2 > 服务端的 H1）胜出、服务端标题（H3 > H2）胜出，
 * 合起来两边都在，再推上去即收敛。
 *
 * ── 平局口径（必须与服务端一致）──
 *
 * **严格更晚才赢，相等保留 `base`**。两端的 base 都是「服务端那一版」：
 *   服务端  base = 库里已有内容
 *   客户端  base = 刚拉下来的服务端版本，incoming = 本地（含未推送改动）
 * 于是平局时两端都归到服务端的值，不会来回翻。
 */

import { hlcAfter, normHlc, recordHlc, hlcTimeOf, type Hlc } from '@/services/hlc'

/**
 * 能参与字段级合并的最小记录形状（Trip / Member / Day / ItineraryItem / Expense 都满足）。
 *
 * 刻意**不**加 `[key: string]: unknown` 索引签名：那样这些具体接口就都不再满足约束了
 * （TS 的索引签名与接口不兼容是已知的限制）。运行期才知道的字段名一律在实现内部
 * 用 `LooseRec` 这个宽松视图访问，约束面上保持干净。
 */
export interface RecordStampable {
  id: string
  updatedAt?: number
  hlc?: Hlc
  fhlc?: Record<string, Hlc>
}

/** 实现内部用的宽松视图，不要出现在对外签名里 */
type LooseRec = RecordStampable & Record<string, unknown>

/** 把任意记录看成宽松视图（只读用途） */
function loose(rec: unknown): LooseRec {
  return (rec ?? {}) as LooseRec
}

/**
 * 不参与字段级合并的键。
 * 身份（id / tripId）、以及时间戳本身（updatedAt / hlc / fhlc）都不是「内容字段」。
 */
export const MERGE_META_KEYS = new Set(['id', 'tripId', 'updatedAt', 'hlc', 'fhlc'])

/** 单条记录的字段戳上限，与服务端一致 */
export const MAX_MERGE_FIELDS = 48

/** 记录里参与合并的字段名 */
export function dataKeysOf(rec: unknown): string[] {
  if (!rec || typeof rec !== 'object') return []
  return Object.keys(rec as object).filter((k) => !MERGE_META_KEYS.has(k))
}

/**
 * 取一条记录的**完整**字段戳映射。
 *
 * ⚠️ 映射里**显式列出**的字段直接用它的值，**不要**再套 `recordHlc` 之类的兜底。
 * 否则「只改了预算」的客户端手里那个没动过的标题会被顶到同一个新时刻，
 * 反过来盖掉服务端上别人刚改的标题 —— 字段级合并反而比记录级更糟。
 * 兜底只该发生在**映射里根本没有**这个字段的时候（老记录 / 老客户端）。
 */
export function fieldHlcsOf(rec: RecordStampable | null | undefined): Record<string, Hlc> {
  const r = loose(rec)
  const recH = recordHlc(r.hlc, r.updatedAt ?? 0)
  const src = r.fhlc && typeof r.fhlc === 'object' ? (r.fhlc as Record<string, Hlc>) : null
  const out: Record<string, Hlc> = {}
  const keys = dataKeysOf(r)
  for (let i = 0; i < keys.length && i < MAX_MERGE_FIELDS; i += 1) {
    const k = keys[i]
    const own = src ? src[k] : null
    const t = Number(own?.t)
    out[k] = own && Number.isFinite(t) && t > 0 ? normHlc(own, 0) : recH
  }
  return out
}

/**
 * 记录级 hlc 与 updatedAt 一律由字段戳**推导**，不允许各自独立赋值。
 *
 * 记录级 hlc 用于跟墓碑比较（「记录比墓碑新 = 删后又改」），
 * 语义就是「这条记录最后一次被碰是什么时候」= 各字段戳的最大值。
 */
export function withRecordHlc<T extends RecordStampable>(
  rec: T,
  stamp: Record<string, Hlc>
): T {
  let max: Hlc | null = null
  for (const k of Object.keys(stamp)) {
    const h = stamp[k]
    if (!h) continue
    if (!max || hlcAfter(h, max)) max = h
  }
  const out = { ...rec, fhlc: stamp }
  if (max) {
    out.hlc = max
    out.updatedAt = hlcTimeOf(max)
  }
  return out
}

export interface MergeRecordResult<T> {
  rec: T
  fhlc: Record<string, Hlc>
  /** base 存在且有字段被 incoming 赢走 */
  took: number
  /** base 存在且有字段守住了（incoming 那份更旧） */
  kept: number
}

/**
 * 逐字段合并。
 *
 * @param base     已有的那份（客户端 = 刚拉下来的服务端版本）；传 null 表示插入
 * @param incoming 推过来的那份（客户端 = 本地含未推送改动）
 */
export function mergeRecord<T extends RecordStampable>(
  base: T | null | undefined,
  incoming: T | null | undefined,
  cap: (h: Hlc) => Hlc = (h) => h
): MergeRecordResult<T> {
  const baseH = base ? fieldHlcsOf(base) : null
  const incH = incoming ? fieldHlcsOf(incoming) : {}
  const keys = new Set<string>([...(baseH ? Object.keys(baseH) : []), ...Object.keys(incH)])

  // 起点是**两边字段的并集**，缺的一侧由另一侧补齐。
  //
  // ⚠️ 不能只按「数据字段」拼。`id` / `tripId` 这些元数据键不参与字段级比较，
  // 但它们是记录的**身份**，插入时必须从 incoming 带过来 ——
  // 只按数据字段填会让新建的记录丢掉 id，落库时直接报参数绑定失败。
  const out: LooseRec = { ...loose(incoming), ...(base ? loose(base) : {}) }
  const inc = loose(incoming)
  const stamp: Record<string, Hlc> = {}
  let took = 0
  let kept = 0

  for (const k of keys) {
    const a = incH[k] ? cap(incH[k]) : null
    const b = baseH && baseH[k] ? cap(baseH[k]) : null

    // 严格更晚才赢；相等保留 base —— 见文件头的「平局口径」。
    if (a && (!b || hlcAfter(a, b))) {
      // 值和戳必须同进退：incoming 时间赢、但记录体里没带这个键时，值只能留
      // base 的旧值，戳也必须一起留 —— 若只顶戳，会「新戳守着旧值」，
      // 后续对这一格的编辑按戳判负而被悄悄吞掉（戳值脱钩）。与服务端孪生一致。
      const hasBodyKey = !!incoming && Object.prototype.hasOwnProperty.call(incoming, k)
      if (hasBodyKey) {
        out[k] = inc[k]
        stamp[k] = incH[k]
        if (b) took += 1
      } else {
        stamp[k] = baseH?.[k] ?? incH[k]
        if (a) kept += 1
      }
    } else {
      stamp[k] = baseH![k]
      if (a) kept += 1
    }
  }

  return { rec: withRecordHlc(out as T, stamp), fhlc: stamp, took, kept }
}
