/**
 * 设计令牌同步校验（纯 Node，零依赖）
 *
 * 背景：项目里有两套颜色来源 ——
 *   · `src/styles/theme.css` 的 CSS 变量（DOM 用）
 *   · `src/utils/format.ts` 的 `CANVAS_PALETTE` / `CANVAS_CATEGORY_COLORS`（canvas 与原生地图用）
 * 后者不可能引 CSS 变量（canvas 的 fillStyle 和微信原生 <map> 都读不到 var()），
 * 所以只能靠字面值硬编码。硬编码就会漂移，这个脚本就是防漂移的闸门。
 *
 * 校验八项：
 *   ① CANVAS_PALETTE 的每一项 == theme.css 里对应的 --token
 *   ② CANVAS_CATEGORY_COLORS 的每一项 == theme.css 里对应的 --cat-*
 *   ③ AVATAR_COLORS[0] == --brand（历史上是 #1D9E75，一个「看着一样」的绿）
 *   ④ 全仓搜一遍，确认没有漏网的旧色值还在源码里当硬编码
 *   ⑤ 头像初始字必须走 avatarInk（不能写死白色）
 *   ⑥ 海报顶部品牌带的底与字（brandDeep + 实白）
 *   ⑦ marker PNG 的**像素**必须和 CANVAS_PALETTE 一致（位图是烤进去的，④ 扫不到）
 *   ⑧ pages.json 的窗口/导航栏底色必须 == --bg-page（平台配置读不到 CSS 变量）
 *
 * 跑法：node scripts/check-token-sync.mjs
 * 退出码：0 全过；1 有漂移（可以直接进 CI / npm run verify）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import zlib from 'node:zlib'
import {
  parseThemeTokens,
  coverageLine,
  assertNoUnparsedOpaque,
  assertRequired
} from './lib/theme-tokens.mjs'

const ROOT = process.cwd()
const FORMAT = join(ROOT, 'src/utils/format.ts')

// ── 1. 解析 theme.css 的变量表 ────────────────────────────────
/*
 * 解析 + 覆盖率断言走 `scripts/lib/theme-tokens.mjs`（三个闸门共用一份）。
 *
 * 这里原来有一份自己的 hex 正则。它对「换写法」的反应是**吵但指错方向**：
 * `--text-primary: rgb(28, 28, 30)` 收不到 → `tokens['--text-primary']` 是 undefined
 * → ② 拿 undefined 和镜像表比，报出来的是「格式对不上」，
 * 使用者盯着 `#1C1C1E` 和 `rgb(28, 28, 30)` 看不出哪里不一样（其实颜色完全相同）。
 * 换成解析层直接拦下并说清是「换了写法」，一行就够。
 */
const { tokens, decls: THEME_DECLS, missed: THEME_MISSED } = parseThemeTokens(ROOT)
assertNoUnparsedOpaque(THEME_MISSED, '令牌同步闸门')
/** ①②③④ 会逐项比对的令牌：format.ts 的两张镜像表 + pages.json 的底色 */
const REQUIRED_TOKENS = [
  '--bg-page', '--bg-card', '--bg-subtle', '--bg-sunken', '--text-inverse',
  '--text-primary', '--text-secondary', '--text-tertiary',
  '--line', '--line-strong',
  '--brand', '--brand-deep', '--brand-soft', '--accent', '--accent-deep', '--warn', '--warn-deep', '--danger',
  ...['food', 'transport', 'stay', 'ticket', 'shopping', 'entertain', 'other'].flatMap((k) => [
    `--cat-${k}`,
    `--cat-${k}-bg`
  ])
]
assertRequired(tokens, REQUIRED_TOKENS, '令牌同步闸门')

// ── 2. 解析 format.ts 的两张镜像表 ────────────────────────────
const formatSrc = readFileSync(FORMAT, 'utf8')

