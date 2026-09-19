/**
 * 客户端同步冒烟测试的运行器。
 *
 * 做三件事：
 *   1. 用 esbuild 把 scripts/client-sync-entry.ts（+ 真实 store）打包成 Node 可执行的 ESM；
 *   2. 在独立端口 + 临时数据目录上拉起一个后端实例；
 *   3. 运行打包产物，结束后清理。
 *
 * 用法：npm run client:smoke
 *
 * 之所以要走打包：store 是 TypeScript + `@/` 路径别名 + 依赖 pinia，
 * Node 无法直接执行，而为了测试去改构建配置得不偿失。
 * esbuild 直接读 tsconfig 的 paths，一次打包几毫秒。
 */

import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const PORT = Number(process.env.CLIENT_SMOKE_PORT || 8790)
const BASE = `http://localhost:${PORT}`

const workDir = mkdtempSync(join(tmpdir(), 'tx-client-'))
const bundle = join(workDir, 'client-sync.mjs')
const dataDir = join(workDir, 'data')

let server = null

async function alive() {
  try {
    const r = await fetch(BASE + '/api/health')
    return r.ok
  } catch {
    return false
  }
}

/**
 * 后端日志缓冲。
 *
 * 早先用 `stdio: 'ignore'`，一旦后端在请求处理里抛异常（比如引用了不存在的名字），
 * 客户端只会看到一句 `{"error":"internal error"}`，完全不知道崩在哪 ——
 * 排查成本极高。这里把子进程的输出留下来，退出时如果有失败就一并打出来。
 */
let serverLog = ''

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
      // 账号体系：本地没有 AppID/Secret，用开发登录换确定性 openid；
      // SESSION_SECRET 固定下来，令牌签名才可复现（也避免退化成「随机密钥、重启即失效」）。
      WX_DEV_LOGIN: '1',
      WX_APPID: '',
      WX_SECRET: '',
      SESSION_SECRET: 'client-smoke-session'
    }
  })
  const collect = (buf) => {
    serverLog += String(buf)
    // 别无限增长：只留最后 8KB，够看崩在哪就够了
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
  console.log('· 打包客户端测试入口…')
  await build({
    entryPoints: [join(root, 'scripts/client-sync-entry.ts')],
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
  // 有失败就把后端日志尾部打出来 —— 客户端只能看到 {error:"internal error"}，
  // 真正的原因（异常类型 + 堆栈）只在后端那里。
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
