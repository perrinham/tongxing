/**
 * 混合逻辑时钟（HLC）—— 云函数侧的 CommonJS 移植。
 *
 * 孪生文件链（改 HLC 逻辑时四处必须同步）：
 *   1. server/lib/hlc.mjs    （自托管参考实现）
 *   2. src/services/hlc.ts    （客户端）
 *   3. cloudfunctions/_lib/hlc.js （云函数，本文件）
 *   4. 各云函数目录里的 _lib/hlc.js 副本（由 scripts/cloud-lib-sync.mjs 生成，勿手改）
 *
 * 语义说明见 server/lib/hlc.mjs 的文件头。
 */

const { createHash } = require('crypto')

const T_DIGITS = 15
const C_DIGITS = 6
const NODE_CHARS = 8

const MAX_T = 999_999_999_999_999
const MAX_C = 999_999

/** 老记录的占位节点号：全零在字典序上排最前，「同毫秒同计数时旧格式让位给新格式」 */
const LEGACY_NODE = '00000000'

function nodeKey(nodeId) {
  return createHash('sha1')
    .update(String(nodeId ?? ''))
    .digest('hex')
    .slice(0, NODE_CHARS)
}

function normalizeNode(n) {
  const s = String(n ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase()
    .slice(0, NODE_CHARS)
  return s.padEnd(NODE_CHARS, '0')
}

function clampInt(v, min, max) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return min
  return Math.min(Math.max(n, min), max)
}

function hlcFromTs(ts) {
  return { t: clampInt(ts, 0, MAX_T), c: 0, n: LEGACY_NODE }
}

function normHlc(raw, fallbackTs = 0) {
  if (raw && typeof raw === 'object' && Number.isFinite(Number(raw.t))) {
    return {
      t: clampInt(raw.t, 0, MAX_T),
      c: clampInt(raw.c ?? 0, 0, MAX_C),
      n: normalizeNode(raw.n)
    }
  }
  return hlcFromTs(fallbackTs)
}

function encodeHlc(h) {
  const t = clampInt(h && h.t, 0, MAX_T)
  const c = clampInt(h && h.c != null ? h.c : 0, 0, MAX_C)
  return `${String(t).padStart(T_DIGITS, '0')}-${String(c).padStart(C_DIGITS, '0')}-${normalizeNode(h && h.n)}`
}

function decodeHlc(key) {
  const m = /^(\d+)-(\d+)-([0-9a-f]{8})$/.exec(String(key ?? ''))
  if (!m) return hlcFromTs(0)
  return { t: Number(m[1]), c: Number(m[2]), n: m[3] }
}

function cmpHlc(a, b) {
  const x = normHlc(a, 0)
  const y = normHlc(b, 0)
  if (x.t !== y.t) return x.t < y.t ? -1 : 1
  if (x.c !== y.c) return x.c < y.c ? -1 : 1
  if (x.n === y.n) return 0
  return x.n < y.n ? -1 : 1
}

function hlcAfter(a, b) {
  return cmpHlc(a, b) > 0
}

function maxHlc(a, b) {
  return cmpHlc(a, b) >= 0 ? normHlc(a, 0) : normHlc(b, 0)
}

function hlcTimeOf(h) {
  return clampInt(h && h.t, 0, MAX_T)
}

function recordHlc(raw, updatedAt) {
  return maxHlc(normHlc(raw, updatedAt), hlcFromTs(updatedAt))
}

function capHlc(h, now, skewMs) {
  const x = normHlc(h, 0)
  const upper = now + skewMs
  if (x.t <= upper) return x
  return { t: upper, c: x.c, n: x.n }
}

function createHlc({ node = 'server', maxSkewMs = 60_000 } = {}) {
  const selfNode = nodeKey(node)
  let lastT = 0
  let lastC = 0

  function cap(h) {
    return capHlc(h, Date.now(), maxSkewMs)
  }

  function observe(raw, fallbackTs = 0) {
    const h = normHlc(raw, fallbackTs)
    const upper = Date.now() + maxSkewMs
    const skewed = h.t > upper
    const t = skewed ? upper : h.t
    if (t > lastT) {
      lastT = t
      lastC = h.c
    } else if (t === lastT && h.c > lastC) {
      lastC = h.c
    }
    return { skewed }
  }

  function stamp() {
    const phys = Date.now()
    if (phys > lastT) {
      lastT = phys
      lastC = 0
    } else {
      lastC += 1
      if (lastC > MAX_C) {
        lastT += 1
        lastC = 0
      }
    }
    return { t: lastT, c: lastC, n: selfNode }
  }

  return {
    node: selfNode,
    maxSkewMs,
    cap,
    observe,
    stamp,
    peek: () => ({ t: lastT, c: lastC, n: selfNode })
  }
}

module.exports = {
  LEGACY_NODE,
  nodeKey,
  hlcFromTs,
  normHlc,
  encodeHlc,
  decodeHlc,
  cmpHlc,
  hlcAfter,
  maxHlc,
  hlcTimeOf,
  recordHlc,
  capHlc,
  createHlc
}