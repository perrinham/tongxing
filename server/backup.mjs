/**
 * 数据随 Space 仓库备份 / 恢复 —— 服务 Hugging Face Spaces 免费部署。
 *
 * 免费容器的磁盘是临时的：Space 重建（代码更新、长时间休眠后重启）会清空
 * DATA_DIR，SQLite 里的同步数据全部丢失。思路：把数据库放进 Space 仓库的
 * 检出目录（/app/_backup，容器里可写），定时 git push 回仓库 ——
 * 重建后新容器检出代码时数据随代码一起回来，恢复零逻辑。
 *
 * 使用（HF Space 设置里）：
 *   Secret   HF_TOKEN=hf_xxx（write 权限，用于 git push）
 *   Variable BACKUP_ENABLED=1
 *   Variable BACKUP_INTERVAL_MIN=60（可选，默认 60 分钟）
 *
 * 显式开关 BACKUP_ENABLED，默认关闭：本地 docker / 裸跑不受影响，smoke 不触碰。
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { log } from './lib/log.mjs'

/** 数据库三件套：主文件 + WAL/SHM（WAL 模式下三者一起拷才是完整快照） */
function dbFiles(fileBase) {
  return [fileBase, `${fileBase}-wal`, `${fileBase}-shm`]
}

/**
 * 恢复：DATA_DIR 里没有库而备份目录里有 → 拷回来。
 * 必须在 createDb 之前调用（createDb 会建一个空库）。
 */
export function restoreIfEmpty({ dataDir, backupDir, fileBase = 'travel.sqlite3' }) {
  try {
    const dst = join(dataDir, fileBase)
    const src = join(backupDir, fileBase)
    if (existsSync(dst) || !existsSync(src)) return
    mkdirSync(dataDir, { recursive: true })
    for (const f of dbFiles(fileBase)) {
      const s = join(backupDir, f)
      if (existsSync(s)) copyFileSync(s, join(dataDir, f))
    }
    log.info('已从备份目录恢复数据库', { from: backupDir, to: dataDir })
  } catch (e) {
    log.warn('恢复数据库失败（将以空库启动）', { err: String(e) })
  }
}

/**
 * 定时备份：拷库到备份目录 → git commit + push 回 Space 仓库。
 * 任何一步失败只 warn 不抛 —— 备份链路绝不能拖垮主服务，下一轮自会重试。
 */
export function startBackupLoop({ dataDir, backupDir, fileBase = 'travel.sqlite3', intervalMin = 60 }) {
  if (!Number.isFinite(intervalMin) || intervalMin <= 0) return

  const backupOnce = () => {
    try {
      const src = join(dataDir, fileBase)
      if (!existsSync(src)) return
      mkdirSync(backupDir, { recursive: true })
      let touched = false
      for (const f of dbFiles(fileBase)) {
        const s = join(dataDir, f)
        if (existsSync(s)) {
          copyFileSync(s, join(backupDir, f))
          touched = true
        }
      }
      if (!touched) return

      const run = (args) => execFileSync('git', args, { cwd: backupDir, stdio: 'pipe', timeout: 120_000 })
      run(['add', '-A', '.'])
      // diff --quiet 有变化时退出码 1 → 没变化就不 commit/push
      const hasDiff = (() => {
        try {
          run(['diff', '--cached', '--quiet'])
          return false
        } catch {
          return true
        }
      })()
      if (!hasDiff) return
      run(['-c', 'user.name=backup-bot', '-c', 'user.email=backup@local', 'commit', '-m', `chore(backup): auto data backup ${new Date().toISOString()}`])
      if (process.env.HF_TOKEN) {
        // -c 配置必须与子命令同次调用才生效
        run(['-c', `http.extraHeader=Authorization: Bearer ${process.env.HF_TOKEN}`, 'push', 'origin', 'HEAD'])
      } else {
        log.warn('未设置 HF_TOKEN，备份只落在容器内（重建会丢）——去 Space 设置里补 Secret')
        return
      }
      log.info('数据备份已推送', { backupDir })
    } catch (e) {
      log.warn('数据备份失败（下轮重试）', { err: String(e) })
    }
  }

  backupOnce()
  setInterval(backupOnce, intervalMin * 60_000).unref()
}