function parseConstObject(src, name) {
  const start = src.indexOf(`export const ${name}`)
  if (start < 0) throw new Error(`找不到 export const ${name}`)
  const open = src.indexOf('{', start)
  // 花括号配平，找到对象的结尾
  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) throw new Error(`${name} 的花括号没配平`)
  const body = src.slice(open + 1, end)

  const out = {}
  // 只取 `key: '#XXXXXX'` 这种直接字面量的条目；
  // 形如 `CANVAS_PALETTE.brand` 的间接引用单独处理（见 ③）
  for (const m of body.matchAll(/(\w+)\s*:\s*'#([0-9A-Fa-f]{6,8})'/g)) {
    out[m[1]] = `#${m[2].toUpperCase()}`
  }
  return { out, body, raw: src.slice(start, end + 1) }
}

const canvasPal = parseConstObject(formatSrc, 'CANVAS_PALETTE')
const catColors = parseConstObject(formatSrc, 'CANVAS_CATEGORY_COLORS')

// ── 3. 期望的映射关系 ────────────────────────────────────────
// CANVAS_PALETTE 的 JS 键 -> theme.css 的 CSS 变量名
const CANVAS_MAP = {
  brand: '--brand',
  brandDeep: '--brand-deep',
  accent: '--accent',
  accentDeep: '--accent-deep',
  warn: '--warn',
  warnDeep: '--warn-deep',
  danger: '--danger',
  bgPage: '--bg-page',
  bgCard: '--bg-card',
  bgSubtle: '--bg-subtle',
  textInverse: '--text-inverse',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textTertiary: '--text-tertiary'
}

let fail = 0
const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
const bad = (msg) => {
  fail++
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`)
}

console.log('\n═══ 输入校验：theme.css 的令牌解析 ═══')
console.log(`  ${coverageLine(THEME_DECLS, THEME_MISSED, REQUIRED_TOKENS.length)}`)

console.log('\n═══ ① CANVAS_PALETTE ↔ theme.css ═══')
for (const [jsKey, cssVar] of Object.entries(CANVAS_MAP)) {
  const jsVal = canvasPal.out[jsKey]
  const cssVal = tokens[cssVar]
  if (!jsVal) bad(`${jsKey} 在 CANVAS_PALETTE 里缺失`)
  else if (!cssVal) bad(`${cssVar} 在 theme.css 里缺失`)
  else if (jsVal !== cssVal) bad(`${jsKey} = ${jsVal}，但 ${cssVar} = ${cssVal}`)
  else ok(`${jsKey.padEnd(14)} = ${cssVar.padEnd(16)} ${jsVal}`)
}

console.log('\n═══ ② CANVAS_CATEGORY_COLORS ↔ theme.css ═══')
for (const [k, jsVal] of Object.entries(catColors.out)) {
  const cssVal = tokens[`--cat-${k}`]
  if (!cssVal) bad(`--cat-${k} 在 theme.css 里缺失`)
  else if (jsVal !== cssVal) bad(`CANVAS_CATEGORY_COLORS.${k} = ${jsVal}，但 --cat-${k} = ${cssVal}`)
  else ok(`${k.padEnd(12)} = --cat-${k}`.padEnd(30) + jsVal)
}
// 反向：theme.css 里有 --cat-* 但 JS 表里没有
for (const t of Object.keys(tokens)) {
  const m = t.match(/^--cat-([a-z]+)$/)
  if (m && !catColors.out[m[1]]) bad(`--cat-${m[1]} 在 theme.css 里有，但 CANVAS_CATEGORY_COLORS 里没有`)
}

console.log('\n═══ ③ AVATAR_COLORS[0] 必须就是 --brand ═══')
{
  const brand = tokens['--brand']
  // AVATAR_COLORS 的第一项要么直接写字面值，要么引 CANVAS_PALETTE.brand
  const avatarBlock = formatSrc.slice(formatSrc.indexOf('export const AVATAR_COLORS'))
  const firstLiteral = avatarBlock.match(/\[\s*\n\s*'#([0-9A-Fa-f]{6})'/)
  const firstRef = /\[\s*\n\s*CANVAS_PALETTE\.brand/.test(avatarBlock)
  if (firstRef) ok(`AVATAR_COLORS[0] 引用 CANVAS_PALETTE.brand（= ${brand}）`)
  else if (firstLiteral && `#${firstLiteral[1].toUpperCase()}` === brand) ok(`AVATAR_COLORS[0] = ${brand}`)
  else if (firstLiteral) bad(`AVATAR_COLORS[0] = #${firstLiteral[1].toUpperCase()}，但 --brand = ${brand}`)
  else bad('认不出 AVATAR_COLORS[0] 的写法')
}

