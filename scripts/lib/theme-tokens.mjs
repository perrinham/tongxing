/**
 * theme.css 的令牌解析 + 解析覆盖率断言 —— 三个闸门（token-sync / contrast / palette）共用一份。
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────
 *
 * 三份脚本原来各自写了一遍同一个正则：
 *
 *   /(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})\s*;/g
 *
 * 它**只认十六进制**。而这个项目已经学过一次「同一份东西散在多处、各漂各的」的教训
 * （见 check-palette.mjs 里「审计脚本一旦漂移，比没有更糟」），所以合成一份。
 *
 * ── 它治的是什么病 ───────────────────────────────────────────────
 *
 * 「同一个颜色的第二种拼写」：`#66666E` 和 `rgb(102, 102, 110)` 是**同一个颜色**，
 * 但上面的正则只收前者。收不到时的后果按脚本分两种，**两种都是静默**：
 *
 *   · 色板体检（palette）：`VARS['--cat-food'] || '#000000'` 回退成**纯黑** →
 *     黑离谁都远，三项数字全部**变好看**（实测 ΔE 23.5→38.5、对比度 3.09→3.31），
 *     真实越界被盖住，EXIT=0。（已实测）
 *
 *   · 对比度闸门（contrast）：解析不了的颜色在 `resolve()` 里返回 null，
 *     调用处一句 `if (!bg || !fg) continue` 就把这一对**从审计里丢掉**。
 *     实测把 `--text-primary` 写成 `rgb(28, 28, 30)`（视觉完全一致）之后：
 *     45 条配对 → **37 条**，输出仍是「37 条配对全部达标」「对比度闸门通过」，**EXIT=0**。
 *     而 --text-primary 正是正文墨色的主令牌 —— 消失的恰好是正文那批配对。
 *
 * 另外 46/52 个令牌只经 `resolve('var(--x)')` 消费。换成 rgb() 写法后它们不会崩，
 * 只会静默地让配对消失；只有那 6 个被 `TOKENS['--x']` 直接解引用的会抛
 * `TypeError: Cannot read properties of undefined` —— 退出码虽然非 0，
 * 但那是**撞运气**，而且给出的诊断信息是零（堆栈指向 `hex.replace`，没人能看懂该改哪儿）。
 *
 * ── 判定口径 ─────────────────────────────────────────────────────
 *
 * 松扫描拿到 theme.css 里**所有** `--x: <值>;` 声明，紧解析只收十六进制，两者做差：
 *
 *   · 差集里的值**不透明**（`rgb(r,g,b)` / `hsl(...)` / 纯字母色名）→ **判失败**。
 *     它明明可以写成 hex，是纯粹的写法漂移，闸门不该装作没看见。
 *   · 差集里的值**带 alpha**（`rgba(...)` / `hsla(...)`）→ **放行**，但进覆盖率行。
 *     半透明表达不了成 hex，alpha 本身是信息（`--hairline` 就是）
 *     —— 注意这一类的配对确实不参与体检，覆盖率行就是让这件事看得见。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HEX_ONLY = /(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})\s*;/g
const ANY_DECL = /(--[a-z0-9-]+)\s*:\s*([^;{]+);/g
/** 值「看起来是颜色」：hex / rgb() / hsl() / 纯字母色名（`red`、`white`） */
const COLORISH = /^(#|rgba?\(|hsla?\(|[a-z]+$)/
/** 带 alpha 的写法 —— 表达不了成 hex，放行但记账。
 *  注意必须**要求第 4 个分量**：`rgb(102,102,110)` 也是 `rgba?\(` 开头，
 *  少了这一条它会被误判成「带 alpha 所以放行」—— 那正是本次要治的病。 */
const HAS_ALPHA =
  /^rgba\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*\)$|^hsla\(|^rgba?\([^)]*\/[^)]*\)$/i

