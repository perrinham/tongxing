/**
 * 行程生成阶段播报单测 runner —— 与 /packing、/fx 同一套路，纯函数不起后端。
 * 用法：npm run genstage:smoke
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundle = join(tmpdir(), `gen-stage-entry-${Date.now()}.mjs`)

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
  console.log('· 打包阶段播报测试入口…')
  await build({
    entryPoints: [join(root, 'scripts/gen-stage-entry.ts')],
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
