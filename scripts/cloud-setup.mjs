/**
 * 用开发者工具的自动化端口，从小程序运行时里直接调**已部署的云函数**。
 *
 * 为什么不用 miniprogram-automator：它连上后工具会推一条没有 id 的 error 事件，
 * 库内部 emit('error') 自己没监听 → Node 直接抛栈（同 scripts/mp-walk.mjs 的坑）。
 * 协议本身是干净的 JSON-RPC，这里手写一版。
 *
 * 用法：
 *   1. npm run build:mp-weixin
 *   2. npm run devtools                                     （打开项目）
 *   3. cli auto --project dist/build/mp-weixin --auto-port 9420
 *   4. node scripts/cloud-setup.mjs            # 建集合
 *      node scripts/cloud-setup.mjs --verify   # 建集合 + 端到端验证
 */
import WebSocket from 'ws'

const WS = process.env.MP_WS || 'ws://127.0.0.1:9420'
const ENV = process.env.MP_CLOUD_ENV || 'cloud1-d9gujmuaxb69ab976'
const VERIFY = process.argv.includes('--verify')

const ws = new WebSocket(WS)
const pending = new Map()
let seq = 0

function send(method, params = {}) {
  const id = `r${++seq}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) pending.delete(id), reject(new Error(`${method} 超时`))
    }, 60000).unref?.()
  })
}

const ready = new Promise((resolve, reject) => {
  ws.on('open', resolve)
  ws.on('error', reject)
  ws.on('unexpected-response', (_req, res) => reject(new Error(`握手被拒：HTTP ${res.statusCode}（自动化端口没开？先跑 cli auto）`)))
  // 没有超时的话，端口没开时脚本会静默挂死 —— 这类脚本挂死比报错难查得多
  setTimeout(() => reject(new Error(`连不上 ${WS}（20s 无响应）`)), 20000).unref?.()
})

ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString())
  if (!msg.id) return // 工具主动推的事件，忽略
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
})

await ready

// 在小程序运行时里执行一段代码（App.callFunction 协议），返回其返回值。
// 注意：必须传**函数源码字符串** —— bind 过的函数 toString() 是 "[native code]"，
// 工具端会解析失败（实测报 "Unexpected identifier 'code'"）。
async function evaluate(decl) {
  const { result } = await send('App.callFunction', { functionDeclaration: decl, args: [] })
  return result
}

async function callCloud(name, data) {
  return evaluate(`async function () {
    if (!wx.cloud) throw new Error('wx.cloud 不存在（基础库过低或未开云开发）')
    await wx.cloud.init({ env: ${JSON.stringify(ENV)} })
    const r = await wx.cloud.callFunction({ name: ${JSON.stringify(name)}, data: ${JSON.stringify(data)} })
    return r.result
  }`)
}

let failed = 0
function report(label, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`)
  if (!ok) failed += 1
}

console.log('已连上', WS, '环境', ENV)

console.log('\n· 建集合')
for (const fn of ['trips', 'guides']) {
  try {
    const r = await callCloud(fn, { action: 'setup' })
    report(`${fn} setup`, !!r && r.ok === true, JSON.stringify(r?.collections || r))
  } catch (e) {
    report(`${fn} setup`, false, e.message)
  }
}

if (!VERIFY) {
  ws.close()
  process.exit(failed ? 1 : 0)
}

console.log('\n· auth')
let token = ''
let openid = ''
try {
  // 云函数不拿 code 换 openid（身份来自 getWXContext），但契约仍要求 code 存在，
  // 所以这里给个占位值 —— 真机上是 uni.login 拿到的真 code。
  const login = await callCloud('auth', { action: 'wxLogin', code: 'cloud-setup-probe' })
  openid = login?.openid || ''
  token = login?.token || ''
  report('wxLogin 拿到 openid', !!openid, openid)
  report('wxLogin 拿到 token', /^cloud:/.test(token), token.slice(0, 24) + '…')
  const me = await callCloud('auth', { action: 'authMe', token, loggedIn: true })
  report('authMe 回显同一 openid', me?.openid === openid, JSON.stringify(me))
} catch (e) {
  report('auth 链路', false, e.message)
}

console.log('\n· trips')
try {
  // 形状以 BackendClient 接口为准（src/services/backend.ts:195）：{ spaces: [...] }
  const list = await callCloud('trips', { action: 'list', withDoc: false, token, loggedIn: true })
  report('list 返回 { spaces }', Array.isArray(list?.spaces), `spaces=${list?.spaces?.length ?? JSON.stringify(list).slice(0, 200)}`)
} catch (e) {
  report('trips list', false, e.message)
}

