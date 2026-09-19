/**
 * 分类色板体检脚本（纯 Node，零依赖）
 *
 * 用途：给「分类色」候选色板做客观检查，避免靠肉眼估色。
 *
 * 三项检查：
 *   ① 分类色 vs 语义色（品牌/强调/警示/危险）—— 分类色不该抢语义色的位置
 *   ② 分类色两两之间 —— 7 个分类要能一眼分开
 *   ③ 同色文字/图标压在同色浅底上的对比度
 *
 * 跑法：node scripts/check-palette.mjs
 *
 * ⚠️ 阈值不是拍脑袋定的，两个标尺都打在输出里：
 *   · ΔE 标尺 = 苹果自家 iOS 系统色两两之间的最小距离（见「参照」一节）
 *   · 对比度标尺 = WCAG 1.4.11「非文本/UI 组件」3:1，和 1.4.3 正文 4.5:1
 *     （Apple 的 systemBlue #007AFF 压白底只有 3.6:1，所以 4.5 是比苹果自己更严的标准）
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseThemeTokens,
  coverageLine,
  assertNoUnparsedOpaque,
  assertRequired
} from './lib/theme-tokens.mjs'

// ── sRGB → Lab（D65）────────────────────────────────────────
function srgbToLinear(c) {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function hexToLab(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear)
  const X = r * 0.4124564 + g * 0.3575761 + b * 0.1804375
  const Y = r * 0.2126729 + g * 0.7151522 + b * 0.072175
  const Z = r * 0.0193339 + g * 0.119192 + b * 0.9503041
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(X / 0.95047)
  const fy = f(Y / 1.0)
  const fz = f(Z / 1.08883)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function deltaE(hex1, hex2) {
  const a = hexToLab(hex1)
  const b = hexToLab(hex2)
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)
}

function relLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(hex1, hex2) {
  const l1 = relLuminance(hex1)
  const l2 = relLuminance(hex2)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

function hue(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return 0
  let h
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return Math.round(((h * 60) % 360 + 360) % 360)
}

// ── 先读 theme.css ───────────────────────────────────────────
const ROOT = process.cwd()

// 分类色的 7 个槽位（下面覆盖率检查与色板定义都要用，所以放在最前）
const ORDER = ['food', 'transport', 'stay', 'ticket', 'shopping', 'entertain', 'other']
const LABEL = { food: '餐饮', transport: '交通', stay: '住宿', ticket: '门票', shopping: '购物', entertain: '娱乐', other: '其他' }

/* ── 解析覆盖率：**紧解析** vs **松扫描** ────────────────────────
 *
 * 这个脚本的颜色**全部**来自 `parseCssVars`，而它只认十六进制（`#[0-9A-Fa-f]{3,8}`）。
 * 「同一个颜色的第二种拼写」在这里造成的后果**比漏检更糟**：
 *
 *   `--cat-food: rgb(232, 89, 12);`（= `#E8590C`，视觉上一模一样）
 *     → 紧解析收不到 → `LIVE.food.color` 回退成 **`#000000`**
 *     → 黑离谁都远，三项数字**全部变好看**（实测 ΔE 23.5 → 38.5、对比度 3.09 → 3.31）
 *     → 真实越界被这份「更好的报告」盖过去，退出码还是 0
 *
 * 这就是本脚本最危险的一处静默。所以两步都做：
 *   1. **本脚本消费的每一个令牌都必须解析到**，少一个直接 exit 1，绝不回退默认值；
 *   2. 顺手把「松扫描看到、紧解析没收走」的声明记账 —— 漂移要看得见，
 *      哪怕今天它没被本脚本用到（比如带 alpha 的 `--hairline`）。
 *
 * 解析与断言本体已经抽到 `scripts/lib/theme-tokens.mjs`（三个闸门共用一份），
 * 这里只留「本脚本依赖哪些令牌」这一份清单。
 */
