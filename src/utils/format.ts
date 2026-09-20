import type { ExpenseCategory, ItemType } from '@/types'

/**
 * 画布 / 原生地图必须用字面色值的颜色 —— **theme.css 的唯一镜像**。
 *
 * 为什么不能直接引用 CSS 变量：
 *   · `poster.ts` 走 canvas 的 `ctx.fillStyle`，只吃具体色值；
 *   · 微信原生 `<map>` 的 `marker.label.bgColor` / `polyline.color`
 *     是把值透传给原生渲染层的，CSS 变量在那里解析不了。
 * 所以这些地方必然有硬编码。为了不让它变成「第二套色板」，全部集中在这里，
 * 并且**必须与 `src/styles/theme.css` 保持同值**。改令牌时回来改这里。
 *
 * 历史坑：这里原本散着 5 处 `#1D9E75`，与品牌令牌 `#1FA470` 几乎是同一个绿但不是 ——
 * 屏幕上就是「同一个绿有两块略有色差」，看着像渲染 bug。已统一。
 */
export const CANVAS_PALETTE = {
  /** = --brand */
  brand: '#1FA470',
  /** = --brand-deep */
  brandDeep: '#12724F',
  /** = --accent */
  accent: '#E8714A',
  /** = --accent-deep —— 浅底上的强调橙**文字**用它，别用 accent（3.05 → 6.17:1） */
  accentDeep: '#AB3D07',
  /** = --warn */
  warn: '#C77E1A',
  /** = --warn-deep —— 浅底上的琥珀**文字**用它（3.27 → 5.77:1） */
  warnDeep: '#91590A',
  /** = --danger —— 已按「最差浅底」反推过，文字与白字底两种角色都能用 */
  danger: '#B01F16',
  /** = --bg-page */
  bgPage: '#F2F2F7',
  /** = --bg-card */
  bgCard: '#FFFFFF',
  /** = --bg-subtle */
  bgSubtle: '#E9E9EB',
  /** = --text-inverse —— 压在语义色/深色底上的**文字**用它（海报品牌带上的白字）。
      别拿 `bgCard` 顶 —— 那是「卡片底」的角色，两者今天同为白，但改一个不该牵动另一个。 */
  textInverse: '#FFFFFF',
  /** = --text-primary */
  textPrimary: '#1C1C1E',
  /** = --text-secondary */
  textSecondary: '#66666E',
  /** = --text-tertiary */
  textTertiary: '#9C9CA1'
} as const

/** 金额格式化：1234.5 -> ¥1,234.50 */
export function money(n: number, currency = '¥', withSymbol = true): string {
  const v = Number.isFinite(n) ? n : 0
  const neg = v < 0
  const abs = Math.abs(v)
  const fixed = abs.toFixed(2)
  const [int, dec] = fixed.split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = dec === '00' ? grouped : `${grouped}.${dec}`
  const sym = withSymbol ? currency : ''
  return `${neg ? '-' : ''}${sym}${body}`
}

/** 精简金额：用于卡片列表，整数不显示小数 */
export function moneyBrief(n: number, currency = '¥'): string {
  const v = Number.isFinite(n) ? n : 0
  const neg = v < 0
  const abs = Math.abs(v)
  const rounded = Math.round(abs * 100) / 100
  const body = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
  return `${neg ? '-' : ''}${currency}${body}`
}

/** 2026-09-16 -> 09/16 */
export function shortDate(iso: string): string {
  if (!iso) return ''
  const parts = iso.split('-')
  if (parts.length < 3) return iso
  return `${parts[1]}/${parts[2]}`
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function weekday(iso: string): string {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return ''
  return WEEK[d.getDay()]
}

/** 计算两个日期之间的天数（含首尾） */
export function daysBetween(start: string, end: string): number {
  if (!start || !end) return 1
  const a = new Date(`${start}T00:00:00`).getTime()
  const b = new Date(`${end}T00:00:00`).getTime()
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 1
  return Math.round((b - a) / 86400000) + 1
}

/** 日期加 n 天，返回 ISO 日期字符串 */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + n)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 距离出行还有几天，负数表示已出行 */
export function daysUntil(iso: string): number {
  const a = new Date(`${todayISO()}T00:00:00`).getTime()
  const b = new Date(`${iso}T00:00:00`).getTime()
  return Math.round((b - a) / 86400000)
}