console.log('\n═══ ④ 源码里不该再有「另一个绿」等旧色值 ═══')
// 这些是历史上出现过的、与令牌「看着一样但不是同一个」的色值。
// 允许出现在 theme.css 的说明性注释里（那是记录历史），但不允许出现在任何代码位置。
// `#E03B30` 是旧的 --danger：压白底 4.34:1，差一点点不到 AA。加进来防回退。
const DEAD = [
  '#1D9E75',
  '#15795A',
  '#F8F7F4',
  '#2C2C2A',
  '#F1EFE8',
  '#888780',
  '#5F5E5A',
  '#378ADD',
  '#E03B30',
]
// `#15795A` 是旧的 `--brand-deep` —— 和 `#1D9E75` 同一性质：**「另一个绿」**，
// 看着像品牌色但不是。它现在只活在注释里（记录历史），加进来是为了防「改回去」。

/*
 * 同一个旧色值有**两种拼写**：`#F8F7F4` 和 `rgba(248, 247, 244, 0)`。
 * 这条扫描原来只认十六进制，于是「米色底」以 rgb 形式活了下来：
 * 三处 `linear-gradient(to top, var(--bg-page) 72%, rgba(248, 247, 244, 0))`
 * —— 渐变轴端点写的是**另一个底色**的 RGB，肉眼在浅色上几乎看不出来，但它就是旧视觉的残留。
 * 所以每个 DEAD 值同时生成「分量形式」的正则，两种拼写一起查。
 */
const deadRgbPattern = (hex) => {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
  return new RegExp(`rgba?\\(\\s*${r}\\s*,\\s*${g}\\s*,\\s*${b}\\s*[,)]`)
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const full = join(dir, e)
    if (statSync(full).isDirectory()) walk(full, acc)
    else if (/\.(ts|vue|js|mjs|css|json)$/.test(e)) acc.push(full)
  }
  return acc
}

/**
 * 算出每一行是不是注释行。
 * 必须跨行跟踪 `/* … *\/` 的状态 —— 只用「行首像不像注释」判断会漏掉块注释的续行，
 * 于是「注释里说明历史色值」会被误报成残留（这个脚本第一版就是这么误报的）。
 */
function computeCommentLines(src) {
  const lines = src.split('\n')
  const flags = new Array(lines.length).fill(false)
  let inBlock = false
  lines.forEach((line, i) => {
    let idx = 0
    let isComment = inBlock
    // 逐段扫描本行，处理 `/* */` 的开合与 `//`
    while (idx < line.length) {
      if (inBlock) {
        const close = line.indexOf('*/', idx)
        if (close < 0) {
          isComment = true
          break
        }
        isComment = true
        inBlock = false
        idx = close + 2
        continue
      }
      const open = line.indexOf('/*', idx)
      const lc = line.indexOf('//', idx)
      if (lc >= 0 && (open < 0 || lc < open)) {
        // `//` 之前的代码部分不算注释，之后的算
        if (lc === 0 || /^\s*$/.test(line.slice(0, lc))) isComment = true
        break
      }
      if (open >= 0) {
        inBlock = true
        idx = open + 2
        // 继续循环处理这一行里的 */
        continue
      }
      break
    }
    flags[i] = isComment || inBlock || /^\s*(\/\/|\/\*|\*)/.test(line)
  })
  return flags
}