const { tokens: VARS, decls: DECLS, missed: MISSED } = parseThemeTokens(ROOT)
const REQUIRED = [
  // 语义色（SEMANTIC + ⑤ 的 -deep）
  '--brand', '--brand-deep', '--accent', '--accent-deep', '--warn', '--warn-deep', '--danger',
  // 浅底（⑤ 算「自身 soft 底」）
  '--brand-soft', '--accent-soft', '--warn-soft',
  // 底色基准（⑤ 的「白卡 / 页面底 / bg-subtle」三档）
  '--bg-page', '--bg-subtle',
  // 分类色 7 组 ×（主色 + 浅底）
  ...ORDER.flatMap((k) => [`--cat-${k}`, `--cat-${k}-bg`])
]
assertNoUnparsedOpaque(MISSED, '色板体检')
assertRequired(VARS, REQUIRED, '色板体检')

// 一行带过，别在报告头上堆常驻噪声；它存在的意义是「漂移要看得见」
const COVERAGE_LINE = `  （${coverageLine(DECLS, MISSED, REQUIRED.length)}）`

// ── 色板定义 ─────────────────────────────────────────────────
/**
 * 语义色 —— **从 theme.css 解析，不写死**。
 *
 * 和下面 LIVE 是同一个教训：这份表原来是一串字面量快照，
 * 于是把 `--danger` 从 #E03B30 调深到 #C9261A、把 `--brand-deep` 调到 #12724F 之后，
 * 脚本还在按旧值算「分类色离语义色有多远」—— 审计脚本一旦漂移，比没有更糟。
 */
const SEMANTIC = {
  brand: { c: VARS['--brand'], label: '品牌绿' },
  'brand-deep': { c: VARS['--brand-deep'], label: '品牌深绿' },
  accent: { c: VARS['--accent'], label: '强调橙' },
  warn: { c: VARS['--warn'], label: '警示琥珀' },
  danger: { c: VARS['--danger'], label: '危险红' }
}

/** 历史基线：iOS 改版前那一版分类色板。**故意写成死数据** —— 它就是「过去」，
 *  不跟着 theme.css 变，这样「改善了多少」这个对比才永远成立。 */
const BEFORE = {
  food: { color: '#E8714A', bg: '#FDEEE7' },
  transport: { color: '#3B82D6', bg: '#E7F1FB' },
  stay: { color: '#7D76DB', bg: '#EEEDFC' },
  ticket: { color: '#1FA470', bg: '#E4F5EE' },
  shopping: { color: '#D6547E', bg: '#FBEAF0' },
  entertain: { color: '#C77E1A', bg: '#FDF3E1' },
  other: { color: '#9C9CA1', bg: '#EFEFF1' }
}

/**
 * 当前生效的分类色板 —— **从 theme.css 解析，不写死**。
 *
 * 教训：这个脚本的第一版把「候选色板」写成字面量，色板落地后脚本还停在旧提案上，
 * 于是 `palette:audit` 报的是一份已经不存在的色板 —— **审计脚本一旦漂移，比没有更糟**。
 */
const LIVE = {}
for (const k of ORDER) {
  LIVE[k] = { color: VARS[`--cat-${k}`] || '#000000', bg: VARS[`--cat-${k}-bg`] || '#FFFFFF' }
}

/**
 * 身份色（头像）—— 从 format.ts 解析，第一项是 `CANVAS_PALETTE.brand` 引用。
 * 头像初始字是小字（32px 头像 → 13px），AA 要 4.5:1，所以重点看墨色对比度。
 */
function parseAvatars() {
  const src = readFileSync(join(ROOT, 'src/utils/format.ts'), 'utf8')
  const start = src.indexOf('export const AVATAR_COLORS')
  const body = src.slice(start, src.indexOf(']', start))
  return [...body.matchAll(/(CANVAS_PALETTE\.brand|'#([0-9A-Fa-f]{6})')/g)].map((m) =>
    m[1] === 'CANVAS_PALETTE.brand' ? VARS['--brand'] : `#${m[2].toUpperCase()}`
  )
}
const AVATARS = parseAvatars()

