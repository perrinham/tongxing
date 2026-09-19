/**
 * 测试用环境变量装载：esbuild 打包客户端代码时没有 Vite 的 import.meta.env，
 * config.ts 在 Node 里回退读 process.env。真正的 key 在 .env.local（已 gitignore），
 * 测试 runner 启动时调用本函数把它读进来，amap 真机调用测试才有 key 可用。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function loadEnvLocal(cwd = process.cwd()) {
  const file = resolve(cwd, '.env.local')
  try {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)="?([^"\n]*)"?$/)
      if (!m || !m[1].startsWith('VITE_')) continue
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {
    // .env.local 不存在 = 未配置高德 key，测试降级/跳过即可
  }
}