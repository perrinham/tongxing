/**
 * 真小程序走查（开发者工具自动化端口）。
 *
 * 为什么不用 `miniprogram-automator`：它连上后工具会推一条 **没有 id 的 `error` 事件**，
 * 库内部 `emit('error')` 而自己没挂监听 —— Node 的 EventEmitter 对未监听的 error 事件
 * 直接抛栈，脚本在第一条消息就崩了（实测：`Uncaught [object Object]`）。
 * 协议本身是干净的 JSON-RPC，所以这里手写一版，顺带把「事件」全部收进 errors 数组。
 *
 * 用法：
 *   1. npm run build:mp-weixin
 *   2. npm run devtools                        （打开项目）
 *   3. cli auto --project dist/build/mp-weixin --auto-port 9420
 *   4. node scripts/mp-walk.mjs
 */
import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'

const WS = process.env.MP_WS || 'ws://127.0.0.1:9420'
const OUT = process.env.MP_OUT || 'shots-ios'
const WAIT = Number(process.env.MP_WAIT || 1800)

const ws = new WebSocket(WS)
const pending = new Map()
const events = []
let seq = 0

function send(method, params = {}) {
  const id = `r${++seq}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) pending.delete(id), reject(new Error(`${method} 超时`))
    }, 15000).unref?.()
  })
}

const ready = new Promise((resolve, reject) => {
  ws.on('open', resolve)
  ws.on('error', reject)
})

ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString())
  if (!msg.id) {
    // 工具主动推的事件（没有 id）。exceptionThrown 是「只在小程序端现形」的缺陷的唯一信号。
    events.push({ method: msg.method, params: msg.params })
    return
  }
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await ready
console.log('已连上', WS)

const stack = async () => {
  const { pageStack } = await send('App.getPageStack')
  return pageStack
}

async function shot(name) {
  const { data } = await send('App.captureScreenshot')
  const path = `${OUT}/mp-${name}.png`
  writeFileSync(path, Buffer.from(data, 'base64'))
  return path
}

const PAGES = process.env.MP_PAGES
  ? process.env.MP_PAGES.split(',')
  : ['SyncPage', 'MyGuidesPage', 'ProfilePage', 'CityMapPage']

for (const name of PAGES) {
  // 每个页面**单独清空事件** —— 否则只能知道「这一轮有 3 次异常」，
  // 不知道是哪个页面带来的，定位就停在半路。
  events.length = 0
  await send('App.callWxMethod', { method: 'reLaunch', args: [{ url: `/pages/${name}` }] })
  await sleep(WAIT)
  const st = await stack()
  const cur = st?.[st.length - 1]
  const badHere = events.filter((e) => /exception|error|Error/.test(e.method))
  console.log(`\n=== ${name} ===`)
  console.log('  实际停在', cur ? cur.route : '(空页面栈)')
  console.log('  本页异常', badHere.length, '条')
  for (const e of badHere) console.log('    ', String(e.params?.message || e.method).slice(0, 160))
  const path = await shot(name)
  console.log('  截图', path)
}

const bad = events.filter((e) => /exception|error|Error/.test(e.method))
console.log('\n─── 事件 ───')
console.log('  共', events.length, '条；其中异常类', bad.length, '条')
for (const e of bad) console.log('   ', e.method, JSON.stringify(e.params).slice(0, 300))
ws.close()
process.exit(0)
