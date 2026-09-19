/**
 * 环境自检 + 修复（幂等，多次运行无副作用）。新机器 clone / CI 上跑一次：
 *
 *   npm run fix:env
 *
 * 解决的问题（README 里记过的两个部署级坑）：
 *   1. vue-router 解析不到：`@dcloudio/uni-h5` 把 vue-router 当传递依赖嵌套安装，
 *      `uni-cli-shared` 在 `node_modules/vue-router` 顶层找不到它 → H5 构建报
 *      `Cannot find module 'vue-router/...'`。修法：顶层建软链指过去（README 已记录）。
 *   2. esbuild 平台二进制缺失/版本错位：vite@5 要 esbuild ^0.25，而 uni-cli-shared
 *      锁了 0.20.2，安装后可能只剩 0.20 的 bin，vite 构建直接崩。修法：按 esbuild
 *      package.json 期望的平台版本 `npm pack @esbuild/<platform>-<arch>` 补齐覆盖。
 *
 * 只在自己负责的问题上动手：没问题时报「OK」并退出 0，有问题才改。别当成万能修。
 */
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let problems = 0
let fixed = 0

const log = (msg) => console.log(`[fix-env] ${msg}`)
const ok = (msg) => log(`✓ ${msg}`)
const warn = (msg) => { log(`⚠ ${msg}`) }

function esbuildRepairDir() {
  // @esbuild/<platform>-<arch> 的安装目录（esbuild 包以 optionalDependencies 依赖它）
  let pkg
  try {
    pkg = require('esbuild/package.json')
  } catch {
    warn('esbuild 包不存在（先 npm install / npm ci）')
    return null
  }
  const target = `@esbuild/${process.platform}-${process.arch}`
  const dep = pkg.optionalDependencies?.[target]
  const installedDir = join(root, 'node_modules', '@esbuild', `${process.platform}-${process.arch}`)
  const esbuildBin = join(dirname(require.resolve('esbuild/package.json')), 'bin', 'esbuild')
  const esbuildVersionOk = (() => {
    try {
      // bin/esbuild 是原生二进制（postinstall 从平台包拷来），必须直接执行，不能用 node 拉起
      const out = execFileSync(esbuildBin, ['--version'], { encoding: 'utf8' })
      return /^0\.2[3-9]\.|^0\.(3[0-9]|[1-9][0-9])\./.test(out.trim())
    } catch {
      return false
    }
  })()
  return { pkg, target, dep, installedDir, esbuildVersionOk }
}

function fixViteEsbuild() {
  const info = esbuildRepairDir()
  if (!info) return
  if (info.esbuildVersionOk) {
    ok(`esbuild bin 可用（vite 要求 ^0.25，已有足够新版本）`)
    return
  }
  // 缺平台二进制：按 esbuild 期望的平台版本补齐；若已是期望版本仍是 0.20，需覆盖为 0.25
  const wantVer = info.dep || '0.25.12'
  warn(`esbuild 平台二进制 ${info.target} 缺失/过旧（期望 ${wantVer}），尝试 npm pack 补齐`)
  const work = join(tmpdir(), `fix-env-${process.pid}`)
  mkdirSync(work, { recursive: true })
  try {
    execFileSync('npm', ['pack', `${info.target}@${wantVer}`, '--silent', '--pack-destination', work], { stdio: 'inherit' })
    const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'))
    if (!tgz) throw new Error('npm pack 无输出')
    const unpack = join(work, 'u')
    mkdirSync(unpack, { recursive: true })
    execFileSync('tar', ['-xzf', join(work, tgz), '-C', unpack], { stdio: 'inherit' })
    mkdirSync(info.installedDir, { recursive: true })
    cpSync(join(unpack, 'package'), info.installedDir, { recursive: true })
    fixed++
    ok(`已补齐 ${info.target} → ${info.installedDir}`)
  } catch (err) {
    problems++
    warn(`补齐失败（${err.message}）。需要网络；离线可手动按 README「esbuild 覆盖」章节操作。`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function fixVueRouter() {
  try {
    require.resolve('vue-router')
    ok('vue-router 解析正常')
    return
  } catch {
    /* 走修复 */
  }
  const target = join(root, 'node_modules', '@dcloudio', 'uni-h5', 'node_modules', 'vue-router')
  const link = join(root, 'node_modules', 'vue-router')
  if (!existsSync(target)) {
    problems++
    warn('vue-router 连 @dcloudio/uni-h5 的嵌套副本都没有，请完整执行 npm install/npm ci')
    return
  }
  try {
    symlinkSync(target, link, 'junction')
    fixed++
    ok(`已创建软链 node_modules/vue-router → @dcloudio/uni-h5/node_modules/vue-router`)
  } catch (err) {
    problems++
    warn(`创建软链失败：${err.message}（可手动执行 README 里的对应命令）`)
  }
}

fixViteEsbuild()
fixVueRouter()

console.log(problems === 0 ? '\n[fix-env] 全部 OK' : `\n[fix-env] 完成，${fixed} 处已修复，${problems} 处未能自动处理（见上）`)
process.exit(problems === 0 ? 0 : 1)