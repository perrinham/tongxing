/**
 * 校验与清洗工具（白名单式写入）—— 云函数侧的 CommonJS 移植。
 *
 * 孪生文件链：
 *   1. server/lib/util.mjs      （自托管参考实现）
 *   2. cloudfunctions/_lib/util.js （云函数，本文件）
 *   3. 各云函数目录里的 _lib/util.js 副本（由 scripts/cloud-lib-sync.mjs 生成，勿手改）
 *
 * 设计原则与 server/lib/util.mjs 文件头一致：白名单写入、防原型污染。
 */

const { randomInt } = require('crypto')

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function safeDecode(raw) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isSafeId(v) {
  return typeof v === 'string' && !BAD_KEYS.has(v) && ID_RE.test(v)
}

function str(v, max, fallback = '') {
  if (typeof v !== 'string') return fallback
  const t = v.replace(/\u0000/g, '').trim()
  return t.length > max ? t.slice(0, max) : t
}

function wasTruncated(v, max) {
  return typeof v === 'string' && v.replace(/\u0000/g, '').trim().length > max
}

function int(v, min, max, fallback = null) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  const i = Math.round(n)
  return i < min || i > max ? fallback : i
}

function num(v, min, max, fallback = 0) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function bool(v) {
  return v === true
}

function oneOf(v, list, fallback = null) {
  return list.includes(v) ? v : fallback
}

function isoDate(v, fallback = '') {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback
}

const MIN_TS = 946684800000
const MAX_TS = () => Date.now() + 86400000
function ts(v, fallback = Date.now()) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  const i = Math.round(n)
  return i < MIN_TS || i > MAX_TS() ? fallback : i
}

function strArray(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return []
  const out = []
  const seen = new Set()
  for (const item of v) {
    if (typeof item !== 'string') continue
    const s = str(item, maxLen)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= maxItems) break
  }
  return out
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function makeCode(len = 6) {
  let s = ''
  for (let i = 0; i < len; i += 1) {
    s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  }
  return s
}

function normalizeCode(v) {
  const s = str(v, 16).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return s.length >= 4 && s.length <= 12 ? s : ''
}

function shortHash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

module.exports = {
  BAD_KEYS,
  safeDecode,
  isPlainObject,
  isSafeId,
  str,
  wasTruncated,
  int,
  num,
  bool,
  oneOf,
  isoDate,
  ts,
  strArray,
  makeCode,
  normalizeCode,
  shortHash
}