export const CATEGORY_META: Record<ExpenseCategory, { label: string; color: string; bg: string; icon: string }> = {
  food: { label: '餐饮', color: 'var(--cat-food)', bg: 'var(--cat-food-bg)', icon: 'food' },
  transport: { label: '交通', color: 'var(--cat-transport)', bg: 'var(--cat-transport-bg)', icon: 'transport' },
  stay: { label: '住宿', color: 'var(--cat-stay)', bg: 'var(--cat-stay-bg)', icon: 'stay' },
  ticket: { label: '门票', color: 'var(--cat-ticket)', bg: 'var(--cat-ticket-bg)', icon: 'ticket' },
  shopping: { label: '购物', color: 'var(--cat-shopping)', bg: 'var(--cat-shopping-bg)', icon: 'shopping' },
  entertain: { label: '娱乐', color: 'var(--cat-entertain)', bg: 'var(--cat-entertain-bg)', icon: 'entertain' },
  other: { label: '其他', color: 'var(--cat-other)', bg: 'var(--cat-other-bg)', icon: 'other' }
}

/**
 * 分类色的**字面值**镜像（= theme.css 的 `--cat-*`）。canvas / 原生地图用这个。
 *
 * ⚠️ 为什么必须有这份：`CATEGORY_META[x].color` 是 `'var(--cat-food)'` 这样的字符串。
 * 它在 DOM 里没问题（浏览器解析 var ），但 `ctx.fillStyle = 'var(--cat-food)'` 是
 * **非法值，会被 canvas 静默忽略** —— fillStyle 保持不变，于是海报上所有分类圆点和条形
 * 都变成同一个颜色（沿用上一处设过的色）。这是个静默失败，不报错、只是颜色不对。
 *
 * 所以：**canvas / 原生地图用这里，DOM 用 `CATEGORY_META`。**
 * 两边必须同值 —— `npm run check:tokens` 会校验（`scripts/check-token-sync.mjs`）。
 */
export const CANVAS_CATEGORY_COLORS: Record<ExpenseCategory, string> = {
  food: '#E8590C',
  transport: '#0B6BCB',
  stay: '#5856D6',
  ticket: '#0E8FA8',
  shopping: '#D6336C',
  entertain: '#9333C9',
  other: '#7A7A80'
}

export const CATEGORY_ORDER: ExpenseCategory[] = [
  'food',
  'transport',
  'stay',
  'ticket',
  'shopping',
  'entertain',
  'other'
]

export const ITEM_TYPE_META: Record<ItemType, { label: string; color: string; bg: string }> = {
  spot: { label: '景点', color: 'var(--cat-ticket)', bg: 'var(--cat-ticket-bg)' },
  food: { label: '餐饮', color: 'var(--cat-food)', bg: 'var(--cat-food-bg)' },
  transport: { label: '交通', color: 'var(--cat-transport)', bg: 'var(--cat-transport-bg)' },
  stay: { label: '住宿', color: 'var(--cat-stay)', bg: 'var(--cat-stay-bg)' },
  other: { label: '其他', color: 'var(--cat-other)', bg: 'var(--cat-other-bg)' }
}

export const ITEM_TYPE_ORDER: ItemType[] = ['spot', 'food', 'transport', 'stay', 'other']

/**
 * 数据驱动的 META 取用一律走这两个助手，不要直接 `META[x]`。
 *
 * 同步进来的记录可能带着「未来客户端才有的枚举值」（别人用新版本推了新分类，
 * 旧客户端的 META 表里没有这个键）—— 直接取会 undefined 解引用，页面白屏。
 * 认不出的枚举一律回退 other（文案「其他」+ 中性色，语义上也不算错得离谱）。
 * 选择器里用 `META[key]` 循环自身键集的写法（ExpenseEditPage / ItemEditPage）是安全的，不用换。
 */
export function itemMetaOf(type: string): { label: string; color: string; bg: string } {
  return ITEM_TYPE_META[type as ItemType] || ITEM_TYPE_META.other
}

export function categoryMetaOf(cat: string): { label: string; color: string; bg: string; icon: string } {
  return CATEGORY_META[cat as ExpenseCategory] || CATEGORY_META.other
}

