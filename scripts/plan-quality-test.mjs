/**
 * 行程校验器单测 runner —— 与 client-sync/city-smoke 同一套路，但不用起后端：
 *
 * 1. 用 esbuild 把 scripts/plan-quality-entry.ts（纯函数 + 类型别名，无 uni 依赖）
 *    打包成 Node 可执行的 ESM；
 * 2. 子进程跑，非零退出即失败。
 *
 * 校验器出网的部分（amap）在入口里用注入 fake 测，这里不需要任何真实网络与密钥。
 *
 * 用法：npm run itin:smoke
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundle = join(tmpdir(), `plan-quality-entry-${Date.now()}.mjs`)

function cleanup() {
  try {
    rmSync(bundle, { force: true })
  } catch {
    /* 忽略 */
  }
}

process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

try {
  console.log('· 打包行程校验器测试入口…')
  await build({
    entryPoints: [join(root, 'scripts/plan-quality-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: bundle,
    tsconfig: join(root, 'tsconfig.json'),
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' }
  })

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [bundle], { stdio: 'inherit' })
    child.on('exit', (c) => resolve(c ?? 1))
  })

  cleanup()
  process.exit(code)
} catch (e) {
  console.error('运行失败：', e instanceof Error ? e.message : e)
  cleanup()
  process.exit(1)
}
