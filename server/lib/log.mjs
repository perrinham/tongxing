/**
 * 结构化日志（JSON Lines）。
 * 用 LOG_LEVEL 控制：error | warn | info | debug，默认 info。
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }
const CURRENT = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info

function emit(lv, msg, extra) {
  if (LEVELS[lv] > CURRENT) return
  const line = { t: new Date().toISOString(), lv, msg }
  if (extra !== undefined) line.data = extra
  const out = lv === 'error' || lv === 'warn' ? process.stderr : process.stdout
  out.write(JSON.stringify(line) + '\n')
}

export const log = {
  error: (msg, extra) => emit('error', msg, extra),
  warn: (msg, extra) => emit('warn', msg, extra),
  info: (msg, extra) => emit('info', msg, extra),
  debug: (msg, extra) => emit('debug', msg, extra)
}