/** 头像色块 —— **身份色**，与语义色 / 分类色是两套东西，按成员序号取模轮换。
 *
 *  ⚠️ 改这个数组 = 改所有人的头像颜色（颜色由序号决定，不是数据）。
 *
 *  【为什么 `[0]` 定成品牌色】「我」= 品牌绿是有意的映射（自己的头像和底栏选中态同色），
 *  所以 `check-token-sync.mjs` 里有一条断言守着 `AVATAR_COLORS[0] === CANVAS_PALETTE.brand`。
 *
 *  【已知边界（量化过，别再凭感觉说要「重挑」）】`node scripts/check-palette.mjs` 会打出这张表：
 *    · 两两最挤：`#378ADD ↔ #185FA5` ΔE = 17.7 —— 略低于苹果自家最挤的一对（19.6），
 *      但这两个蓝在列表里并排也没到「分不清」的程度（ΔE > 10）。
 *    · 离最近语义色/分类色 < 12 的有三项：`#D85A30`(vs accent 9.5)、
 *      `#BA7517`(vs warn 4.8)、`#0F6E56`(vs brandDeep 6.0)。
 *    · 但这些**不构成实际混淆**：头像在界面上永远是「实心圆 + 初始字」，
 *      分类色是「浅色圆角方 + 描边图标」，形状与位置都不同；
 *      而同屏出现时真正影响观感的是**初始字能不能看清** —— 那个问题已由 `avatarInk` 解决。
 *    · 结论：**不要为了追求 ΔE 数字好看去重挑这套色**（代价是变成一堆深浊色，更难看）。
 *      真要动，先用 `scripts/search-palette.mjs` 的约束试算，拿数字说话。 */
export const AVATAR_COLORS = [
  CANVAS_PALETTE.brand,
  '#378ADD',
  '#7F77DD',
  '#D85A30',
  '#D4537E',
  '#BA7517',
  '#639922',
  '#0F6E56',
  '#993C1D',
  '#185FA5'
]

export function avatarColor(index: number): string {
  return AVATAR_COLORS[index % AVATAR_COLORS.length]
}

/** WCAG 相对亮度（sRGB 线性化后加权）。3 位缩写色也认。 */
function relLuminance(hex: string): number {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const chan = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(chan[0]) + 0.7152 * lin(chan[1]) + 0.0722 * lin(chan[2])
}

/**
 * 头像初始字该用什么颜色 —— 在「白」与「黑」里取对比度更高的那个。
 *
 * 【为什么不能一律白字】头像上的字只有 `size × 0.42`（32px 头像 → 13px），
 * 属 WCAG 的**小字**，要 **4.5:1** 才算 AA。而 10 个身份色里 **7 个压白字只有 3.18 ~ 3.93:1**
 * （最差是品牌绿 `#1FA470` 的 3.18:1）—— 手机上就是「糊」，但不会报错。
 *
 * 【为什么是「白/黑」而不是「白/深灰」】这个二选一能给出一条**与底色无关的下界**：
 * 设底色相对亮度为 Y，则 c白 = 1.05/(Y+0.05)、c黑 = (Y+0.05)/0.05；
 * 两者相等时 (Y+0.05)² = 1.05 × 0.05 → Y+0.05 = 0.2291 → 两边都是 **4.58:1**。
 * 于是**不管以后往 AVATAR_COLORS 里塞什么颜色**，取较大者都必然 ≥ 4.58:1，天然过 AA。
 * 若换成 `#1C1C1E` 这种深灰，下界会掉到 4.11 —— 正好压线不过，所以这里必须是纯黑。
 */
export function avatarInk(bg: string): string {
  const Y = relLuminance(bg)
  return (Y + 0.05) / 0.05 >= 1.05 / (Y + 0.05) ? '#000000' : '#FFFFFF'
}

/** 耗时格式化：90 -> 1.5h */
export function durationText(min: number): string {
  if (!min) return ''
  if (min < 60) return `${min}分钟`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h}.${Math.round((m / 60) * 10)}小时` : `${h}小时`
}

/** 根据时长推算结束时间 */
export function endTime(start: string, min: number): string {
  if (!start || !min) return ''
  const [h, m] = start.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return ''
  const total = h * 60 + m + min
  const hh = String(Math.floor(total / 60) % 24).padStart(2, '0')
  const mm = String(total % 60).padStart(2, '0')
  return `${hh}:${mm}`
}