const files = walk(join(ROOT, 'src'))
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const lines = src.split('\n')
  const commentFlags = computeCommentLines(src)
  lines.forEach((line, i) => {
    if (commentFlags[i]) return // 注释里记历史色值是有意的，跳过
    for (const dead of DEAD) {
      const asHex = line.toUpperCase().includes(dead)
      const asRgb = deadRgbPattern(dead).test(line)
      if (!asHex && !asRgb) continue
      // format.ts 的 AVATAR_COLORS 里合法保留了几项（身份色，见那里的待办注释）
      const isAvatarIdentity =
        f.endsWith('format.ts') && /AVATAR_COLORS/.test(src.slice(0, src.indexOf(line) + line.length)) && /^\s*'#/.test(line)
      if (isAvatarIdentity && dead === '#378ADD') {
        console.log(`  \x1b[33m•\x1b[0m ${relative(ROOT, f)}:${i + 1} ${dead} —— AVATAR_COLORS 的身份色，有意保留`)
        continue
      }
      bad(
        `${relative(ROOT, f)}:${i + 1} 出现旧色值 ${dead}${asHex ? '' : '（写成了 rgb()/rgba() 分量形式）'}：${line.trim()}`
      )
    }
  })
}
if (!fail) ok('没有发现旧色值残留（注释里记录历史的除外）')

console.log('\n═══ ⑤ 头像初始字必须走 avatarInk（不能写死白色）═══')
// 头像上的字只有 13px（size × 0.42），属 WCAG 小字，要 4.5:1。
// 10 个身份色里有 7 个压白字只有 3.18 ~ 3.93:1 —— 写死白色就是「糊」，而且不报错。
// 这条断言防的是「有人改回硬编码白」。
for (const rel of ['src/components/AppAvatar.vue', 'src/utils/poster.ts']) {
  const src = readFileSync(join(ROOT, rel), 'utf8')
  if (src.includes('avatarInk(')) ok(`${rel} 用 avatarInk(底色) 决定初始字颜色`)
  else bad(`${rel} 没有用 avatarInk —— 初始字颜色会被写死，小字对比度会掉到 4.5:1 以下`)
}

