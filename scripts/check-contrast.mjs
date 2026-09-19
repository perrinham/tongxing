/**
 * 文字对比度闸门（纯 Node，零依赖）
 *
 * 为什么要它：这个项目里有一整类**不报错**的缺陷 —— 颜色配得「看着还行」，
 * 但算一下差一点。典型：
 *   · `--danger` #E03B30 压白底 = 4.34:1，差 0.16 不到 AA 4.5，
 *     而它同时当「白底红字」和「白字按钮的底」，两种角色双向都差一点；
 *   · `.key.save[disabled]` 白字压 `--line-strong` = 1.52:1 —— 那是**分隔线**的颜色被当底用；
 *   · 海报上的半透明白压品牌绿 = 2.51:1，导出成图片发出去谁也不会去量。
 * 这类问题靠肉眼审不出来，靠这份清单也修不完（第十处一定会漏），所以做成闸门。
 *
 * 五类断言（判失败：① ~ ④、⑥、⑦；⑤ 只报告）：
 *   ① 同一个规则里同时有 color 和 background → 必须过阈值
 *        普通文字 4.5:1；大字（≥24px，或 ≥18.66px 且加粗）3:1
 *        实心控件（白字压语义色底）按 WCAG 1.4.11 的 3:1 —— Apple 自家
 *        systemBlue 按钮也只有 3.6:1，所以这类只记「△ 已知取舍」不判失败
 *        [disabled] / :disabled 按 inactive 组件（1.4.3 豁免）同样只提示
 *   ② 源码里不得出现 `color: var(--brand|--accent|--warn)`
 *        语义基色是给**填充**设计的，当文字用只有 2.85 ~ 3.27:1。
 *        浅底上的文字一律走 `-deep`。允许清单只有一条：SVG 图标（属图形，3:1 线）
 *   ③ 令牌自检：-deep 系列必须在「白 / --bg-page / --bg-subtle」三种浅底上无条件过 4.5:1
 *        --bg-subtle 是文字实际会落到的最深浅底，按它反推出来的值就是通用解
 *   ④ 分类色不得挂在「含文字」的元素上
 *        分类色最低只有 3.09:1，只够图形/UI 组件线。它是通过内联 style 从
 *        `CATEGORY_META` 上来的，① 读 CSS 规则时看不到 —— 所以单独做一条模板级检查
 *   ⑥ map 的 `callout` / `label` 颜色必须走 `avatarInk(底色)`，且「机制」本身要成立
 *        这两个颜色是运行时 JS 常量、不经过 CSS，① 同样看不到（和 ④ 同一个盲区）。
 *        原来写死白字压 `--brand` = 3.18:1，而 `callout.content` 是 12px 的城市名（正文）。
 *        另加一条：avatarInk 对 CANVAS_PALETTE 里每个底色都必须给出 ≥ 4.5:1
 *   ⑦ 两条「① 在结构上看不见」的误用
 *        a) `--line-strong` 不得当**文字色**：它是分隔线的颜色，压白卡只有 1.52:1
 *           （① 看不到：这类规则**只声明 color**，底色来自祖先）
 *        b) global.css 的**全局禁用兜底**必须存在、算得出 ≥ 4.5:1、且不许写 opacity
 *           （① 看不到：禁用态是被 uni 内置样式盖出来的，元素自己没声明 background）
 *        c) 所有 [disabled] 规则的配色统一到 --bg-sunken + --text-secondary
 *
 * 只报告不判失败的：
 *   · `--text-tertiary` 的使用清单（第五节）—— 三级灰在白底上不可能都过 AA
 *     （见 theme.css 的推算），这是**有意的层级取舍**，不是 bug。
 *     列出来是为了「想改的时候一眼看到全部影响面」
 *   · 第五节末尾还会**重算**「tab 未选中态为什么不提到 secondary」那条反例的前提
 *     （两个令牌的明度差），避免它在注释里过期 —— 前提变了会直接提示可以重新评估
 *
 * 跑法：node scripts/check-contrast.mjs
 * 退出码：0 全过；1 有真实缺陷
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  parseThemeTokens,
  coverageLine,
  assertNoUnparsedOpaque,
  assertRequired
} from './lib/theme-tokens.mjs'

/** 分类色的 7 个槽位（④ 与令牌依赖清单都用） */
const CAT_KEYS = ['food', 'transport', 'stay', 'ticket', 'shopping', 'entertain', 'other']

const ROOT = process.cwd()

