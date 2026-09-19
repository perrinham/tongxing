/**
 * 把 git 的 `core.hooksPath` 指向仓库内的 githooks/ 目录。
 *
 * 零依赖方案（不引入 husky）：钩子脚本本身入库、可被版本控制，
 * 每台新机器 clone 后执行一次 `npm run hooks:install` 即启用。
 *
 * 当前钩子：githooks/pre-commit —— 提交前跑 npm run verify 全链。
 */
import { execFileSync } from 'node:child_process'

try {
  execFileSync('git', ['config', 'core.hooksPath', 'githooks'], { stdio: 'inherit' })
  console.log('已启用 githooks/（pre-commit 会跑 npm run verify，可用 --no-verify 跳过）')
} catch {
  console.error('设置 core.hooksPath 失败，请确认当前目录是 git 仓库（npm run hooks:install）')
  process.exit(1)
}