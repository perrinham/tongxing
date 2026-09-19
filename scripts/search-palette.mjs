/**
 * 分类色板约束搜索（纯 Node，零依赖）
 *
 * 目标：在候选色池里穷举组合，找出一组同时满足三条硬约束的 7 色分类板。
 *   C1  每个分类色 vs 5 个语义色（品牌绿/品牌深绿/强调橙/警示琥珀/危险红）  ΔE ≥ 25
 *   C2  分类色两两之间                                              ΔE ≥ 20
 *   C3  分类色压在自己的浅底上                                        对比度 ≥ 3.0:1
 *
 * 阈值的依据见 check-palette.mjs（ΔE 20 = 苹果自家 blue↔indigo 的距离；
 * 3.0:1 = WCAG 1.4.11 非文本/UI 组件线）。
 *
 * 跑法：node scripts/search-palette.mjs
 * 输出：胜出色板 + 完整体检表，可直接粘进 theme.css
 */

import { readFileSync } from 'node:fs'

// ── 色彩数学 ─────────────────────────────────────────────────
function srgbToLinear(c) {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
function hexToRgb(hex) {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}
function hexToLab(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear)
  const X = r * 0.4124564 + g * 0.3575761 + b * 0.1804375
  const Y = r * 0.2126729 + g * 0.7151522 + b * 0.072175
  const Z = r * 0.0193339 + g * 0.119192 + b * 0.9503041
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return [116 * f(Y) - 16, 500 * (f(X / 0.95047) - f(Y)), 200 * (f(Y) - f(Z / 1.08883))]
}
function deltaE(a, b) {
  const A = hexToLab(a)
  const B = hexToLab(b)
  return Math.sqrt((A[0] - B[0]) ** 2 + (A[1] - B[1]) ** 2 + (A[2] - B[2]) ** 2)
}
function relLum(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a, b) {
  const l1 = relLum(a)
  const l2 = relLum(b)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}
function mix(hex, target, t) {
  const a = hexToRgb(hex)
  const b = hexToRgb(target)
  return rgbToHex(a.map((v, i) => v + (b[i] - v) * t))
}

/** 色相角（0~360），只为在报告里给人看「这个色落在哪一带」 */
function hueOf(hex) {
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

// ── 输入 ─────────────────────────────────────────────────────
// 固定的语义色：品牌绿 / 品牌深绿 / 强调橙 / 危险红 —— 从 theme.css **解析**，不写死。
// 教训：这里原来是字面量快照，`--brand-deep` 从 #15795A 改到 #12724F、`--danger` 从
// #E03B30 改到 #B01F16 之后，搜索还在按旧锚点算 C1 的 ΔE —— 提案会基于过期前提。
// 凡是「算出来的数」，一律从源文件读。
const THEME_SRC = readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8')
const VARS = {}
for (const m of THEME_SRC.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})\s*;/g)) {
  VARS[m[1]] = m[2].toUpperCase()
}
const FIXED_SEM = {
  品牌绿: VARS['--brand'],
  品牌深绿: VARS['--brand-deep'],
  强调橙: VARS['--accent'],
  危险红: VARS['--danger']
}
for (const [k, v] of Object.entries(FIXED_SEM)) {
  if (!v) throw new Error(`theme.css 里没解析到语义色：${k} —— 令牌改名了？`)
}

/**
 * `--warn` 是可变的那个。
 * 原因：橙色带（h25~40）被 `--warn`(h35, 琥珀) 和 `--accent`(h15, 强调橙) 占住了，
 * 餐饮要的橙只能要么发白（过不了对比度）要么偏红（撞强调橙）——
 * 实测在 warn=#C77E1A 下搜索返回 0 组合，是个结构性冲突。
 *
 * 所以把 warn 挪去**黄色**带（h45~55）。这也更符合约定：iOS 的警告本来就是黄色，
 * 而 warn 在本项目只用于「想去」软标签和同步待办点，从不需要琥珀。
 */
const WARN_CANDIDATES = ['#C77E1A', '#A16207', '#8A6D00', '#9A7B00', '#B08600', '#946A00', '#8F6B00']

const LABEL = { food: '餐饮', transport: '交通', stay: '住宿', ticket: '门票', shopping: '购物', entertain: '娱乐', other: '其他' }
const ORDER = ['food', 'transport', 'stay', 'ticket', 'shopping', 'entertain', 'other']

const POOL = {
  // 暖色带最挤：h4(危险) h15(强调) h35(警示) 都在这，所以候选横跨「亮橙 → 深橙 → 红橙」
  food: ['#F59E0B', '#E8890C', '#D9730D', '#EA580C', '#F97316', '#C2410C', '#CA8A04', '#B45309', '#F0A008', '#DC6803', '#E8590C'],
  transport: ['#0B6BCB', '#007AFF', '#0A66C2', '#1668C4', '#1B6FD0', '#0D5EB0'],
  stay: ['#5856D6', '#6941C6', '#4F46E5', '#5B4BC4', '#6D28D9'],
  // 青绿色带要主动避开品牌绿 h157，所以候选集中在 h185~195 的「青」
  ticket: ['#0E8FA8', '#0D8CA0', '#118AB2', '#0E9AA7', '#1A8FA0', '#0B8BA6', '#128FA6'],
  shopping: ['#D6336C', '#C2255C', '#E0367A', '#CE3A72', '#DB2B63'],
  entertain: ['#9333C9', '#A855F7', '#8B2FC9', '#9B30D9', '#7E22CE'],
  other: ['#7A7A80', '#8E8E93', '#6E6E75', '#737379', '#6B6B72']
}

