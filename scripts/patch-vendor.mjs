/**
 * postbuild: 修复 Vue 3 mp-weixin 运行时 vendor.js 中组件 prop 缓存函数的类型守卫缺失。
 *
 * 根因：该函数直接调用 e.split(",") 做 prop 缓存 key 解析，
 * 但 mp-weixin 适配器在某些页面（ProfilePage）会传入非字符串值（truthy 但非 string），
 * 导致 TypeError: e1.split is not a function。
 *
 * 修法：在 e.split 前加 typeof e !== "string" 守卫，非字符串直接 return undefined。
 * 这是纯防御性修复——调用方期望拿到 undefined 时走兜底路径，不影响功能。
 *
 * 为什么按结构正则匹配而不是精确字符串：函数名/内部表名是压缩器分配的
 * （Ms/Rs → Ls/Ns 漂移过一次，删掉任何一个 src 文件都可能再漂），
 * 函数体结构才是稳定特征。每次 build:mp-weixin 之后自动跑（见 package.json）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const vendorPath = resolve(__dirname, '../dist/build/mp-weixin/common/vendor.js')

// 已打补丁的形态：if(!e||typeof e!=="string")return;
const PATCHED = /function (\w+)\((\w+)\)\{if\(!\2\|\|typeof \2!=="string"\)return;const\[(\w+),(\w+)\]=\2\.split\(","\);return (\w+)\[\3\]\?\5\[\3\]\[parseInt\(\4\)\]:void 0\}/
// 目标形态：if(!e)return;
const TARGET = /function (\w+)\((\w+)\)\{if\(!\2\)return;const\[(\w+),(\w+)\]=\2\.split\(","\);return (\w+)\[\3\]\?\5\[\3\]\[parseInt\(\4\)\]:void 0\}/

try {
  let code = readFileSync(vendorPath, 'utf8')
  if (PATCHED.test(code)) {
    console.log('[patch:vendor] 已打过，跳过')
    process.exit(0)
  }
  const m = code.match(TARGET)
  if (!m) {
    console.error('[patch:vendor] 未找到目标函数（prop 缓存 split 解析），vendor.js 结构可能已变，请检查')
    process.exit(1)
  }
  code = code.replace(TARGET, (_, fn, arg, k1, k2, table) => {
    return (
      `function ${fn}(${arg}){if(!${arg}||typeof ${arg}!=="string")return;` +
      `const[${k1},${k2}]=${arg}.split(",");` +
      `return ${table}[${k1}]?${table}[${k1}][parseInt(${k2})]:void 0}`
    )
  })
  writeFileSync(vendorPath, code, 'utf8')
  console.log(`[patch:vendor] ${m[1]}() 类型守卫已修补`)
} catch (e) {
  console.error('[patch:vendor] 失败:', e.message)
  process.exit(1)
}