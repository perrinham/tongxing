/**
 * 校验与清洗工具。
 *
 * 设计原则：**白名单式写入**。
 * 任何来自请求体的字段，先经过这里做「类型 + 范围 + 长度」归一，
 * 未在白名单内的键一律丢弃，杜绝脏字段与原型污染落库。
 */

import { randomInt } from 'node:crypto'

/** 原型污染高危键：即使形如合法 id 也必须拒绝 */
export const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** decodeURIComponent 遇到畸形 % 序列会抛异常 —— 包一层，避免整个进程 500 */
export function safeDecode(raw) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

export function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 安全 id：字符集白名单 + 长度上限 + 拒绝原型污染键 */
export function isSafeId(v) {
  return typeof v === 'string' && !BAD_KEYS.has(v) && ID_RE.test(v)
}

/** 字符串归一：去 NUL、trim、按上限截断；非字符串回落到 fallback */
export function str(v, max, fallback = '') {
  if (typeof v !== 'string') return fallback
  const t = v.replace(/\u0000/g, '').trim()
  return t.length > max ? t.slice(0, max) : t
}

/** 是否因为超长被截断（用于给调用方回一个 warnings） */
export function wasTruncated(v, max) {
  return typeof v === 'string' && v.replace(/\u0000/g, '').trim().length > max
}

/** 整数归一：非数字 / 越界均回落 fallback */
export function int(v, min, max, fallback = null) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  const i = Math.round(n)
  return i < min || i > max ? fallback : i
}

/** 浮点归一 */
export function num(v, min, max, fallback = 0) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function bool(v) {
  return v === true
}

/** 枚举归一 */
export function oneOf(v, list, fallback = null) {
  return list.includes(v) ? v : fallback
}

/** YYYY-MM-DD */
export function isoDate(v, fallback = '') {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback
}

/** 时间戳归一：毫秒，合理区间内才接受（2000-01-01 ~ 现在 + 1 天） */
const MIN_TS = 946684800000
const MAX_TS = () => Date.now() + 86400000
export function ts(v, fallback = Date.now()) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  const i = Math.round(n)
  return i < MIN_TS || i > MAX_TS() ? fallback : i
}

/** 字符串数组归一（去重、限量、过滤非字符串） */
export function strArray(v, maxItems, maxLen) {
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

/** 分享码字符集：剔除易混的 I / O / 0 / 1 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function makeCode(len = 6) {
  let s = ''
  for (let i = 0; i < len; i += 1) {
    // 分享码=写权凭据，用 CSPRNG：Math.random 的内部状态可由连续输出反推
    s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  }
  return s
}

/** 常规分享码：6 位，输入时忽略大小写与空格 */
export function normalizeCode(v) {
  const s = str(v, 16).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return s.length >= 4 && s.length <= 12 ? s : ''
}

/** 稳定哈希（用于日志里区分设备，避免明文记录） */
export function shortHash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}
