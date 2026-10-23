/**
 * 字段级 LWW 合并（last-write-wins per field）—— 云函数侧的 CommonJS 移植。
 *
 * 孪生文件链（改 LWW 逻辑时四处必须同步）：
 *   1. server/lib/lww.mjs     （自托管参考实现）
 *   2. src/services/lww.ts    （客户端）
 *   3. cloudfunctions/_lib/lww.js （云函数，本文件）
 *   4. 各云函数目录里的 _lib/lww.js 副本（由 scripts/cloud-lib-sync.mjs 生成，勿手改）
 *
 * 语义说明（平局口径、fhlc 必须完整、withRecordHlc 推导规则）见 server/lib/lww.mjs 文件头。
 */

const { hlcAfter, hlcTimeOf, normHlc, recordHlc } = require('./hlc')

const MERGE_META_KEYS = new Set(['id', 'tripId', 'updatedAt', 'hlc', 'fhlc'])
const MAX_MERGE_FIELDS = 48

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

function loose(rec) {
  return rec ?? {}
}

function dataKeysOf(rec) {
  if (!rec || typeof rec !== 'object') return []
  return Object.keys(rec).filter((k) => !MERGE_META_KEYS.has(k))
}

function fieldHlcsOf(rec) {
  const recH = recordHlc(rec && rec.hlc, (rec && rec.updatedAt) || 0)
  const src = rec && rec.fhlc && typeof rec.fhlc === 'object' ? rec.fhlc : null
  const out = {}
  const keys = dataKeysOf(rec)
  for (let i = 0; i < keys.length && i < MAX_MERGE_FIELDS; i += 1) {
    const k = keys[i]
    const own = src ? src[k] : null
    const t = Number(own && own.t)
    out[k] = own && Number.isFinite(t) && t > 0 ? normHlc(own, 0) : recH
  }
  return out
}

function withRecordHlc(rec, stamp) {
  let max = null
  for (const k of Object.keys(stamp)) {
    const h = stamp[k]
    if (!h) continue
    if (!max || hlcAfter(h, max)) max = h
  }
  const out = Object.assign({}, rec, { fhlc: stamp })
  if (max) {
    out.hlc = max
    out.updatedAt = hlcTimeOf(max)
  }
  return out
}

function mergeRecord(base, incoming, cap = (h) => h) {
  const baseH = base ? fieldHlcsOf(base) : null
  const incH = incoming ? fieldHlcsOf(incoming) : {}
  const keys = new Set([...(baseH ? Object.keys(baseH) : []), ...Object.keys(incH)])

  const out = Object.assign({}, loose(incoming), base ? loose(base) : {})
  const stamp = {}
  let took = 0
  let kept = 0

  for (const k of keys) {
    const inc = incH[k] ? cap(incH[k]) : null
    const cur = baseH && baseH[k] ? cap(baseH[k]) : null

    if (inc && (!cur || hlcAfter(inc, cur))) {
      const hasBodyKey = loose(incoming) && hasOwn(incoming, k)
      if (hasBodyKey) {
        out[k] = loose(incoming)[k]
        stamp[k] = incH[k]
        if (cur) took += 1
      } else {
        stamp[k] = baseH && baseH[k] ? baseH[k] : incH[k]
        if (inc) kept += 1
      }
    } else {
      stamp[k] = baseH[k]
      if (inc) kept += 1
    }
  }

  return { rec: withRecordHlc(out, stamp), fhlc: stamp, took, kept }
}

module.exports = {
  MERGE_META_KEYS,
  MAX_MERGE_FIELDS,
  dataKeysOf,
  fieldHlcsOf,
  withRecordHlc,
  mergeRecord
}