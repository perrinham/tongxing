/**
 * postbuild: 修复 Vue 3 mp-weixin 运行时 vendor.js 中 Ms() 函数的类型守卫缺失。
 *
 * 根因：Ms(e) 直接调用 e.split(",") 做组件 prop 缓存 key 解析，
 * 但 mp-weixin 适配器在某些页面（ProfilePage）会传入非字符串值（truthy 但非 string），
 * 导致 TypeError: e1.split is not a function。
 *
 * 修法：在 e.split 前加 typeof e !== "string" 守卫，非字符串直接 return undefined。
 * 这是纯防御性修复——Ms 的调用方期望拿到 undefined 时走兜底路径，不影响功能。
 *
 * 每次 build:mp-weixin 之后跑一次：npm run patch:vendor
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const vendorPath = resolve(__dirname, '../dist/build/mp-weixin/common/vendor.js')

const BEFORE = 'function Ms(e){if(!e)return;const[t,n]=e.split(",");return Rs[t]?Rs[t][parseInt(n)]:void 0}'
const AFTER  = 'function Ms(e){if(!e||typeof e!=="string")return;const[t,n]=e.split(",");return Rs[t]?Rs[t][parseInt(n)]:void 0}'

try {
  let code = readFileSync(vendorPath, 'utf8')
  if (code.includes(AFTER)) {
    console.log('[patch:vendor] 已打过，跳过')
    process.exit(0)
  }
  if (!code.includes(BEFORE)) {
    console.error('[patch:vendor] 未找到目标函数 Ms()，vendor.js 结构可能已变，请检查')
    process.exit(1)
  }
  code = code.replace(BEFORE, AFTER)
  writeFileSync(vendorPath, code, 'utf8')
  console.log('[patch:vendor] Ms() 类型守卫已修补')
} catch (e) {
  console.error('[patch:vendor] 失败:', e.message)
  process.exit(1)
}