console.log('\n═══ ⑥ 海报顶部品牌带：底必须是 brandDeep，字必须是实白 ═══')
// 海报是 canvas 画的、会被导出发出去。原来带底用 brand(#1FA470) + 半透明白字：
//   半透明白 0.78/0.86/0.92 叠在品牌绿上 → 2.51 ~ 2.92:1，「总支出」这类 22px 全不过；
//   换成 brandDeep(#12724F) + 实白 → 5.92:1，所有字号都过。
{
  const posterSrc = readFileSync(join(ROOT, 'src/utils/poster.ts'), 'utf8')
  // 在 fillRect(0, 0, W, 300) 之前的一段里找最后一次 fillStyle 赋值
  const bandRect = posterSrc.indexOf('ctx.fillRect(0, 0, W, 300)')
  const before = bandRect < 0 ? '' : posterSrc.slice(Math.max(0, bandRect - 900), bandRect)
  const lastFill = [...before.matchAll(/ctx\.fillStyle\s*=\s*([^\n]+)/g)].pop()
  const bandFill = lastFill && /P\.brandDeep/.test(lastFill[1])
  if (bandFill) ok('品牌带底 = P.brandDeep（白字压它 5.92:1）')
  else
    bad(
      `品牌带底不是 P.brandDeep（现在是 ${lastFill ? lastFill[1].trim() : '找不到 fillStyle'}）` +
        ' —— 白字压 --brand 只有 3.18:1，22px 的标签过不了 AA'
    )

  /*
   * ⑥a-2) 品牌带上的**文字**色必须是 `P.textInverse`，不能借 `P.bgCard` 顶。
   * 两者今天同为 #FFFFFF，所以这不会影响观感 —— 它防的是**角色混用**：
   * `--bg-card` 是「卡片底」，哪天它不再是纯白（深色模式、换皮），
   * 借它当白字的地方会一起变色，而且没有任何东西会报警。
   * （同一类问题在 CSS 里已经栽过一次：`--line-strong` 同时被当线和当字。）
   */
  {
    const bandStart = posterSrc.indexOf('ctx.fillRect(0, 0, W, 300)')
    const bandEnd = posterSrc.indexOf('// 概览条')
    const band = bandStart < 0 || bandEnd < 0 ? '' : posterSrc.slice(bandStart, bandEnd)
    const borrowed = band.match(/fillStyle\s*=\s*P\.bgCard/g)
    const usesInverse = /fillStyle\s*=\s*P\.textInverse/.test(band)
    if (!band) bad('切不出品牌带那段代码 —— poster.ts 结构改过？')
    else if (borrowed) {
      bad(`品牌带上的文字有 ${borrowed.length} 处借了 P.bgCard 当白字 —— 应该用 P.textInverse（角色不同）`)
    } else if (!usesInverse) bad('品牌带上的文字没有用 P.textInverse')
    else if (!fail) ok('品牌带上的文字用 P.textInverse（没借 bgCard：底色角色和文字角色分开）')
  }

  const translucent = posterSrc.match(/rgba\(255,\s*255,\s*255[^)]*\)/g)
  if (translucent) bad(`海报里还有半透明白字 ${translucent.join(' ')} —— 叠在彩底上会把对比度拉到 3:1 以下`)
  else ok('海报里没有半透明白字（都用实色）')

  /*
   * ⑥b) 海报里不许有**手写的颜色字面量**。
   * 为什么单独一条：海报是 canvas 画的、会被导出发出去，而 ①~⑤ 全都只看 CSS 规则，
   * 一个字面量在 .ts 里它们一条都读不到。实测这里曾散着 4 处 `'#FFFFFF'` ——
   * 值上等于 bgCard，看着无害，但 `--bg-card` 一变它们就成了新的漂移源。
   * 「恰好相等」不是理由，唯一来源才是。
   */
  {
    const flags = computeCommentLines(posterSrc)
    const hits = []
    posterSrc.split('\n').forEach((line, i) => {
      if (flags[i]) return
      for (const m of line.matchAll(/['"](#[0-9A-Fa-f]{3,8})['"]/g)) {
        hits.push(`${i + 1} 行 ${m[1]}：${line.trim().slice(0, 60)}`)
      }
    })
    if (hits.length) {
      bad(
        `poster.ts 里有 ${hits.length} 处手写颜色字面量 —— 颜色只准从 P(=CANVAS_PALETTE) 取：\n      ${hits.join('\n      ')}`
      )
    } else if (!fail) {
      ok('poster.ts 里没有手写颜色字面量（颜色一律从 P 取，没走 CSS 的那部分也守住了）')
    }
  }
}

console.log('\n═══ ⑦ marker PNG 的像素色必须和 CANVAS_PALETTE 一致 ═══')
/*
 * 地图标记是**位图**：颜色在生成那一刻就烤进像素里了，源码里再怎么改都不会跟着变。
 * 这正是 ④ 扫不到的地方 —— ④ 只读文本文件（.ts/.vue/.css/.json），而 PNG 里的
 * 旧色是**字节**，永远不会以「#1D9E75」这种形式出现。
 *
 * 实际发生过：CityMapPage 的标签侧早就改成 `CANVAS_PALETTE.brand` / `.warn` 了，
 * 而生成 PNG 的脚本还写死 `[29,158,117]` / `[216,90,48]` —— 同一个状态在地图上
 * 是两个颜色：实测 ΔE = 6.6（绿）/ 29.2（橙红），后者比本项目的分类色两两阈值 20 还远。
 *
 * 所以这里**直接把 PNG 解开读中心像素**，而不是只检查脚本源码 ——
 * 脚本对、但 PNG 忘了重新生成，同样应该红。
 */
function markerCenterPixel(file) {
  const buf = readFileSync(file)
  let off = 8
  const idat = []
  let w = 0
  let h = 0
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!w || !idat.length) return null
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * 4 + 1 // 每行开头一个 filter 字节 + RGBA
  // 只认 filter=0（生成脚本就是这么写的）。有别的 filter 就不猜，返回 null
  for (let y = 0; y < h; y++) if (raw[y * stride] !== 0) return null
  const p = Math.floor(h / 2) * stride + 1 + Math.floor(w / 2) * 4
  const hex =
    '#' +
    [raw[p], raw[p + 1], raw[p + 2]]
      .map((v) => v.toString(16).padStart(2, '0').toUpperCase())
      .join('')
  return { hex, w, h, alpha: raw[p + 3] }
}
{
  const EXPECT = [
    ['marker-visited.png', '--brand'],
    ['marker-wish.png', '--warn']
  ]
  const DIRS = ['static', 'src/assets']
  for (const [file, varName] of EXPECT) {
    const want = tokens[varName]
    const got = []
    let local = 0
    for (const d of DIRS) {
      let res = null
      try {
        res = markerCenterPixel(join(ROOT, d, file))
      } catch (e) {
        bad(`${d}/${file} 解不开：${e.message}`)
        local++
        continue
      }
      if (!res) {
        bad(`${d}/${file} 读不出像素（filter 或格式变了？）`)
        local++
        continue
      }
      got.push({ d, hex: res.hex })
      if (res.hex !== want) {
        bad(`${d}/${file} 实心色 = ${res.hex}，但 ${varName} = ${want} —— 跑一下 npm run markers`)
        local++
      }
    }
    if (got.length === 2 && got[0].hex !== got[1].hex) {
      bad(`${file} 的两个副本像素不一致：${got.map((g) => `${g.d} ${g.hex}`).join(' vs ')}`)
      local++
    }
    if (!local) ok(`${file.padEnd(20)} 两个副本都是 ${want}`)
  }
}

