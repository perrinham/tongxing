/**
 * 金额算式求值单测入口 —— 由 scripts/expense-expr-test.mjs 用 esbuild 打包后跑。
 *
 * 覆盖四组面：
 *  · 正确性：优先级、左结合、一元负号、取整尾巴；
 *  · 别名归一：全角/键盘变体（× x ÷ ／ −）；
 *  · 非法拒识：截断、除零、白名单外字符 —— 一律 null 不抛异常；
 *  · 键盘序列回归：自绘键盘实际敲出来的串必须与预期一致（前导零顶替、段内小数）。
 */
import assert from 'node:assert/strict'
import { evalAmountExpr } from '../src/utils/amountExpr'

let passed = 0
const failures: string[] = []

async function spec(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(name)
    console.log(`  ✗ ${name}`)
    console.log(`    ${e instanceof Error ? e.message : e}`)
  }
}

const eq = (expr: string, want: number | null, label = '') => {
  const got = evalAmountExpr(expr)
  assert.equal(
    got,
    want,
    `${label || ''}evalAmountExpr(${JSON.stringify(expr)}) = ${got}，期望 ${want}`
  )
}

console.log('\n· 求值正确性')

await spec('加减乘除基础与优先级', () => {
  eq('68+35*2', 138)
  eq('100-35', 65)
  eq('2+3*4', 14)
  eq('2*3+4', 10)
  eq('8/4*2', 4, '左结合')
  eq('10-2-3', 5, '左结合')
  eq('7/2', 3.5)
  eq('+68', null, '一元正号不支持（一元只留负号）')
})

await spec('小数与舍入尾巴', () => {
  eq('0.1+0.2', 0.3, '浮点尾巴按分取整')
  eq('68.50+35', 103.5)
  eq('1/3', 0.33)
  eq('10/4', 2.5)
  eq('5.', 5, '写到一半的小数点当完成值')
  eq('.5', 0.5, '粘贴来的 .5 兜住')
  eq('68*.5', 34, '.5 粘贴容忍的连带结果')
})

await spec('别名归一（键盘是 ×÷-，粘贴可能带 x／−）', () => {
  eq('6×7', 42)
  eq('6x7', 42)
  eq('6X7', 42)
  eq('6*7', 42)
  eq('1÷4', 0.25)
  eq('1/4', 0.25)
  eq('1／4', 0.25)
  eq('1−4', -3)
  eq('1＋4', 5)
  eq('68 + 35 × 2 ', 138, '内部空格剥掉')
})

await spec('一元负号（结果可为负，保存层再拦 >0）', () => {
  eq('-5', -5)
  eq('3*-2', -6)
  eq('5--3', 8)
})

await spec('非法拒识：null 不抛异常', () => {
  eq('', null)
  eq('   ', null)
  eq('68+', null, '截断')
  eq('+68', null, '前导运算符')
  eq('68++35', null)
  eq('68*.5..', null, '乘后接点无操作数')
  eq('10/0', null, '除零')
  eq('10/0.0', null)
  eq('(2+3)', null, '括号不支持，宁可拒识')
  eq('68.35.2', null)
  eq('..5', null)
  eq('5..', null)
  eq('abc', null)
  eq('68;ls', null, '白名单外字符')
  eq('6 8', 68, '空格剥掉后就是 68（内置键盘不可能，粘贴容忍）')
})

console.log('\n· 键盘序列回归')

await spec('前导零顶替与段内小数点', () => {
  // 模拟自绘键盘敲 0 → 5：'0' 段被顶掉
  eq('0', 0)
  // 可由键位产出的合法长表达式
  eq('168+999.99-200', 967.99)
  eq('50×3÷2', 75)
})

await spec('超长拒识（防粘贴式攻击/卡顿）', () => {
  const long = '1+'.repeat(20)
  eq(long, null)
})

console.log(`\n===== 金额算式结果：${passed} 通过 / ${failures.length} 失败 =====`)
if (failures.length) {
  console.error('失败用例：', failures.join('；'))
  process.exitCode = 1
}
