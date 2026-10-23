/**
 * 金额算式单测 runner —— 与 itin-check-test.mjs 同一套路，纯函数不起后端：
 *
 * 1. esbuild 打包 scripts/expense-expr-entry.ts（求值器无 uni 依赖）；
 * 2. 子进程跑，非零退出即失败。
 *
 * 用法：npm run expr:smoke
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundle = join(tmpdir(), `expense-expr-entry-${Date.now()}.mjs`)

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
  console.log('· 打包金额算式测试入口…')
  await build({
    entryPoints: [join(root, 'scripts/expense-expr-entry.ts')],
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