// 浅底生成比例（向白混合）：从「够浅」到「极浅」依次尝试，取第一个能过对比度的
const BG_MIXES = [0.88, 0.9, 0.92, 0.94]

// ── 预处理：每个分类的「可用候选」（自带过了 C3 的 bg）────────
/** 为一个分类色挑最合适的浅底：保证对比度 ≥ c3，且尽量保留色调（优先用较小混合比） */
function pickBg(color, c3 = 3.0) {
  for (const t of BG_MIXES) {
    const bg = mix(color, '#FFFFFF', t)
    if (contrast(color, bg) >= c3) return bg
  }
  return null
}

/**
 * 给定一组语义色，穷举出满足 C1/C2/C3 的最佳分类色板。
 * @param {string} warnHex  当前试的 `--warn` 取值
 * @param {number} c1       分类色 vs 语义色的 ΔE 下限
 * @param {boolean} diag    是否打印「哪个分类没有候选、卡在哪一对」的诊断
 * @returns {{chosen: Array, minPair: number, minCt: number, minSem: number, score: number} | null}
 */
function solve(warnHex, c1, diag = false, c3 = 3.0) {
  const sem = { ...FIXED_SEM, 警示琥珀: warnHex }
  const semList = Object.values(sem)
  const semNames = Object.keys(sem)

  const CAND = {}
  const blockers = []
  for (const k of ORDER) {
    CAND[k] = []
    for (const color of POOL[k]) {
      const bg = pickBg(color, c3)
      if (!bg) continue
      const ds = semList.map((s) => deltaE(color, s))
      const minSem = Math.min(...ds)
      if (minSem < c1) continue
      CAND[k].push({ color, bg, minSem, ct: contrast(color, bg) })
    }
    if (!CAND[k].length) {
      // 诊断：这个分类全军覆没，是缺在对比度还是缺在离语义色太近？
      const detail = POOL[k].map((color) => {
        const bg = pickBg(color, c3)
        const ds = semList.map((s) => deltaE(color, s))
        const minIdx = ds.indexOf(Math.min(...ds))
        return { color, ct: bg ? contrast(color, bg) : null, minSem: ds[minIdx], near: semNames[minIdx] }
      })
      blockers.push({ k, detail })
    }
  }

  if (diag && blockers.length) {
    for (const b of blockers) {
      console.log(`    ⚠ ${LABEL[b.k]} 无候选（C1=${c1}）：`)
      for (const d of b.detail) {
        console.log(
          `        ${d.color}  离最近语义色 ${d.near} ΔE=${d.minSem.toFixed(1)}   对比度 ${d.ct ? d.ct.toFixed(2) : '过不了 3.0'}`
        )
      }
    }
  }

  if (blockers.length) return null

  let best = null
  function walk(i, chosen, stats) {
    if (i === ORDER.length) {
      const score = Math.min(stats.minPair, stats.minCt * 5)
      if (!best || score > best.score) best = { score, chosen: [...chosen], ...stats }
      return
    }
    for (const c of CAND[ORDER[i]]) {
      let minPair = stats.minPair
      let ok = true
      for (const prev of chosen) {
        const d = deltaE(c.color, prev.color)
        if (d < 20) {
          ok = false
          break
        }
        if (d < minPair) minPair = d
      }
      if (!ok) continue
      walk(i + 1, [...chosen, c], {
        minPair: chosen.length ? minPair : Infinity,
        minCt: Math.min(stats.minCt, c.ct),
        minSem: Math.min(stats.minSem, c.minSem)
      })
    }
  }

  walk(0, [], { minPair: Infinity, minCt: Infinity, minSem: Infinity })
  return best ? { ...best, warnHex, c1 } : null
}

const WARN_LABEL = new Map(WARN_CANDIDATES.map((w) => [w, `h${hueOf(w)}`]))

// ── 第一轮：固定 warn，找「C1 要放松到多少才有解」────────────
console.log('══════ 第一轮：分类色 vs 语义色的 ΔE 阈值该定多少？（warn 保持 #C77E1A 不动）══════\n')
for (const c1 of [25, 22, 20]) {
  const r = solve('#C77E1A', c1, c1 === 22)
  console.log(`  C1 ≥ ${c1}  ${r ? `✓ 有解（两两最挤 ΔE=${r.minPair.toFixed(1)}，最低对比度 ${r.minCt.toFixed(2)}:1）` : '✗ 无解'}`)
}