/** 与 format.ts 的 avatarInk() 同一条规则：白/黑取对比度更高者 */
function inkOf(bg) {
  const Y = relLuminance(bg)
  const onWhite = 1.05 / (Y + 0.05)
  const onBlack = (Y + 0.05) / 0.05
  return onBlack >= onWhite
    ? { ink: '#000000', c: onBlack, other: onWhite }
    : { ink: '#FFFFFF', c: onWhite, other: onBlack }
}

function checkIdentity() {
  console.log('\n\n############ ④ 身份色（头像）体检 ############')
  console.log('  —— 初始字是小字（32px 头像 → 13px），AA 要 4.5:1；白/黑取高者后下界 4.58:1')
  let worstChosen = { c: Infinity, bg: '' }
  let worstWhite = { c: Infinity, bg: '' }
  for (const bg of AVATARS) {
    const { ink, c, other } = inkOf(bg)
    const white = ink === '#FFFFFF' ? c : other
    if (c < worstChosen.c) worstChosen = { c, bg }
    if (white < worstWhite.c) worstWhite = { c: white, bg }
    console.log(
      `  ${bg}  取${ink === '#000000' ? '黑字' : '白字'} ${c.toFixed(2)}:1 ${c >= 4.5 ? '✓ AA' : '⚠'}   ` +
        `（另一种只有 ${other.toFixed(2)}:1${other < 4.5 ? ' ✗' : ''}）`
    )
  }
  console.log(`  → 按底色选墨色：最差 ${worstChosen.c.toFixed(2)}:1（${worstChosen.bg}）全部过 AA`)
  console.log(
    `  → 若一律白字：  最差 ${worstWhite.c.toFixed(2)}:1（${worstWhite.bg}）` +
      `${worstWhite.c >= 4.5 ? '' : ' ✗ 低于 AA 4.5:1'} ← 这就是修之前的状况`
  )

  let worst = { d: Infinity, pair: '' }
  for (let i = 0; i < AVATARS.length; i++) {
    for (let j = i + 1; j < AVATARS.length; j++) {
      const d = deltaE(AVATARS[i], AVATARS[j])
      if (d < worst.d) worst = { d, pair: `${AVATARS[i]} ↔ ${AVATARS[j]}` }
    }
  }
  console.log(`\n  两两最挤：${worst.pair}  ΔE=${worst.d.toFixed(1)}（苹果自家最挤的一对是 19.6）`)

  const reserved = {
    ...Object.fromEntries(Object.entries(SEMANTIC).map(([k, v]) => [v.label, v.c])),
    ...Object.fromEntries(ORDER.map((k) => [LABEL[k], LIVE[k].color]))
  }
  console.log('  离最近的「语义色 / 分类色」：')
  for (const bg of AVATARS) {
    let best = { d: Infinity, k: '' }
    for (const [k, c] of Object.entries(reserved)) {
      const d = deltaE(bg, c)
      if (d < best.d) best = { d, k }
    }
    const tag = best.d < 10 ? '⚠ 几乎同色' : best.d < 20 ? '△ 同屏会混' : '✓'
    console.log(`    ${bg}  ← ${pad(best.k, 6)} ${reserved[best.k]}  ΔE=${best.d.toFixed(1)}  ${tag}`)
  }
  console.log(
    '\n  结论口径：头像永远是「实心圆 + 初始字」，分类色是「浅色圆角方 + 描边图标」，' +
      '\n  形状与位置都不同，所以 ΔE < 20 不构成实际混淆 —— 别为了数字好看把它们重挑成一堆深浊色。'
  )
}


// ── 检查函数 ─────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n, '　')

function checkSemantic(name, pal, threshold) {
  console.log(`\n═══ ① 分类色 vs 语义色（ΔE 阈值 ${threshold}）—— ${name} ═══`)
  let worst = { d: Infinity, pair: '' }
  for (const k of ORDER) {
    const row = []
    for (const [sk, s] of Object.entries(SEMANTIC)) {
      const d = deltaE(pal[k].color, s.c)
      if (d < worst.d) worst = { d, pair: `${LABEL[k]} ↔ ${s.label}` }
      row.push(`${d < threshold ? '⚠' : ' '}${d.toFixed(0).padStart(3)}`)
    }
    console.log(`  ${pad(LABEL[k], 4)} ${pal[k].color} (h${hue(pal[k].color)})  ${row.join(' ')}`)
  }
  console.log(`  → 最接近：${worst.pair}  ΔE=${worst.d.toFixed(1)}  ${worst.d >= threshold ? '✓ 通过' : '⚠ 未达标'}`)
  return worst.d
}