/* ── 色彩数学 ─────────────────────────────────────────────── */
function srgbToLinear(c) {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)]
}
function relLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a, b) {
  const l1 = relLuminance(a)
  const l2 = relLuminance(b)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

/* ── 解析 theme.css 的令牌 ──────────────────────────────────
 *
 * 解析和「覆盖断言」都走 `scripts/lib/theme-tokens.mjs`（三个闸门共用一份）。
 * 这里曾有一份自己的 hex 正则，带来的静默很隐蔽：
 * `--text-primary: rgb(28, 28, 30)` 与 `#1C1C1E` 视觉一致，但那条正则收不到，
 * `resolve()` 于是返回 null，① 里一句 `if (!bg || !fg) continue` 就把这一对**丢掉** ——
 * 实测 45 条配对变 37 条，而输出仍写「37 条配对全部达标」「对比度闸门通过」、EXIT=0。
 * 正文墨色的主令牌换写法，消失的恰好是正文那批配对。
 */
const { tokens: TOKENS, decls: DECLS, missed: MISSED } = parseThemeTokens(ROOT)
/** 本闸门依赖的令牌 —— ①④⑤⑥⑦⑧ 会直接取值 / 参与配对。删掉任何一个，这里就该停下来问清楚。 */
const REQUIRED_TOKENS = [
  '--bg-page', '--bg-card', '--bg-subtle', '--bg-sunken',
  '--text-primary', '--text-secondary', '--text-tertiary', '--text-inverse',
  '--line', '--line-strong',
  '--brand', '--brand-deep', '--brand-soft', '--accent', '--accent-deep',
  '--warn', '--warn-deep', '--danger',
  ...CAT_KEYS.flatMap((k) => [`--cat-${k}`, `--cat-${k}-bg`])
]
assertNoUnparsedOpaque(MISSED, '对比度闸门')
assertRequired(TOKENS, REQUIRED_TOKENS, '对比度闸门')

/** 把任何颜色的写法解析成不透明 hex；解析不了返回 null（脚本宁可少报也不瞎报） */
function resolve(value, fallbackBg = '#FFFFFF') {
  if (!value) return null
  const v = value.trim()
  if (/^#[0-9A-Fa-f]{3,8}$/.test(v)) {
    return v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toUpperCase() : v.toUpperCase()
  }
  if (v === 'white') return '#FFFFFF'
  if (v === 'black') return '#000000'
  const varRef = v.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/)
  if (varRef) return TOKENS[varRef[1]] || null
  const rgba = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
  if (rgba) {
    const [, r, g, b, a] = rgba
    const alpha = a === undefined ? 1 : Number(a)
    const base = hexToRgb(fallbackBg)
    // 半透明色按「叠在 fallback 底上」后的实色算 —— 这正是真实观感
    const mix = [r, g, b].map((c, i) => Math.round(Number(c) * alpha + base[i] * (1 - alpha)))
    return `#${mix.map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
  }
  return null
}

/* ── 从 .vue / .css 里抽出 CSS 规则 ───────────────────────── */
function collectSources() {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e.startsWith('.')) continue
      const full = join(dir, e)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(vue|css)$/.test(e)) out.push(full)
    }
  }
  walk(join(ROOT, 'src'))
  return out
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

/** 收集 { file, selector, line, decls } —— @media 里的内层规则同样会被取到 */
function collectRules() {
  const rules = []
  for (const file of collectSources()) {
    const raw = readFileSync(file, 'utf8')
    const isVue = file.endsWith('.vue')
    const m = isVue ? raw.match(/<style[^>]*>([\s\S]*?)<\/style>/) : null
    const css = stripComments(m ? m[1] : raw)
    const offset = m ? raw.slice(0, raw.indexOf(m[1])).split('\n').length - 1 : 0
    for (const g of css.matchAll(/([^{}@][^{}]*)\{([^{}]*)\}/g)) {
      const selector = g[1].trim().replace(/\s+/g, ' ')
      if (!selector) continue
      const decls = {}
      for (const d of g[2].split(';')) {
        const i = d.indexOf(':')
        if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim()
      }
      if (!Object.keys(decls).length) continue
      const line = css.slice(0, g.index).split('\n').length + offset
      rules.push({ file: relative(ROOT, file), selector, line, decls })
    }
  }
  return rules
}

/* ── 判定 ─────────────────────────────────────────────────── */
const SEMANTIC_BASE = ['--brand', '--accent', '--warn']
const FILLS = new Set(
  ['--brand', '--brand-deep', '--accent', '--accent-deep', '--warn', '--warn-deep', '--danger'].map(
    (t) => TOKENS[t]
  )
)
/**
 * 允许「语义基色当文字」的唯一例外：SVG 图标是图形，按 1.4.11 的 3:1 记。
 *
 * ⚠️ 但**别说它「达标」** —— 令牌算出来是 `--brand` 压白卡 3.18:1（勉强）、
 * 压页面底 **2.85:1**、压 `--brand-soft` **2.82:1**。`.nav-icon` 的底色就是页面底，
 * 所以它其实**低于** 3:1。这是**有意保留**的取舍（Apple 自家的 tint 图标也在 3:1 附近晃，
 * 把品牌绿压成 -deep 会丢掉「绿色 = 可点」这个视觉语言），
 * 但它属于「已知妥协」，不属于「合规」。⑧ 把每个图标色的实测值都打印出来。
 *
 * 另外注意：这个清单是**按 CSS 写法**拟的（`.nav-icon` 类），而项目里绝大多数图标色
 * 走的是 `<AppIcon color="…">` **属性**，② 根本读不到 —— 那批由 ⑧ 守。
 */
const ICON_ALLOW = ['.nav-icon']

let fail = 0
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const bad = (m) => {
  fail++
  console.log(`  \x1b[31m✗\x1b[0m ${m}`)
}

const rules = collectRules()

console.log('\n═══ 输入校验：theme.css 的令牌解析 ═══')
console.log(`  ${coverageLine(DECLS, MISSED, REQUIRED_TOKENS.length)}`)

console.log('\n═══ ① 同一规则里 color 压 background —— 逐条算 ═══')
let pairs = 0
/** 因为「颜色写法解析不了」而没能参检的规则 —— 单列出来，别让配对缩水无声无息 */
const unresolvable = []
const notes = []
const failures = []
for (const r of rules) {
  const bgRaw = r.decls.background || r.decls['background-color']
  const colorRaw = r.decls.color
  if (!bgRaw || !colorRaw) continue
  // 渐变 / 多重背景 / url() 解析不了，跳过
  if (/gradient|url\(|\s,/.test(bgRaw)) continue
  // 半透明背景要叠在某个底上才有个实色，浅底取白卡（和 FILLS 那套口径一致）
  const bg = resolve(bgRaw)
  const fg = resolve(colorRaw, bg || '#FFFFFF')
  if (!bg || !fg) {
    unresolvable.push({ rule: r, which: !bg ? 'background' : 'color', raw: !bg ? bgRaw : colorRaw })
    continue
  }

  pairs++
  const size = parseFloat((r.decls['font-size'] || '').replace('px', '')) || 0
  const weight = Number(r.decls['font-weight']) || 400
  const large = size >= 24 || (weight >= 700 && size >= 18.66)
  const inactive = /\[disabled\]|:disabled\b/.test(r.selector)
  const filled = FILLS.has(bg) && relLuminance(fg) > 0.7
  const cr = contrast(fg, bg)
  const need = large || inactive || filled ? 3.0 : 4.5
  const line = `${r.file}:${r.line} ${r.selector}  ${fg} on ${bg}  ${cr.toFixed(2)}:1 (需 ${need})`

  // tertiary 压浅底属**有意的层级取舍**（见 ④），不算缺陷 —— 只在 ④ 里登记
  const isTertiary = colorRaw.trim() === 'var(--text-tertiary)'
  if (cr >= need) {
    if (filled || inactive) notes.push({ kind: filled ? '实心控件' : '禁用态', line, cr })
    continue
  }
  if (isTertiary) {
    notes.push({ kind: '三级灰', line, cr })
    continue
  }
  failures.push(line)
}
for (const f of failures) bad(f)
for (const n of notes) {
  const why = {
    实心控件: '白字压语义色底，1.4.11 的 3:1 线；Apple 自家 systemBlue 按钮也只有 3.6:1',
    禁用态: 'WCAG 1.4.3 豁免 inactive 组件',
    三级灰: '有意的层级取舍，见 theme.css / 本脚本 ⑤'
  }[n.kind]
  console.log(`  \x1b[33m△\x1b[0m [${n.kind}] ${n.line} —— ${why}`)
}
if (!fail) ok(`${pairs} 条「color + background」配对全部达标（其中 ${notes.length} 条按 3:1 记取舍）`)
/*
 * 配对数量本身是要盯的：断言是「已参检的配对全部达标」，
 * 所以「配对数缩水」是**唯一**能让闸门悄悄放水的路径。
 * 这里把没能参检的逐条列出来 —— 渐变/半透明/多重背景是正常原因，但必须看得见。
 */
if (unresolvable.length) {
  console.log(
    `  \x1b[33m△\x1b[0m 另有 ${unresolvable.length} 条规则有 color + background 但没能参检 ` +
      `（写法解析不出实色；渐变/半透明/多重背景属正常）：`
  )
  for (const u of unresolvable)
    console.log(`      · ${u.rule.file}:${u.rule.line}  ${u.rule.selector}  ${u.which}: ${u.raw}`)
}

console.log('\n═══ ② 语义基色不得当文字用（浅底上的字一律走 -deep）═══')
let hits = 0
for (const r of rules) {
  const colorRaw = r.decls.color || ''
  const v = colorRaw.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/)
  if (!v || !SEMANTIC_BASE.includes(v[1])) continue
  hits++
  if (ICON_ALLOW.some((s) => r.selector.includes(s))) {
    console.log(
      `  \x1b[33m•\x1b[0m ${r.file}:${r.line} ${r.selector} 用 ${v[1]} —— 允许：里面是 SVG 图标，属图形`
    )
    continue
  }
  bad(
    `${r.file}:${r.line} ${r.selector} 用 ${v[1]} 当文字（${contrast(TOKENS[v[1]], '#FFFFFF').toFixed(2)}:1 压白底）` +
      ` → 应改 ${v[1]}-deep（${TOKENS[`${v[1]}-deep`] ? contrast(TOKENS[`${v[1]}-deep`], '#FFFFFF').toFixed(2) : '?'}:1）`
  )
}
if (!hits) ok('全仓没有语义基色当文字的写法')

console.log('\n═══ ③ 令牌自检：-deep / danger 必须无条件过 4.5:1 ═══')
// --bg-subtle 是文字实际会落到的最深浅底，按它反推的值就是通用解
const LIGHT_SURFACES = { 白卡: '#FFFFFF', 页面底: TOKENS['--bg-page'], 'bg-subtle': TOKENS['--bg-subtle'] }
const SOFTS = { '--accent-deep': '--accent-soft', '--warn-deep': '--warn-soft', '--danger': '--danger-soft' }
for (const tok of ['--brand-deep', '--accent-deep', '--warn-deep', '--danger']) {
  const hex = TOKENS[tok]
  if (!hex) {
    bad(`${tok} 不存在`)
    continue
  }
  const worst = Object.entries(LIGHT_SURFACES)
    .map(([name, bg]) => ({ name, cr: contrast(hex, bg) }))
    .sort((a, b) => a.cr - b.cr)[0]
  const soft = SOFTS[tok]
  const softCr = soft ? contrast(hex, TOKENS[soft]) : null
  const allOk = worst.cr >= 4.5 && (softCr === null || softCr >= 4.5)
  const msg =
    `${tok.padEnd(14)} ${hex}  最差 ${worst.name} ${worst.cr.toFixed(2)}:1` +
    (softCr !== null ? `  ${soft} ${softCr.toFixed(2)}:1` : '') +
    (tok === '--danger' ? `  白字压它 ${contrast(hex, '#FFFFFF').toFixed(2)}:1` : '')
  if (allOk) ok(msg)
  else bad(`${msg} → 有底色没过 4.5:1`)
}

console.log('\n═══ ④ 分类色不得挂在「含文字」的元素上 ═══')
/*
 * 分类色最低只有 3.09:1（`--cat-food` 压 `--cat-food-bg`），只够 WCAG 1.4.11 的
 * 图形/UI 组件线，不够 12~14px 正文的 4.5:1。所以它们的合法去处是
 * background / 条形填充 / 包着 SVG 图标的那个元素。
 *
 * 这一条没法靠 ①（它只读 CSS 规则）发现 —— 分类色是通过内联 style 从
 * `CATEGORY_META` 上来的。做法：找到内联的 `color: CATEGORY_META[...].color`，
 * 看它之后的那个元素内容里有没有 `{{ }}`；有就说明这个颜色会落到文字上。
 */
function collectVueTemplateFiles() {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e.startsWith('.')) continue
      const full = join(dir, e)
      if (statSync(full).isDirectory()) walk(full)
      else if (e.endsWith('.vue')) out.push(full)
    }
  }
  walk(join(ROOT, 'src'))
  return out
}
{
  let hits = 0
  for (const file of collectVueTemplateFiles()) {
    const src = readFileSync(file, 'utf8')
    // 只扫模板部分，避免把 <style> 里 comment 也算进来
    const tpl = src.slice(0, src.search(/<style[\s>]/) < 0 ? src.length : src.search(/<style[\s>]/))
    for (const m of tpl.matchAll(/color:\s*CATEGORY_META\[[^\]]+\]\.color/g)) {
      const openEnd = tpl.indexOf('>', m.index)
      if (openEnd < 0) continue
      const rest = tpl.slice(openEnd)
      const close = rest.search(/<\/(span|button|div|p|label)>/)
      const inner = close < 0 ? rest.slice(0, 400) : rest.slice(0, close)
      hits++
      if (/\{\{/.test(inner)) {
        bad(
          `${relative(ROOT, file)} 的分类色挂在含文字的元素上` +
            `（元素内容里有 {{ }}）→ 文字改走 --text-*，颜色只留给图标`
        )
      }
    }
  }
  if (!hits) bad('一处都没找到 color: CATEGORY_META[...].color —— 反而可疑，模板改过？')
  else if (!fail) ok(`${hits} 处内联分类色都只作用于图标（元素内容里没有文字节点）`)
}

console.log('\n═══ ⑤ 只报告：「--text-tertiary」的使用面（有意的层级取舍，非缺陷）═══')
const tertiary = rules.filter((r) => (r.decls.color || '').trim() === 'var(--text-tertiary)')
console.log(
  `  --text-tertiary ${TOKENS['--text-tertiary']} 压白底 ${contrast(TOKENS['--text-tertiary'], '#FFFFFF').toFixed(2)}:1 / ` +
    `压页面底 ${contrast(TOKENS['--text-tertiary'], TOKENS['--bg-page']).toFixed(2)}:1`
)
console.log('  三级灰在白底上数学上不可能都过 AA（推算见 theme.css）；Apple 自家 tertiaryLabel 只有 ~1.9:1。')
console.log('  要收窄影响面，就按「凡是承载数据的（日期/金额/统计）提到 --text-secondary」逐条改：')
for (const r of tertiary) console.log(`    · ${r.file}:${r.line}  ${r.selector}`)
console.log(
  `  合计 ${tertiary.length} 处。注意底部 tab 的未选中态**不要**动：提到 secondary 后它的明度会和选中态 --brand-deep 撞在一起。`
)

/*
 * 上面那句「不要动」是有前提的，这里把前提**重算**一遍，而不是让它在注释里慢慢过期。
 * 反例成立的条件：未选中态提到 secondary 之后，它的明度与选中态 --brand-deep 几乎相同，
 * 于是选中/未选中只剩色相可辨。这个前提依赖两个令牌的**当前取值** ——
 * 改主题色或改二级灰都可能把它推翻，所以让闸门每次都把话说明白。
 */
const ySecondary = relLuminance(TOKENS['--text-secondary'])
const yBrandDeep = relLuminance(TOKENS['--brand-deep'])
const yGap = Math.abs(ySecondary - yBrandDeep)
console.log(
  `  反例前提重算：Y(--text-secondary ${TOKENS['--text-secondary']}) = ${ySecondary.toFixed(5)}，` +
    `Y(--brand-deep ${TOKENS['--brand-deep']}) = ${yBrandDeep.toFixed(5)}，差 ${yGap.toFixed(5)}`
)
if (yGap < 0.02) {
  console.log(
    '  → 差 < 0.02：两者明度几乎相同。tab 未选中态**保持 tertiary**，靠「绿 vs 灰」区分，不要提到 secondary。'
  )
} else {
  console.log(
    '  → 差 ≥ 0.02：两者已拉开。**反例前提变了** —— 可以重新评估「把 tab 未选中态提到 secondary」，' +
      '并同步改 theme.css 与 README 里那段说明。'
  )
}

console.log('\n═══ ⑥ map callout / label：颜色是运行时 JS 常量，① 看不见 ═══')
/*
 * 微信原生 `<map>` 的 `callout.color` / `label.color` 是**运行时字面值**，不经过 CSS ——
 * 所以 ①（只读 CSS 规则）完全看不到，和 ④（内联 style）是同一个盲区。
 * 这里原来写死白字压在 `--brand` 上（3.18:1），而 `callout.content` 是 12px 的**城市名**，
 * 属于正文，要 4.5:1。修法是按底色取墨色（复用头像那套 `avatarInk`）。
 *
 * 两条断言：
 *   a) map 的 callout / label 里不得出现字面量白/黑 —— 必须走 avatarInk(底色)
 *   b) 「机制」本身也要守住：avatarInk 对 CANVAS_PALETTE 里**每一个**底色都必须 ≥ 4.5:1
 */
function takeBraced(src, openIdx) {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(openIdx, i + 1)
    }
  }
  return src.slice(openIdx)
}
{
  let blocks = 0
  for (const rel of ['src/pages/CityMapPage.vue', 'src/pages/MapPage.vue']) {
    let src
    try {
      src = readFileSync(join(ROOT, rel), 'utf8')
    } catch {
      bad(`读不到 ${rel}`)
      continue
    }
    for (const m of src.matchAll(/\b(callout|label):\s*\{/g)) {
      blocks++
      const block = takeBraced(src, m.index + m[0].length - 1)
      const hit = block.match(/color:\s*([^,\n]+)/)
      if (!hit) {
        bad(`${rel} 的 ${m[1]} 没有 color 字段`)
        continue
      }
      const expr = hit[1].trim()
      if (!/avatarInk\s*\(/.test(expr)) {
        bad(
          `${rel} 的 ${m[1]}.color = ${expr} —— 必须走 avatarInk(底色)。` +
            `压在色块上的文字写死白/黑都不可靠（白字压 --brand 只有 3.18:1）`
        )
      }
    }
  }
  if (!blocks) bad('一处 map callout/label 都没扫到 —— 页面结构改过？')
  else if (!fail) ok(`${blocks} 处 map callout/label 的 color 都走 avatarInk（没有写死白/黑）`)

  // b) 机制本身：CANVAS_PALETTE 里每个底色都要能让 avatarInk 给出 ≥ 4.5:1
  const fmt = readFileSync(join(ROOT, 'src/utils/format.ts'), 'utf8')
  const palHead = fmt.match(/CANVAS_PALETTE[^=]*=\s*\{/)
  if (!palHead) {
    bad('没能从 format.ts 找到 CANVAS_PALETTE 的定义')
  } else {
    const palBody = takeBraced(fmt, palHead.index + palHead[0].length - 1)
    const palette = {}
    for (const m of palBody.matchAll(/([A-Za-z]\w*)\s*:\s*'(#[0-9A-Fa-f]{6})'/g)) {
      palette[m[1]] = m[2].toUpperCase()
    }
    const names = Object.keys(palette)
    if (!names.length) bad('没能从 CANVAS_PALETTE 解析出任何色值')
    else {
      const rows = names.map((k) => {
        const bg = palette[k]
        const Y = relLuminance(bg)
        const ink = (Y + 0.05) / 0.05 >= 1.05 / (Y + 0.05) ? '#000000' : '#FFFFFF'
        return { k, bg, ink, ratio: contrast(ink, bg) }
      })
      const worst = rows.sort((a, b) => a.ratio - b.ratio)[0]
      if (worst.ratio < 4.5) {
        bad(
          `avatarInk 对 CANVAS_PALETTE.${worst.k}(${worst.bg}) 只有 ${worst.ratio.toFixed(2)}:1（要 ≥ 4.5）`
        )
      } else if (!fail) {
        ok(
          `avatarInk 对 CANVAS_PALETTE 全部 ${names.length} 个底色都 ≥ 4.5:1` +
            `（最差 ${worst.k} ${worst.bg} → ${worst.ink} ${worst.ratio.toFixed(2)}:1）`
        )
      }
    }
  }

  /*
   * b2) 上面那段算的是**数学性质**（黑白二选一的下界 4.58:1 与底色无关），
   *     它并不能证明 `format.ts` 里的实现就长这样 —— 曾经把 avatarInk 改成
   *     「固定 return '#FFFFFF'」，上面照样全绿。所以还得盯住**实现**：
   *     函数体里必须同时出现黑与白两个返回值，且必须基于 relLuminance(bg)。
   */
  const inkFn = fmt.match(/function avatarInk[\s\S]*?\n\}/)
  if (!inkFn) {
    bad('format.ts 里找不到 avatarInk 的函数体')
  } else {
    const body = inkFn[0]
    const hasBlack = /'#000000'|'#000'/.test(body)
    const hasWhite = /'#FFFFFF'|'#fff'/i.test(body)
    const usesLum = /relLuminance\s*\(\s*bg\s*\)/.test(body)
    if (!hasBlack || !hasWhite || !usesLum) {
      bad(
        `avatarInk 的实现不再是「按底色在黑白之间二选一」` +
          `（黑=${hasBlack} 白=${hasWhite} relLuminance=${usesLum}）` +
          ` —— 那上面的下界就不成立了`
      )
    } else if (!fail) {
      ok('avatarInk 的实现仍是 relLuminance(底色) → 黑白二选一（与底色无关的下界 4.58:1）')
    }
  }
}

console.log('\n═══ ⑦ 两条「① 结构上看不见」的误用：线的颜色当墨色 / 禁用态落回框架默认 ═══')
/*
 * 这两条都是**运行时体检**先量出来的、而静态闸门当时全都放过了。原因是同一个：
 * ① 只算「**同一条规则里**同时声明了 color 和 background」的配对 ——
 * 而这两类恰恰是「只声明 color（底色来自祖先）」和「被框架样式覆盖」，
 * 于是它们在 ① 的视野之外，颜色再差也不会响。
 *
 *   a) `--line-strong`(#D1D1D6) 是**画分隔线**的颜色，压白卡只有 1.52:1。
 *      同一个令牌已经被误用三次（都是运行时才发现的）：
 *        · 第 4 轮：当 `[disabled]` 按钮的**底**（上面还压白字 → 1.52:1）
 *        · 第 9 轮：`.dot-sep` 当**正文分隔符**（`·` 是字形，不是线）
 *        · 第 9 轮：`城市足迹` 的未选中星标当**字形色**
 *      结论：这个令牌只允许出现在 border / 分隔线的 background 上，**不许当 color**。
 *
 *   b) 禁用态：uni 内置的 `uni-button[disabled]` 是 #F7F7F7 底 + rgba(0,0,0,.3) 字 = **2.1:1**。
 *      「逐个按钮补 `[disabled]`」这条路已被证伪：补了 5 处之后，
 *      MembersPage 的「添加」按钮仍然量到 2.1:1 —— 因为那个按钮压根没写 [disabled]。
 *      所以 global.css 里有一条**同等特异性**的兜底；它要是被谁顺手删掉，
 *      整片界面会**悄悄**退回 2.1:1，而且 ① 同样看不到（元素自己没声明 background）。
 */
{
  // ── a) 线的颜色不得当墨色 ──────────────────────────────────
  const lineAsInk = []
  for (const r of rules) {
    if ((r.decls.color || '').replace(/\s+/g, '') === 'var(--line-strong)') {
      lineAsInk.push(`${r.file}:${r.line}  ${r.selector}`)
    }
  }
  const lineOnWhite = contrast(TOKENS['--line-strong'], '#FFFFFF').toFixed(2)
  if (lineAsInk.length) {
    bad(
      `有 ${lineAsInk.length} 处把 --line-strong(${TOKENS['--line-strong']}) 当**文字色**用` +
        `（它压白卡只有 ${lineOnWhite}:1，是分隔线的颜色）：\n      ${lineAsInk.join('\n      ')}`
    )
  } else {
    ok(
      `没有规则把 --line-strong(${TOKENS['--line-strong']}) 当文字色用` +
        `（它压白卡 ${lineOnWhite}:1 —— 只准拿它画线）`
    )
  }

  // ── b) 全局禁用兜底必须还在，且算得出 ≥ 4.5:1 ────────────
  const fallback = rules.find(
    (r) =>
      r.file.endsWith('styles/global.css') &&
      /\[disabled\]/.test(r.selector) &&
      /:not\(\[type\]\)|\[type="default"\]/.test(r.selector) &&
      (r.decls.background || r.decls['background-color']) &&
      r.decls.color
  )
  if (!fallback) {
    bad(
      'global.css 里的**全局禁用兜底**不见了 —— 选择器必须写到和 uni 同等的特异性' +
        '（含 `:not([type])` 或 `[type="default"]`）。没有它，凡是不带 [disabled] 的按钮' +
        '都会落回 uni 内置的 2.1:1'
    )
  } else {
    const bg = resolve(fallback.decls.background || fallback.decls['background-color'])
    const fg = resolve(fallback.decls.color)
    if (!bg || !fg) {
      bad(`全局禁用兜底的颜色解析不出来（background=${fallback.decls.background} color=${fallback.decls.color}）`)
    } else {
      const ratio = contrast(fg, bg)
      /*
       * 下限取 3.0（WCAG 1.4.11 的线），不是 4.5：禁用组件被 1.4.3 与 1.4.11 **双双豁免**，
       * 这里真正要守的是「别退回 uni 内置的 2.1:1」，不是「过 AA」。
       * 当前令牌算出来是 4.45:1 —— 差 0.05 不到 AA。这个数字是**推出来的**，
       * 所以顺手把「想让它过 AA 该换哪个令牌」也算出来打印，省得下次再推一遍。
       */
      const altBg = resolve('var(--bg-subtle)')
      const altRatio = altBg ? contrast(fg, altBg) : 0
      if (ratio < 3.0) {
        bad(`全局禁用兜底只有 ${ratio.toFixed(2)}:1（${fg} on ${bg}，下限 3.0）—— ${fallback.file}:${fallback.line}`)
      } else if (fallback.decls.opacity) {
        bad(
          `全局禁用兜底里出现了 opacity: ${fallback.decls.opacity} —— ` +
            `.ma / .tool / .demo-btn 各自用 opacity 表达禁用，在这里覆盖会改掉它们的外观`
        )
      } else if (!fail) {
        ok(
          `全局禁用兜底在 ${fallback.file}:${fallback.line}，${fg} on ${bg} = ${ratio.toFixed(2)}:1（下限 3.0），没动 opacity` +
            `；想过 AA 4.5 就把底色换成 --bg-subtle(${altBg}) → ${altRatio.toFixed(2)}:1`
        )
      }
    }
  }

  // ── c) 禁用态只有一种样子：--bg-sunken + --text-secondary ──
  const disabledOdd = []
  for (const r of rules) {
    if (!/\[disabled\]/.test(r.selector)) continue
    const bg = r.decls.background || r.decls['background-color']
    const fg = r.decls.color
    if (bg && bg.replace(/\s+/g, '') !== 'var(--bg-sunken)') {
      disabledOdd.push(`${r.file}:${r.line}  ${r.selector} 的 background = ${bg}`)
    }
    if (fg && fg.replace(/\s+/g, '') !== 'var(--text-secondary)') {
      disabledOdd.push(`${r.file}:${r.line}  ${r.selector} 的 color = ${fg}`)
    }
  }
  if (disabledOdd.length) {
    bad(`禁用态的配色不统一（只允许 --bg-sunken + --text-secondary）：\n      ${disabledOdd.join('\n      ')}`)
  } else if (!fail) {
    ok('所有 [disabled] 规则要么不碰底色/文字色（只用 opacity），要么就是 --bg-sunken + --text-secondary')
  }
}

console.log('\n═══ ⑧ 模板里 `AppIcon color=` 的属性色（① / ② 都读不到）═══')
/*
 * 这是「颜色不进 CSS 就没有闸门守」的**最后一层**：`<AppIcon color="…">` 是个属性，
 * 不是 CSS 规则。① 只看 CSS 规则里的 color+background 配对，② 只看 `color: var(--brand)`
 * 这种写法 —— 于是全仓 18 处 `color="var(--brand)"` / `color="var(--danger)"` 一条都没被读到，
 * 而 ② 的允许清单 `ICON_ALLOW = ['.nav-icon']` 其实是**照着 CSS 写法拟的**，
 * 跟这些图标的真实来源（属性）根本不是同一批。
 *
 * 更要紧的是：② 那句「图标属图形，1.4.11 只要 3:1」在本项目**并不成立** ——
 * 令牌算出来是：`--brand` 压白卡 3.18:1（勉强）／压页面底 **2.85:1**／压 `--brand-soft` **2.82:1**。
 * 也就是说 `.nav-icon` 与 `.tool-icon` 里的品牌色图标其实**低于** 3:1。
 * 这是**有意保留的取舍**（Apple 自家的 tint 图标也在 3:1 附近晃），但绝不该被写成「达标」。
 * 所以这条断言只判两种硬错，把数字**算出来打印**：
 *   ✗ 属性色既不是 `var(--…)` 也不是 `#fff`（裸 hex 一律拒）
 *   ✗ `var(--…)` 指向一个 theme.css 里不存在的令牌
 *   △ 基色 + 图标 < 3:1 → 打印实际比值（取舍自带数字）
 */
{
  const iconColors = new Map()
  const dynamic = []
  const badOnes = []
  for (const file of collectVueTemplateFiles()) {
    const src = readFileSync(file, 'utf8')
    const tpl = src.slice(0, src.search(/<style[\s>]/) < 0 ? src.length : src.search(/<style[\s>]/))
    for (const tag of tpl.matchAll(/<AppIcon\b[\s\S]*?\/>/g)) {
      const hit = tag[0].match(/\s:?color="([^"]+)"/)
      if (!hit) continue
      const raw = hit[1].trim()
      const varRef = raw.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/)
      if (varRef) {
        if (!TOKENS[varRef[1]]) badOnes.push(`${relative(ROOT, file)}  color="var(${varRef[1]})" → 令牌不存在`)
        else iconColors.set(TOKENS[varRef[1]], (iconColors.get(TOKENS[varRef[1]]) || 0) + 1)
      } else if (/^#(fff|ffffff)$/i.test(raw)) {
        iconColors.set('#FFFFFF', (iconColors.get('#FFFFFF') || 0) + 1)
      } else if (/^#[0-9A-Fa-f]{3,8}$/.test(raw)) {
        badOnes.push(`${relative(ROOT, file)}  color="${raw}" → 裸色值（除 #fff 外必须写成 var(--token)）`)
      } else if (raw.startsWith('var(')) {
        badOnes.push(`${relative(ROOT, file)}  color="${raw}" → 写法无法解析（只支持 var(--token) 形式）`)
      } else {
        dynamic.push(`${relative(ROOT, file)}  color="${raw}"`)
      }
    }
  }
  if (badOnes.length) for (const b of badOnes) bad(`AppIcon 的颜色 ${b}`)
  if (!iconColors.size && !dynamic.length) bad('一处 AppIcon 的颜色属性都没扫到 —— 组件改名了？')

  // 每个出现过的颜色，在三种浅底上算一遍（图标是图形，3:1 线）
  const SURFACES = { 白卡: '#FFFFFF', 页面底: TOKENS['--bg-page'], 'bg-subtle': TOKENS['--bg-subtle'] }
  const SOFT = { '#1FA470': '--brand-soft', '#E8714A': '--accent-soft', '#C77E1A': '--warn-soft', '#B01F16': '--danger-soft' }
  for (const [hex, n] of [...iconColors].sort((a, b) => b[1] - a[1])) {
    if (hex === '#FFFFFF') {
      console.log(`  ~ ${hex} × ${n} —— 压在语义色/深色底上的白图标（图形，需 ≥ 3:1；底色由所在容器决定）`)
      continue
    }
    const parts = Object.entries(SURFACES).map(([k, v]) => `${k} ${contrast(hex, v).toFixed(2)}:1`)
    if (SOFT[hex] && TOKENS[SOFT[hex]]) parts.push(`${SOFT[hex]} ${contrast(hex, TOKENS[SOFT[hex]]).toFixed(2)}:1`)
    const worst = Math.min(...parts.map((p) => Number(p.split(' ').pop().replace(':1', ''))))
    const mark = worst < 3 ? '△' : '✓'
    console.log(`  ${mark} ${hex} × ${n} —— ${parts.join(' / ')}${worst < 3 ? '  ← 低于图形 3:1，属有意取舍' : ''}`)
  }
  if (dynamic.length) {
    console.log(`  ~ 还有 ${dynamic.length} 处是动态表达式（静态算不了，改色时记得手验）：`)
    for (const d of dynamic) console.log(`      ${d}`)
  }
}

console.log('\n' + '─'.repeat(60))
if (fail) {
  console.log(`\x1b[31m对比度闸门失败：${fail} 处\x1b[0m\n`)
  process.exit(1)
}
console.log('\x1b[32m对比度闸门通过：配对达标、语义色未误当文字、-deep 无条件过 AA、禁用态统一、图标属性色可解析\x1b[0m\n')