// ── 第二轮：在「有解的阈值」上，再把 warn 挪一遍看能不能抬回 25 ──
const SOLVABLE_C1 = [25, 22, 20].find((c) => solve('#C77E1A', c))
console.log(`\n══════ 第二轮：warn 挪位能不能把 C1 抬回 25？（当前可行阈值 ${SOLVABLE_C1}）══════\n`)
for (const w of WARN_CANDIDATES) {
  const r = solve(w, 25)
  console.log(`  warn=${w} (${WARN_LABEL.get(w)})  在 C1=25 下  ${r ? `✓ 有解  两两最挤 ΔE=${r.minPair.toFixed(1)}` : '✗ 无解'}`)
}

// ── 第三轮：对比度能抬到多高？ ───────────────────────────────
console.log(`\n══════ 第三轮：对比度 C3 能抬到多高？（固定 C1=${SOLVABLE_C1}）══════\n`)
let bestC3 = 3.0
for (const c3 of [4.5, 4.0, 3.5, 3.0]) {
  const r = solve('#C77E1A', SOLVABLE_C1, false, c3)
  console.log(`  C3 ≥ ${c3.toFixed(1)}:1  ${r ? `✓ 有解（实际最低 ${r.minCt.toFixed(2)}:1）` : '✗ 无解'}`)
  if (r && c3 > bestC3) bestC3 = c3
}
console.log(`  → 取 C3 = ${bestC3.toFixed(1)}:1`)

// ── 定档 ─────────────────────────────────────────────────────
let best = solve('#C77E1A', 25, false, bestC3)
let usedWarn = '#C77E1A'
if (!best) {
  for (const w of WARN_CANDIDATES) {
    const r = solve(w, 25, false, bestC3)
    if (r) {
      best = r
      usedWarn = w
      break
    }
  }
}
if (!best) {
  best = solve('#C77E1A', SOLVABLE_C1)
  usedWarn = '#C77E1A'
}
if (!best) {
  console.log('\n❌ 仍然无解。')
  process.exit(1)
}
console.log(`\n→ 采用：warn=${usedWarn}（${usedWarn === '#C77E1A' ? '不动语义色' : '已挪位'}），C1=${best.c1}`)
best.warnHex = usedWarn

// ── 输出 ─────────────────────────────────────────────────────
console.log('══════ 胜出色板 ══════\n')
ORDER.forEach((k, i) => {
  const c = best.chosen[i]
  console.log(`  ${LABEL[k].padEnd(4, '　')} color ${c.color}   bg ${c.bg}   (离最近语义色 ΔE ${c.minSem.toFixed(1)}，自己的对比度 ${c.ct.toFixed(2)}:1)`)
})

const sem = { ...FIXED_SEM, 警示琥珀: best.warnHex }
const semNames = Object.keys(sem)
const semList = Object.values(sem)

console.log('\n══════ 体格复查 ══════')

const C1_ACTUAL = best.c1
const C3_ACTUAL = bestC3
console.log(`\n① 分类色 vs 语义色（ΔE 阈值 ≥${C1_ACTUAL}）`)
console.log(`      色值      hue   ${semNames.map((n) => n.padStart(6, ' ')).join(' ')}`)
ORDER.forEach((k, i) => {
  const c = best.chosen[i].color
  const ds = semList.map((s) => deltaE(c, s))
  console.log(
    `  ${LABEL[k].padEnd(4, '　')} ${c} h${String(hueOf(c)).padStart(3)}  ${ds
      .map((d) => `${d < C1_ACTUAL ? '⚠' : ' '}${d.toFixed(0).padStart(3)}`)
      .join('   ')}`
  )
})

console.log('\n② 分类色两两之间（ΔE 阈值 ≥20）')
console.log(`       ${ORDER.map((k) => LABEL[k].padStart(4, '　')).join(' ')}`)
ORDER.forEach((k, i) => {
  const row = ORDER.map((k2, j) => {
    if (j <= i) return '   ·'
    const d = deltaE(best.chosen[i].color, best.chosen[j].color)
    return `${d < 20 ? '⚠' : ' '}${d.toFixed(0).padStart(3)}`
  })
  console.log(`  ${LABEL[k].padEnd(4, '　')} ${row.join('  ')}`)
})

console.log(`\n③ 对比度（阈值 ≥${C3_ACTUAL.toFixed(1)}）`)
ORDER.forEach((k, i) => {
  const c = best.chosen[i]
  const tag = c.ct >= 4.5 ? '✓ AA 正文' : c.ct >= 3.0 ? '△ 过 UI 组件线(3:1)' : '⚠ 连 3:1 都不过'
  console.log(`  ${LABEL[k].padEnd(4, '　')} ${c.color} on ${c.bg.toUpperCase()}  →  ${c.ct.toFixed(2)}:1  ${tag}`)
})

console.log('\n══════ 可直接粘贴的 CSS ══════\n')
ORDER.forEach((k, i) => {
  const c = best.chosen[i]
  console.log(`  --cat-${k}: ${c.color.toUpperCase()};`.padEnd(34) + `  --cat-${k}-bg: ${c.bg.toUpperCase()};`)
})