console.log('\n═══ ⑧ pages.json 的窗口/导航栏底色必须 == --bg-page ═══')
/*
 * pages.json 的 `globalStyle` 里有 `navigationBarBackgroundColor` 与 `backgroundColor`，
 * 它们是**平台配置文件**里的字面值，同样读不到 CSS 变量。
 * 现在这两个值等于 `--bg-page`（#F2F2F7），但此前没有任何东西守着这个相等关系 ——
 * 一旦 `--bg-page` 调整，导航栏/窗口回弹区就会和页面底裂成两块色
 * （这个项目已经因为「同一个色被写成两个相近值」栽过一次，见 ④）。
 */
{
  let pj = null
  try {
    pj = JSON.parse(readFileSync(join(ROOT, 'src/pages.json'), 'utf8'))
  } catch (e) {
    bad(`src/pages.json 解析失败：${e.message}`)
  }
  if (pj) {
    const g = pj.globalStyle || {}
    const want = tokens['--bg-page']
    let local = 0
    for (const key of ['navigationBarBackgroundColor', 'backgroundColor']) {
      const got = g[key]
      if (!got) {
        bad(`pages.json 的 globalStyle 缺 ${key}`)
        local++
      } else if (String(got).toUpperCase() !== want) {
        bad(`${key} = ${got}，但 --bg-page = ${want} —— 导航栏/窗口底会和页面底裂成两块色`)
        local++
      }
    }
    if (!local) ok(`navigationBarBackgroundColor / backgroundColor 都 = ${want}`)
  }
}

console.log('\n' + '─'.repeat(60))
if (fail) {
  console.log(`\x1b[31m令牌同步校验失败：${fail} 处不一致\x1b[0m\n`)
  process.exit(1)
}
console.log('\x1b[32m令牌同步校验通过：两套色板同值，无旧色值残留\x1b[0m\n')
