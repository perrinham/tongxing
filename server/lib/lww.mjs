/**
 * 字段级 LWW 合并（last-write-wins **per field**）。
 *
 * ── 为什么需要 ──
 *
 * 记录级 LWW 的固有代价是：两人分别改了同一条记录的不同字段，仍然会丢一边。
 * 典型场景 —— 旅行途中 A 改了行程标题、B 同时改了预算，谁后推谁整条覆盖，
 * 另一方那一格白改。数据没丢（值还在对面手里），但用户看到的就是「我改的没了」。
 *
 * 修法是给**每个字段**各自一个时间戳：合并时逐字段比，各取较晚的那份，
 * 于是「A 改标题、B 改预算」两边都保住。
 *
 * ── 数据结构 ──
 *
 * 记录上多一个 `fhlc: { 字段名: HLC }`。字段的生效时间戳 = `fhlc[字段]`；
 * 映射里没有该字段时（老记录 / 老客户端）退回记录级 `hlc` —— 那正是旧的记录级 LWW 语义，
 * 所以老数据不需要迁移，新老数据能在同一把尺子上排队。
 *
 * **字段戳映射必须是"完整"的**（每个参与合并的字段都有值）。这是整个方案的命门：
 *
 *   设映射不全，某字段就退回**记录级 hlc**；而记录级 hlc 是各字段戳的**最大值**，
 *   会被另一个字段的编辑顶高。于是「只改了预算」的客户端，会把标题的生效时间
 *   一起顶到自己的新时刻，反过来把别人刚改的标题盖回旧值 ——
 *   字段级合并反而比记录级更糟。
 *
 *   所以：写入时一律补全映射，客户端收到后原样回传、只顶自己改过的字段。
 *
 * ── 平局口径 ──
 *
 * **严格更晚才赢，相等保留 `base`**。两端用同一个 `base` 语义：
 *   服务端  base = 库里已有内容，incoming = 客户端推上来的
 *   客户端  base = 刚拉下来的服务端版本，incoming = 本地（含未推送改动）
 * 两边都把服务端那一版当 base，平局时都归到服务端的值，才不会来回翻。
 *
 * ── 孪生文件警告 ──
 *
 * 本文件的孪生是 `src/services/lww.ts`（服务端是 .mjs、客户端是 .ts，
 * 零依赖约束下没法共享源码）。**改这里必须同步改那边**，
 * 两侧各有一组字面量断言（server/smoke.mjs 与 scripts/client-sync-test.mjs）钉住行为。
 */

import { hlcAfter, hlcTimeOf, normHlc, recordHlc } from './hlc.mjs'

/**
 * 不参与字段级合并的键。
 * 身份（id / tripId）、以及时间戳本身（updatedAt / hlc / fhlc）都不是"内容字段"。
 */
export const MERGE_META_KEYS = new Set(['id', 'tripId', 'updatedAt', 'hlc', 'fhlc'])

/** 单条记录的字段戳上限（防御性：白名单外的键不会进映射，这里再兜一层） */
export const MAX_MERGE_FIELDS = 48

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

/** 把任意记录看成宽松视图（动态字段名只有运行期才知道） */
function loose(rec) {
  return rec ?? {}
}

/** 记录里参与合并的字段名 */
export function dataKeysOf(rec) {
  if (!rec || typeof rec !== 'object') return []
  return Object.keys(rec).filter((k) => !MERGE_META_KEYS.has(k))
}

/**
 * 取一条记录的**完整**字段戳映射。
 *
 * ⚠️ 映射里**显式列出**的字段直接用它的值，**不要**再套 `recordHlc` 之类的兜底。
 *
 * 这里踩过一次：若把 `fhlc[字段]` 与记录级 `updatedAt` 取较晚者，
 * 那么「只改了预算（H9）」的客户端，手里那个没动过的标题（H5）会被顶成 H9，
 * 反过来盖掉服务端上别人刚改的标题 —— 字段级合并反而比记录级更糟。
 * 兜底只该发生在**映射里根本没有**这个字段的时候。
 *
 * 映射里没有的字段退到记录级 hlc（= 旧的记录级 LWW 语义，老记录 / 老客户端走这条）。
 */
export function fieldHlcsOf(rec) {
  const recH = recordHlc(rec?.hlc, rec?.updatedAt ?? 0)
  const src = rec?.fhlc && typeof rec.fhlc === 'object' ? rec.fhlc : null
  const out = {}
  const keys = dataKeysOf(rec)
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
 * updatedAt 同步成同一个时刻，好让 `recordHlc(rec.hlc, rec.updatedAt)` 这个
 * 兜底口径两端一致、不打架。
 */
export function withRecordHlc(rec, stamp) {
  let max = null
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

/**
 * 逐字段合并。
 *
 * @param base     已有的那份（服务端 = 库里内容 / 客户端 = 刚拉下来的服务端版本）；
 *                 传 null 表示插入新记录
 * @param incoming 推过来的那份（服务端 = 客户端快照 / 客户端 = 本地含未推送改动）
 * @param cap      比较时的封顶函数（服务端传 clock 的封顶，客户端传恒等即可）
 * @returns {{ rec: object, fhlc: object, took: number, kept: number }}
 *   `took` = base 存在且有字段被 incoming 赢走（算一次 updated）
 *   `kept` = base 存在且有字段守住了（incoming 那份更旧）
 */
export function mergeRecord(base, incoming, cap = (h) => h) {
  const baseH = base ? fieldHlcsOf(base) : null
  const incH = incoming ? fieldHlcsOf(incoming) : {}
  const keys = new Set([...(baseH ? Object.keys(baseH) : []), ...Object.keys(incH)])

  // 起点是**两边字段的并集**，缺的一侧由另一侧补齐。
  //
  // ⚠️ 不能只按「数据字段」拼。`id` / `tripId` 这些元数据键不参与字段级比较，
  // 但它们是记录的**身份**，插入时必须从 incoming 带过来 ——
  // 早先写成「base 为空就从空对象开始按数据字段填」，结果新建的记录全都没有 id，
  // 落库时直接报 SQLite 参数绑定失败。
  const out = { ...loose(incoming), ...(base ? loose(base) : {}) }
  const stamp = {}
  let took = 0
  let kept = 0

  for (const k of keys) {
    const inc = incH[k] ? cap(incH[k]) : null
    const cur = baseH && baseH[k] ? cap(baseH[k]) : null

    // 严格更晚才赢；相等保留 base —— 见文件头的「平局口径」。
    if (inc && (!cur || hlcAfter(inc, cur))) {
      // 值和戳必须同进退：incoming 时间赢、但记录体里没带这个键时，值只能留
      // base 的旧值，戳也必须一起留 —— 若只顶戳，会「新戳守着旧值」，
      // 后续对这一格的编辑按戳判负而被悄悄吞掉（戳值脱钩）。
      const hasBodyKey = loose(incoming) && hasOwn(incoming, k)
      if (hasBodyKey) {
        out[k] = loose(incoming)[k]
        stamp[k] = incH[k]
        if (cur) took += 1
      } else {
        stamp[k] = baseH?.[k] ?? incH[k]
        if (inc) kept += 1
      }
    } else {
      stamp[k] = baseH[k]
      if (inc) kept += 1
    }
  }

  return { rec: withRecordHlc(out, stamp), fhlc: stamp, took, kept }
}