function checkPairwise(name, pal, threshold) {
  console.log(`\n═══ ② 分类色两两之间（ΔE 阈值 ${threshold}）—— ${name} ═══`)
  let worst = { d: Infinity, pair: '' }
  for (let i = 0; i < ORDER.length; i++) {
    const row = []
    for (let j = 0; j < ORDER.length; j++) {
      if (j <= i) {
        row.push('  ·')
        continue
      }
      const d = deltaE(pal[ORDER[i]].color, pal[ORDER[j]].color)
      if (d < worst.d) worst = { d, pair: `${LABEL[ORDER[i]]} ↔ ${LABEL[ORDER[j]]}` }
      row.push(`${d < threshold ? '⚠' : ' '}${d.toFixed(0).padStart(3)}`)
    }
    console.log(`  ${pad(LABEL[ORDER[i]], 4)} ${row.join(' ')}`)
  }
  console.log(`  → 最接近：${worst.pair}  ΔE=${worst.d.toFixed(1)}  ${worst.d >= threshold ? '✓ 通过' : '⚠ 未达标'}`)
  return worst.d
}

function checkContrast(name, pal) {
  console.log(`\n═══ ③ 同色文字/图标压在同色浅底上 —— ${name} ═══`)
  let worst = { c: Infinity, k: '' }
  for (const k of ORDER) {
    const ct = contrast(pal[k].color, pal[k].bg)
    if (ct < worst.c) worst = { c: ct, k }
    const tag = ct >= 4.5 ? '✓ AA 正文' : ct >= 3.0 ? '△ 仅过 UI 组件(3:1)' : '⚠ 连 3:1 都不过'
    console.log(`  ${pad(LABEL[k], 4)} ${pal[k].color} on ${pal[k].bg}  →  ${ct.toFixed(2)}:1  ${tag}`)
  }
  console.log(`  → 最低：${LABEL[worst.k]}  ${worst.c.toFixed(2)}:1`)
  return worst.c
}

/**
 * ⑤ 语义色的「文字态」体检
 *
 * 每个语义色（brand / accent / warn / danger）都可能有两种角色：
 *   · 填充态：条形、圆点、整块按钮底 —— 要鲜亮，没有对比度要求
 *   · 文字态：压在浅底上的小字 —— 要可读，AA 4.5:1
 * 基色是照填充设计的，直接当文字用只有 2.85 ~ 3.27:1，所以每个都有 -deep 变体。
 * 这里验三件事：-deep 过不过 AA、色相有没有跑偏（不能变出第二种颜色）、
 * 以及最原始的「基色当文字会掉到多少」—— 把代价写在输出里。
 */
