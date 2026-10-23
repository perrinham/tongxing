/**
 * 金额算式求值 —— 记账键盘支持直接输「聚餐 68+35×2」。
 *
 * 为什么不用 eval / new Function：小程序运行时没有可控沙箱，算式必须手写解析。
 * 标准表达式文法（加减低优先、乘除高优先、支持一元负号），递归下降 ~40 行；
 * 任何非法输入**返回 null 而不抛异常** —— 页面拿 null 就当「还不能保存」，
 * 分支成本为零，也不会把解析错误冒成运行时错误。
 *
 * 归一化兜位（键盘只产出 + - × ÷，这里再宽容一层，未来开放粘贴也不炸）：
 *   × x X * ＊ → *；÷ / ／ → /；− – — → -；＋ → +；内部空格剥掉。
 *
 * 纯函数模块：无 uni / store 依赖，esbuild 打包即可在 Node 里单测
 * （scripts/expense-expr-test.mjs）。
 */

interface Pos {
  i: number
}

/** '68+35×2' → 138；非法/未写完 → null。结果按分取整，避免 0.1+0.2 型浮点尾巴 */
export function evalAmountExpr(text: string): number | null {
  const s = text
    .trim()
    .replace(/[×xX＊]/g, '*')
    .replace(/[÷/／]/g, '/')
    .replace(/[−–—]/g, '-')
    .replace(/＋/g, '+')
    .replace(/\s+/g, '')
  if (!s || s.length > 30) return null
  // 白名单字符集（- 放在末尾免转义），挡掉字母/括号/分号等一切危险输入
  if (!/^[\d*+./-]+$/.test(s)) return null

  const pos: Pos = { i: 0 }
  const v = parseExpr(s, pos)
  if (v === null || pos.i !== s.length) return null
  const cents = Math.round(v * 100)
  if (!Number.isFinite(cents)) return null
  return cents / 100
}

// expr := term (('+'|'-') term)*
function parseExpr(s: string, pos: Pos): number | null {
  let v = parseTerm(s, pos)
  if (v === null) return null
  while (pos.i < s.length) {
    const c = s[pos.i]
    if (c !== '+' && c !== '-') break
    pos.i++
    const r = parseTerm(s, pos)
    if (r === null) return null
    v = c === '+' ? v + r : v - r
  }
  return v
}

// term := factor (('*'|'/') factor)*
function parseTerm(s: string, pos: Pos): number | null {
  let v = parseFactor(s, pos)
  if (v === null) return null
  while (pos.i < s.length) {
    const c = s[pos.i]
    if (c !== '*' && c !== '/') break
    pos.i++
    const r = parseFactor(s, pos)
    if (r === null) return null
    if (c === '/' && r === 0) return null // 除零对金额无意义
    v = c === '*' ? v * r : v / r
  }
  return v
}

// factor := '-' factor | number   （一元只留负号：正号没用，拒了减少歧义）
function parseFactor(s: string, pos: Pos): number | null {
  const c = s[pos.i]
  if (c === '-') {
    pos.i++
    const v = parseFactor(s, pos)
    return v === null ? null : -v
  }
  return parseNumber(s, pos)
}

// number := digits ('.' digits?)?，容忍 '35.'（写到一半的点在保存前会补上或删掉）
function parseNumber(s: string, pos: Pos): number | null {
  const m = /^\d+(?:\.\d*)?|\.\d+/.exec(s.slice(pos.i))
  if (!m) return null
  pos.i += m[0].length
  const v = Number(m[0])
  return Number.isFinite(v) ? v : null
}
