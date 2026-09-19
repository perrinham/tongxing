let counter = 0

/** 生成短唯一 ID */
export function uid(prefix = ''): string {
  counter = (counter + 1) % 100000
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 7)
  const c = counter.toString(36)
  return `${prefix}${prefix ? '_' : ''}${t}${c}${r}`
}
