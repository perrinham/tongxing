/**
 * 高德在线行程生成冒烟：验证「任意城市 → 高德抓池 → 规则引擎出草稿」全链路。
 *
 * 与其他冒烟不同：这个测试**真实调用高德 API**（key 在 src/config.ts），
 * 所以：1) 需要网络；2) 会消耗 key 配额（每次约 4 个请求）。
 * 由 scripts/amap-itin-test.mjs 用 esbuild 打包后跑。
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const workDir = mkdtempSync(join(tmpdir(), 'tx-amap-'))
const bundle = join(workDir, 'amap-itin.mjs')

function cleanup() {
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

try {
  console.log('· 打包…')
  await build({
    entryPoints: [join(root, 'scripts/amap-itin-entry.ts')],
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