console.log('\n· guides')
try {
  const cities = await callCloud('guides', { action: 'listCities' })
  report('listCities 返回 { cities }', Array.isArray(cities?.cities), `cities=${cities?.cities?.length ?? JSON.stringify(cities).slice(0, 200)}`)
} catch (e) {
  report('guides listCities', false, e.message)
}

console.log('\n· weather（云函数出网，真实调用 Open-Meteo）')
try {
  const args = { action: 'weather', place: '成都', start: '2026-09-22', end: '2026-09-24' }
  // 第一次可能是冷启动（Node 函数冷启动本身就要 1~3s，默认超时正好 3s），
  // 所以连打两次：冷/热分开看，才知道失败是「超时」还是「出网不通」。
  const cold = await callCloud('weather', args)
  const warm = await callCloud('weather', args)
  const shape = (r) => (Array.isArray(r?.days) ? `days=${r.days.length} source=${r.source}` : JSON.stringify(r).slice(0, 200))
  report('weather 冷启动调用', Array.isArray(cold?.days), shape(cold))
  report('weather 热调用', Array.isArray(warm?.days), shape(warm))
} catch (e) {
  report('weather', false, e.message)
}

console.log('\n· 写路径往返（push → get → delete，验证 records/tombstones 集合与 LWW 写入）')
const stamp = Date.now()
const spaceId = 'cloudcheck' + stamp
try {
  const doc = {
    trip: {
      title: '云体检行程',
      destination: '成都',
      startDate: '2026-09-22',
      endDate: '2026-09-24',
      currency: '¥',
      budget: 1000,
      memberIds: [],
      createdAt: stamp,
      updatedAt: stamp
    },
    members: [],
    days: [],
    items: [],
    expenses: [],
    polls: [],
    votes: [],
    meetups: [],
    locations: []
  }
  const pushed = await callCloud('trips', {
    action: 'push', id: spaceId, author: '云体检', deviceId: 'cloud-setup',
    baseRev: null, doc, tombstones: [], token, loggedIn: true
  })
  report('push 建空间并分配分享码', !!pushed?.space?.code, `code=${pushed?.space?.code} rev=${pushed?.serverRev}`)

  const got = await callCloud('trips', { action: 'get', id: spaceId, token, loggedIn: true })
  report('get 读回同一空间', got?.space?.id === spaceId, `id=${got?.space?.id}`)
  report('get 读回文档内容（records 写入成功）', got?.space?.doc?.trip?.title === '云体检行程', got?.space?.doc?.trip?.title)

  const listed = await callCloud('trips', { action: 'list', token, loggedIn: true })
  report('list 含新空间', !!listed?.spaces?.some((s) => s.id === spaceId))

  const removed = await callCloud('trips', { action: 'delete', id: spaceId, token, loggedIn: true })
  report('delete 清理成功', removed?.ok === true, JSON.stringify(removed).slice(0, 120))

  // 删除是「软删」：默认列表仍要返回它（客户端靠墓碑同步删除动作，口径同自托管
  // server/lib/db.mjs 的 listSpaces），只有 active=1 才过滤掉。
  const after = await callCloud('trips', { action: 'list', token, loggedIn: true })
  const row = after?.spaces?.find((s) => s.id === spaceId)
  report('delete 后默认列表仍带墓碑（deleted=true）', row?.deleted === true, JSON.stringify(row).slice(0, 160))

  const active = await callCloud('trips', { action: 'list', active: true, token, loggedIn: true })
  report('active=1 时列表不含已删空间', !active?.spaces?.some((s) => s.id === spaceId))
} catch (e) {
  report('trips 写路径', false, e.message)
}

console.log('\n· 攻略写路径往返（upsert → listMine → delete）')
try {
  const up = await callCloud('guides', {
    action: 'upsert', cityName: '体检城', author: '云体检',
    status: 'visited', rating: 5, token, loggedIn: true
  })
  report('upsert 返回 guide', !!up?.guide?.id, `id=${up?.guide?.id}`)

  const mine = await callCloud('guides', { action: 'listMine', token, loggedIn: true })
  report('listMine 含刚写的攻略', !!mine?.guides?.some((g) => g.id === up?.guide?.id), `mine=${mine?.guides?.length}`)

  const del = await callCloud('guides', { action: 'delete', id: up?.guide?.id, token, loggedIn: true })
  report('delete 清理成功', del?.ok === true, JSON.stringify(del).slice(0, 120))
} catch (e) {
  report('guides 写路径', false, e.message)
}

console.log('')
if (failed) {
  console.error(`cloud-setup 失败：${failed} 项`)
  ws.close()
  process.exit(1)
}
console.log('cloud-setup 全部通过')
ws.close()
process.exit(0)