function checkInk() {
  console.log('\n\n############ ⑤ 语义色的「文字态」（-deep）体检 ############')
  const LIGHT = { 白卡: '#FFFFFF', 页面底: VARS['--bg-page'], 'bg-subtle': VARS['--bg-subtle'] }
  const ROLES = [
    { base: '--brand', deep: '--brand-deep', soft: '--brand-soft', label: '品牌绿' },
    { base: '--accent', deep: '--accent-deep', soft: '--accent-soft', label: '强调橙' },
    { base: '--warn', deep: '--warn-deep', soft: '--warn-soft', label: '警示琥珀' }
  ]
  let worstAll = { c: Infinity, k: '' }
  for (const r of ROLES) {
    const base = VARS[r.base]
    const deep = VARS[r.deep]
    const dh = Math.abs(hue(base) - hue(deep))
    const dHue = Math.min(dh, 360 - dh)
    const cells = [
      ...Object.entries(LIGHT).map(([n, bg]) => [`${n}`, contrast(deep, bg)]),
      ['自身 soft 底', contrast(deep, VARS[r.soft])]
    ]
    const worst = cells.reduce((a, b) => (b[1] < a[1] ? b : a))
    if (worst[1] < worstAll.c) worstAll = { c: worst[1], k: r.label }
    const baseCr = contrast(base, '#FFFFFF')
    console.log(
      `  ${pad(r.label, 5)} ${base} 当文字只有 ${baseCr.toFixed(2)}:1 ✗  →  ${deep}  ` +
        `最差 ${worst[0]} ${worst[1].toFixed(2)}:1 ${worst[1] >= 4.5 ? '✓ AA' : '⚠'}  ` +
        `Δhue=${dHue.toFixed(0)}° ${dHue <= 25 ? '✓ 同色相' : '⚠ 色相跑偏'}`
    )
  }
  // danger 走另一条路：它本来就是「文字 / 白字按钮底」两用，直接把基色按最差底色反推
  const danger = VARS['--danger']
  const dw = Object.entries(LIGHT).map(([n, bg]) => [n, contrast(danger, bg)])
  const dWorst = dw.reduce((a, b) => (b[1] < a[1] ? b : a))
  const onWhiteInk = contrast(danger, '#FFFFFF')
  if (dWorst[1] < worstAll.c) worstAll = { c: dWorst[1], k: '危险红' }
  console.log(
    `  ${pad('危险红', 5)} ${danger}  文字态最差 ${dWorst[0]} ${dWorst[1].toFixed(2)}:1 ` +
      `${dWorst[1] >= 4.5 ? '✓ AA' : '⚠'}   白字压它 ${onWhiteInk.toFixed(2)}:1 ` +
      `${onWhiteInk >= 4.5 ? '✓ AA' : '⚠'}（两种角色共用一个值，所以必须按最差底色反推）`
  )
  console.log(
    `  → 全部 -deep / danger 最差 ${worstAll.c.toFixed(2)}:1（${worstAll.k}）` +
      `${worstAll.c >= 4.5 ? ' ✓ 无条件过 AA' : ' ⚠ 有底色没到 4.5'}`
  )
  console.log('  口径：填充和图形用基色（要鲜亮），浅底上的文字一律用 -deep（要可读）。')
  return worstAll.c
}

// ── 参照标尺：苹果自家系统色之间的距离 ───────────────────────
console.log('\n══════ 输入：src/styles/theme.css ══════')
console.log(COVERAGE_LINE)
console.log('\n══════ 参照标尺：iOS 系统色两两最小距离 ══════')
const IOS = {
  red: '#FF3B30',
  orange: '#FF9500',
  yellow: '#FFCC00',
  green: '#34C759',
  mint: '#00C7BE',
  teal: '#30B0C7',
  cyan: '#32ADE6',
  blue: '#007AFF',
  indigo: '#5856D6',
  purple: '#AF52DE',
  pink: '#FF2D55',
  brown: '#A2845E',
  gray: '#8E8E93'
}
for (const a of ['orange', 'yellow']) {
  for (const b of ['amber-reference-not-ios']) void b
}
const refPairs = [
  ['orange', 'yellow'],
  ['orange', 'red'],
  ['orange', 'brown'],
  ['red', 'pink'],
  ['blue', 'indigo'],
  ['indigo', 'purple'],
  ['purple', 'pink'],
  ['green', 'mint'],
  ['mint', 'teal'],
  ['teal', 'cyan'],
  ['brown', 'yellow'],
  ['gray', 'brown']
]
const refs = refPairs.map(([a, b]) => ({ pair: `${a} ↔ ${b}`, d: deltaE(IOS[a], IOS[b]) }))
refs.sort((x, y) => x.d - y.d)
for (const r of refs) console.log(`  ${pad(r.pair, 20)} ΔE=${r.d.toFixed(1)}`)
console.log(`  → 苹果自己最挤的一对 ΔE=${refs[0].d.toFixed(1)}（${refs[0].pair}）`)

// ── 依次体检 ─────────────────────────────────────────────────
const SEM_TH = 25
const PAIR_TH = 20

