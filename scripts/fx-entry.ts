/**
 * 汇率换算单测入口 —— 与 packing/expr 同套路：esbuild 打包后在 Node 上跑。
 * 由 scripts/fx-test.mjs 启动。
 */
import assert from 'node:assert/strict'
import { FX_CURRENCIES, FX_STAMP, fxRateOf, fxToCny } from '../src/utils/fx'

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

console.log('\n· 换算口径')

await spec('基本换算：1 USD ≈ 7.16', () => {
  assert.equal(fxToCny(1, 'USD'), 7.16)
  assert.equal(fxToCny(100, 'USD'), 716)
})

await spec('两位小数舍入（帐单入账最小精度）', () => {
  assert.equal(fxToCny(3, 'USD'), 21.48)
  assert.equal(fxToCny(1, 'GBP'), 9.1)
})

await spec('小汇率币种：JPY 100 → 4.8；VND 大额不出精度坑', () => {
  assert.equal(fxToCny(100, 'JPY'), 4.8)
  assert.equal(fxToCny(100000, 'VND'), 28)
  assert.equal(fxToCny(0.5, 'KRW'), 0)
})

await spec('非法输入 → null：未知币种 / 非有限数', () => {
  assert.equal(fxToCny(100, 'XYZ'), null)
  assert.equal(fxToCny(NaN, 'USD'), null)
  assert.equal(fxToCny(Infinity, 'JPY'), null)
})

await spec('负数允许通过（与算式求值器同一口径，保存层再拦 >0）', () => {
  assert.equal(fxToCny(-2, 'USD'), -14.32)
})

await spec('牌子面：≥10 个币种、code 唯一、汇率全为正的有限数', () => {
  assert.ok(FX_CURRENCIES.length >= 10, `共 ${FX_CURRENCIES.length} 个`)
  assert.ok(new Set(FX_CURRENCIES.map((c) => c.code)).size === FX_CURRENCIES.length)
  assert.ok(FX_CURRENCIES.every((c) => Number.isFinite(c.cny) && c.cny > 0))
})

await spec('常用目的地排在前面（USD/EUR/JPY/HKD 前 4）', () => {
  assert.deepEqual(
    FX_CURRENCIES.slice(0, 4).map((c) => c.code),
    ['USD', 'EUR', 'JPY', 'HKD']
  )
})

await spec('fxRateOf 与 fxToCny 一致；FX_STAMP 文案在', () => {
  assert.equal(fxRateOf('THB'), 0.21)
  assert.equal(fxRateOf('不存在'), null)
  assert.ok(FX_STAMP.includes('不实时'))
})

console.log(`\n===== 汇率换算结果：${passed} 通过 / ${failures.length} 失败 =====`)
if (failures.length) {
  console.error('失败用例：', failures.join('；'))
  process.exitCode = 1
}
