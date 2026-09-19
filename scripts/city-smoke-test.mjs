/**
 * 城市足迹冒烟测试的运行器。
 *
 * 做三件事：
 *   1. 用 esbuild 把 scripts/city-smoke-entry.ts（+ 真实 city store + 真实后端）打包；
 *   2. 在独立端口 + 临时数据目录上拉起一个后端实例；
 *   3. 运行打包产物，结束后清理。
 *
 * 用法：npm run city:smoke
 *
 * 跟 client-sync-test.mjs 一个套路：esbuild 是因为 store 是 TS + `@/` 别名 +
 * 依赖 pinia + 依赖 amap 服务模块，Node 直接 require 不动。
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const PORT = Number(process.env.CITY_SMOKE_PORT || 8791)
const BASE = `http://localhost:${PORT}`

const workDir = mkdtempSync(join(tmpdir(), 'tx-city-'))
const bundle = join(workDir, 'city-smoke.mjs')
const dataDir = join(workDir, 'data')

let server = null
let serverLog = ''

async function alive() {
  try {
    const r = await fetch(BASE + '/api/health')
    return r.ok
  } catch {
    return false
  }
}

async function ensureServer() {
  if (await alive()) {
    console.log(`· 复用已在运行的后端 ${BASE}`)
    return null
  }
  const child = spawn(process.execPath, [join(root, 'server/index.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      ALLOW_ANONYMOUS: '1',
      WX_DEV_LOGIN: '1',
      WX_APPID: '',
      WX_SECRET: '',
      SESSION_SECRET: 'city-smoke-session'
    }
  })
  const collect = (buf) => {
    serverLog += String(buf)
    if (serverLog.length > 8192) serverLog = serverLog.slice(-8192)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 150))
    if (await alive()) {
      console.log(`· 后端已启动 ${BASE}（数据目录 ${dataDir}）`)
      return child
    }
  }
  child.kill()
  throw new Error('后端启动超时：' + BASE + '\n' + serverLog)
}

function cleanup() {
  if (server) server.kill()
  try {
    rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

try {
  console.log('· 打包城市足迹测试入口…')
  await build({
    entryPoints: [join(root, 'scripts/city-smoke-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: bundle,
    tsconfig: join(root, 'tsconfig.json'),
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' }
  })

  server = await ensureServer()

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [bundle], {
      stdio: 'inherit',
      env: { ...process.env, TEST_BASE: BASE }
    })
    child.on('exit', (c) => resolve(c ?? 1))
  })

  cleanup()
  if (code !== 0 && serverLog.trim()) {
    console.error('\n--- 后端日志（末尾 8KB）---')
    console.error(serverLog.trim())
    console.error('--- 后端日志结束 ---\n')
  }
  process.exit(code)
} catch (e) {
  console.error('运行失败：', e instanceof Error ? e.message : e)
  cleanup()
  process.exit(1)
}