const r = {}
console.log('\n\n############ 历史基线（改版前的分类色板） ############')
r.curSem = checkSemantic('历史', BEFORE, SEM_TH)
r.curPair = checkPairwise('历史', BEFORE, PAIR_TH)
r.curCon = checkContrast('历史', BEFORE)

console.log('\n\n############ 当前生效（从 theme.css 解析） ############')
r.newSem = checkSemantic('当前', LIVE, SEM_TH)
r.newPair = checkPairwise('当前', LIVE, PAIR_TH)
r.newCon = checkContrast('当前', LIVE)

console.log('\n\n############ 对比结论 ############')
const row = (label, a, b, dir, better) => {
  const good = better ? better(b, a) : dir === 'high' ? b > a : b < a
  console.log(
    `  ${pad(label, 22)} 历史 ${a.toFixed(1).padStart(5)}  →  当前 ${b.toFixed(1).padStart(5)}   ` +
      `${good ? '✓ 改善' : b === a ? '— 持平' : '✗ 变差（请复核）'}`
  )
}
row('① 最接近的语义色 ΔE', r.curSem, r.newSem, 'high')
row('② 最接近的分类色 ΔE', r.curPair, r.newPair, 'high')
row('③ 最低对比度', r.curCon, r.newCon, 'high')

checkIdentity()
checkInk()

/*
 * ── 判定 ──────────────────────────────────────────────────────
 *
 * 上面全是**报告**：网格上的 ⚠、历史 vs 当前的对比，都只印不判。
 * 结果是「分类色的三条约束」其实一直**没有闸门**：
 * 有人把 `--cat-food` 改成 `--accent` 的值，`check:tokens` ② 照过（两边同值就算过关），
 * ΔE 约束被打破而没有任何东西报警。这个脚本又不在 `verify` 链里 —— 正是第 3 轮踩过的坑
 * （「不在校验链里的审计脚本」会一直按过期前提跑，却没人看得见）。
 *
 * 所以这里补上判定，并把它拉进 `verify`。三点说明：
 *   1. 阈值按**文档口径**（分类色两两 ≥ 20 / vs 语义色 ≥ 22 / 压同色浅底 ≥ 3.0），
 *      跟 `search-palette.mjs` 的约束是同一套；网格上的 ⚠ 用的是 25，那只是自我提醒的余量。
 *   2. **身份色（头像）只报告不判**：它的 ΔE 有意放宽（`[0]` 就是品牌色本身、有几项与语义色
 *      ΔE < 12），理由在 `format.ts` 里量化过 —— 形状与位置不同，不构成实际混淆。
 *      把它拉进来判会逼着去重挑一套更难看的身肤色，是「为了数字好看而变差」。
 *   3. 判失败时把「现在是多少、要求多少」一起打出来，别只给一个 ✗。
 */
const SEM_ASSERT = 22
const PAIR_ASSERT = 20
const CONTRAST_ASSERT = 3.0

console.log('\n\n############ 判定（会返回非 0，已进 verify 链） ############')
let palFail = 0
const judge = (label, got, need, unit) => {
  const good = got >= need
  if (!good) palFail++
  // 对比度那项离阈值很近（3.09 vs 3.0），打印一位小数会把「刚好擦线」藏起来 —— 它保留两位
  const shown = got.toFixed(unit === ':1' ? 2 : 1)
  console.log(
    `  ${good ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}：${shown}${unit}` +
      `（要求 ≥ ${need}${unit}）` +
      (good ? '' : '  ← 越界了；改分类色请先用 `palette:search` 在约束里试算')
  )
}
judge('分类色 vs 语义色 ΔE（最接近的一对）', r.newSem, SEM_ASSERT, '')
judge('分类色两两 ΔE（最接近的一对）', r.newPair, PAIR_ASSERT, '')
judge('分类色压同色浅底的最差对比度', r.newCon, CONTRAST_ASSERT, ':1')

if (palFail) {
  console.log(`\n\x1b[31m色板体检失败：${palFail} 项越界\x1b[0m\n`)
  process.exit(1)
}
console.log(
  '\n\x1b[32m色板体检通过：分类色三条约束都在（身份色按已知边界只报告）\x1b[0m\n'
)