/**
 * @param {string} dir  项目根（`process.cwd()`）
 * @param {string} [rel] 相对路径
 * @returns {{tokens: Record<string,string>, decls: [string,string][], missed: [string,string][]}}
 *          tokens = 紧解析收走的（key 带 `--`，值为大写 hex）
 *          decls  = 松扫描看到的所有声明
 *          missed = decls 里「看起来是颜色但紧解析没收走」的
 */
export function parseThemeTokens(dir, rel = 'src/styles/theme.css') {
  const src = readFileSync(join(dir, rel), 'utf8')
  const tokens = {}
  for (const m of src.matchAll(HEX_ONLY)) tokens[m[1]] = m[2].toUpperCase()
  const decls = [...src.matchAll(ANY_DECL)].map((m) => [m[1], m[2].trim()])
  const missed = decls.filter(([k, v]) => !tokens[k] && COLORISH.test(v))
  return { tokens, decls, missed }
}

/**
 * 覆盖率行 —— 让「有多少声明真的参检」这件事**每次都看得见**。
 * 不判失败，只报告：数量缩水本身就是要被看见的信号。
 */
export function coverageLine(decls, missed, checked) {
  const alpha = missed.filter(([, v]) => HAS_ALPHA.test(v))
  const head = `解析覆盖：theme.css ${decls.length} 条声明，${checked} 条参检`
  if (!missed.length) return `${head}，无遗漏`
  const parts = missed.map(([k, v]) => `${k}(=${v})`).join('、')
  return alpha.length === missed.length
    ? `${head}；${missed.length} 条带 alpha 未参检 —— ${parts}`
    : `${head}；${missed.length} 条未参检 —— ${parts}`
}

/**
 * 紧解析漏掉「本来能写成 hex」的声明 → 直接判失败。
 *
 * 这里**故意不返回布尔值让调用方自己决定**：
 * 三个闸门都必须硬失败，没有「这次就算了」的场景。
 *
 * @param {[string,string][]} missed
 * @param {string} gate 闸门名（打印用）
 */
export function assertNoUnparsedOpaque(missed, gate) {
  const fatal = missed.filter(([, v]) => !HAS_ALPHA.test(v))
  if (!fatal.length) return
  console.error(`\n\x1b[31m✗ ${gate}无法开始：theme.css 里有颜色令牌换了写法，解析不到\x1b[0m`)
  for (const [k, v] of fatal) {
    console.error(`    ${k}: ${v}  —— 这是不透明的颜色，本可以写成十六进制`)
  }
  console.error(
    '\n  为什么必须硬失败，而不是「解析不了就跳过」：跳过的后果是**静默的两种**——' +
      '\n    · 回退成默认值 → 算出一份不存在的色板，数字通常更好看（黑/白离谁都远）；' +
      '\n    · 调用处 continue → 这一对凭空从审计里消失，配对数缩水而结论仍写「全部达标」。' +
      '\n  两种都会让真实越界被盖住。改法二选一：值写回 #RRGGBB，或把解析正则扩到这种写法。\n'
  )
  process.exit(1)
}

/**
 * 本闸门**依赖**的令牌必须存在 —— 这条防的是「令牌被整个删掉」。
 *
 * 「换写法」与「被删掉」需要两条不同的检查：
 *   · 换写法：文件里还有声明，但紧解析收不到 → 靠 `missed`；
 *   · 被删掉：文件里连声明都没有 → 松扫描也看不到，`missed` 天然抓不到。
 *
 * @param {Record<string,string>} tokens
 * @param {string[]} required
 * @param {string} gate
 */
export function assertRequired(tokens, required, gate) {
  const missing = required.filter((t) => !tokens[t])
  if (!missing.length) return
  console.error(`\n\x1b[31m✗ ${gate}无法开始：theme.css 里缺少本闸门依赖的令牌\x1b[0m`)
  for (const t of missing) console.error(`    ${t}`)
  console.error(
    '\n  令牌被删掉时松扫描也看不见（没有声明可看），所以本闸门另记一份依赖清单。' +
      '\n  要么把令牌补回来，要么同步更新清单和依赖它的样式。\n'
  )
  process.exit(1)
}
