/**
 * 共享后端 · 端到端冒烟测试
 *
 * 用法：npm run server:smoke   （或 node server/smoke.mjs）
 *
 * 会拉起**两个**隔离实例（独立端口 + 临时数据目录，不碰开发用的 8787）：
 *   · 主实例  —— 宽松配置，验证功能语义（城市攻略 + 行程同步）
 *   · 加固实例 —— 配置 AUTH_TOKEN / CORS 白名单 / 小体积上限 / 低限流，
 *                 验证防线是否真的生效（401 / 403-CORS / 413 / 429 / 405 …）
 * 若目标端口已有服务在跑，则直接复用。
 *
 * 覆盖：
 *   [1-10] 城市攻略：健康检查 / 多人发布 / 按城市读取 / upsert 幂等 /
 *          跨城市隔离 / 状态过滤 / 聚合 / PUT / DELETE / 按作者撤回 / 404
 *   [11]   行程同步：推送建空间 / 分享码加入 / 幂等 / LWW 冲突 / 墓碑删除 /
 *          旧快照不复活已删记录 / 删除空间 / 离线只推墓碑
 *   [12]   写入校验：字段白名单 / 超长截断告警 / 评分越界 / 非法 id /
 *          记录数上限截断 / 原型污染
 *   [13]   安全防线：鉴权 / CORS 白名单 / 安全响应头 / 请求 ID / 请求体上限 /
 *          限流 / 405 / 畸形 URI
 *   [14]   存储层：SQLite 持久化（优雅关闭后重启仍有数据）/ 写入按空间隔离 /
 *          旧 db.json 自动迁移与归档
 *   [15]   HLC 时钟：超前封顶 / 因果序（慢钟后改的赢）/ 无 hlc 老记录兼容 /
 *          陈旧 hlc 兜底（recordHlc 取较晚者）/ 定长编码字典序 / 幂等 / 服务端删除盖章
 *   [16]   字段级合并：不同字段各改一边两边都保住 / 补全映射 / 平局保留 base /
 *          幂等 / 老客户端整条 LWW / 非法字段名与时间戳被丢弃
 *   [17]   账号体系：身份模块纯逻辑（签名/过期/归一）/ 登录换 openid / 令牌篡改与借用 /
 *          两套凭据正交 / 空间归属与成员授权 / 无主空间兼容口径 / 认领 /
 *          攻略归属（昵称不再等于身份）
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { encodeHlc } from './lib/hlc.mjs'
import { createIdentity } from './lib/identity.mjs'
import { CLOSE, OPCODE, acceptKey, createFrameParser, createWsConnection, encodeFrame } from './lib/ws.mjs'
import { createHub } from './lib/hub.mjs'
import { createTripsRouter } from './routes/trips.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0

function ok(cond, label, extra) {
  if (cond) {
    pass++
    console.log('  ✓', label)
  } else {
    fail++
    console.log('  ✗', label, extra !== undefined ? JSON.stringify(extra) : '')
  }
}

function section(title) {
  console.log('\n' + title)
}

async function req(base, method, path, body, headers) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data, headers: res.headers }
}

async function alive(base) {
  try {
    const r = await fetch(base + '/api/health')
    return r.ok
  } catch {
    return false
  }
}

/** 在隔离端口 + 临时数据目录上拉起一个实例 */
async function ensure(name, port, env) {
  const base = `http://localhost:${port}`
  if (await alive(base)) {
    console.log(`· 复用已在运行的 ${name} 实例 ${base}`)
    return { base, child: null }
  }
  const dataDir = mkdtempSync(join(tmpdir(), `tx-smoke-${name}-`))
  const child = spawn(process.execPath, [join(__dirname, 'index.mjs')], {
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...env }
  })
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 150))
    if (await alive(base)) {
      console.log(`· 已启动 ${name} 实例 ${base}（数据目录 ${dataDir}）`)
      return { base, child }
    }
  }
  child.kill()
  throw new Error(`${name} 实例启动超时：${base}`)
}

// ───────────────────────── WebSocket 测试辅助 ─────────────────────────

/**
 * 极简 WS 客户端，直接建在 Node 22 的全局 WebSocket 上（undici 实现）。
 *
 * 用真客户端而不是自己拼帧：这样测试跑的是**真实**握手、真实掩码、
 * 真实分片 —— 换句话说，它能测出服务端协议的错，而不是测出我自己
 * 「以为协议长什么样」。帧编解码的边界情况另有纯函数用例覆盖。
 */
function makeWs(base, { path = '/api/ws', autoPong = true } = {}) {
  const url = String(base).replace(/^http/, 'ws') + path
  const ws = new WebSocket(url)
  const frames = []
  /** 已被某次 next() 消费掉的帧下标（不同断言各看各自的，互不抢帧） */
  const consumed = new Set()
  const waiters = []
  const closeWaiters = []
  let closed = null

  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    frames.push(msg)
    // 服务端的心跳是**应用层**消息，不自动回就会被判空闲。
    // 默认自动回，需要测「不回就断」时把 autoPong 关掉。
    if (autoPong && msg.t === 'ping') {
      try {
        ws.send(JSON.stringify({ t: 'pong', ts: msg.ts }))
      } catch {
        /* 连接已经关了 */
      }
    }
    for (const w of [...waiters]) {
      if (!w.pred(msg)) continue
      waiters.splice(waiters.indexOf(w), 1)
      clearTimeout(w.timer)
      w.resolve(msg)
    }
  })
  ws.addEventListener('close', (ev) => {
    closed = { code: ev.code, reason: ev.reason }
    for (const w of closeWaiters.splice(0)) w(closed)
  })

  const api = {
    frames,
    url,
    get closed() {
      return closed
    },
    send(obj) {
      ws.send(JSON.stringify(obj))
    },
    /** 与真实客户端一样：连上之后立刻发 hello（首帧鉴权） */
    hello(token, extra = {}) {
      api.send({ t: 'hello', token: token || '', key: extra.key ?? '', deviceId: extra.deviceId || 'smoke-ws' })
    },
    /** 等第一个匹配的**未消费**帧 */
    next(pred, ms = 3000, label = '') {
      for (let i = 0; i < frames.length; i += 1) {
        if (consumed.has(i)) continue
        if (pred(frames[i])) {
          consumed.add(i)
          return Promise.resolve(frames[i])
        }
      }
      return new Promise((resolve, reject) => {
        const w = {
          pred,
          resolve: (m) => {
            consumed.add(frames.indexOf(m))
            resolve(m)
          },
          timer: null
        }
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w)
          if (i >= 0) waiters.splice(i, 1)
          reject(new Error(`等帧超时（${label || 'any'}）；已收到 ${JSON.stringify(frames.map((f) => f.t))}`))
        }, ms)
        waiters.push(w)
      })
    },
    /** 数所有匹配的帧（不受消费状态影响） */
    count(pred) {
      return frames.filter(pred).length
    },
    waitClose(ms = 3000) {
      if (closed) return Promise.resolve(closed)
      return new Promise((resolve) => {
        closeWaiters.push(resolve)
        setTimeout(() => resolve(null), ms)
      })
    },
    close() {
      try {
        ws.close()
      } catch {
        /* 已经关了 */
      }
    },
    opened: new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(true))
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败：' + url)))
    })
  }
  return api
}

async function wsConnect(base, opts) {
  const c = makeWs(base, opts)
  await c.opened
  return c
}

/** 成功建连 → 发 hello → 等 ready，返回 { conn, ready } */
async function wsLogin(base, token, extra = {}) {
  const conn = await wsConnect(base, extra)
  conn.hello(token, extra)
  const ready = await conn.next((m) => m.t === 'ready', 3000, 'ready')
  return { conn, ready }
}

/**
 * 发一个「裸」的 upgrade 请求，看服务端在**握手阶段**怎么回。
 * 用 Node 的 http 客户端手写头，因为全局 WebSocket 不允许自定义 Origin
 * （这正是同源校验要挡的场景，所以它没法用 WebSocket 客户端来测）。
 */
function rawUpgrade(base, path, headers = {}) {
  const u = new URL(base)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
          ...headers
        }
      },
      (res) => {
        res.resume()
        resolve({ status: res.statusCode, headers: res.headers, upgraded: false })
      }
    )
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode, headers: res.headers, upgraded: true })
    })
    req.on('error', reject)
    req.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TOKEN = 'smoke-secret-token'// 主实例显式关掉微信登录相关的环境变量：否则开发者 shell 里若设置了 WX_DEV_LOGIN/WX_APPID，
// [17] 里那条「未配置 → 503」的断言就会随环境时红时绿。
const main = await ensure('主', 8788, {
  WX_DEV_LOGIN: '0',
  WX_APPID: '',
  WX_SECRET: '',
  SESSION_SECRET: 'smoke-main-session'
})
const hard = await ensure('加固', 8789, {
  AUTH_TOKEN: TOKEN,
  ALLOWED_ORIGINS: 'https://ok.example',
  MAX_BODY_BYTES: '1024',
  RATE_LIMIT: '40',
  RATE_WINDOW_MS: '60000'
})
// 账号体系实例：开 WX_DEV_LOGIN（无 AppID/Secret 也能换到确定性 openid），
// 固定 SESSION_SECRET 让签名可复现。单独一个实例，避免影响主实例的既有断言。
// ⚠️ 端口必须避开 [14] 自己用的那两个（STORE_PORT=8791 / MIG_PORT=8792）：
// `ensure` 与 `bootStore` 都会在目标端口已有服务时**直接复用**，
// 一旦撞上，[14] 的「重启后数据还在」就会跑在别人的实例上 —— 断言照过，但什么都没验到。
const ident = await ensure('账号', 8796, {
  WX_DEV_LOGIN: '1',
  SESSION_SECRET: 'smoke-session-secret'
})
// 凭据正交用例专用：同时配共享密钥与 SESSION_SECRET（与上面一致，令牌才能互通），
// 限流放得很宽 —— 加固实例的 RATE_LIMIT=40 是给 [13] 用的，拿它测别的会撞 429。
const cred = await ensure('凭据', 8797, {
  AUTH_TOKEN: TOKEN,
  SESSION_SECRET: 'smoke-session-secret',
  RATE_LIMIT: '5000'
})
// 实时专项实例：把时间参数压到「秒级」以便测心跳与合并窗口。
//   WS_PING_MS=1000       心跳 1s 一次。**不能再小了** —— index.mjs 里这个值有 1000 的下限
//                         （心跳比 1 秒还密是反常配置，不该被当成正常用法支持）
//   连两个周期（2000ms）不回任何消息就被判死 —— 「不回 pong 就断开」那条用例靠它
//   WS_AUTH_GRACE_MS=600  建连后 600ms 内必须发 hello
//   WS_COALESCE_MS=1200   合并窗口拉长，让「连续 3 次推送只发 1 条通知」变成确定性断言
//                         （默认 80ms 下 3 次 HTTP 往返有可能跨窗口，断言会变成看运气）
const rt = await ensure('实时', 8795, {
  WX_DEV_LOGIN: '1',
  SESSION_SECRET: 'smoke-session-secret',
  RATE_LIMIT: '5000',
  WS_PING_MS: '1000',
  WS_AUTH_GRACE_MS: '600',
  WS_COALESCE_MS: '1200',
  LOG_LEVEL: 'warn'
})

/** 主实例请求 */
const M = (m, p, b, h) => req(main.base, m, p, b, h)
/** 加固实例请求（默认带正确密钥，个别用例会覆盖） */
const H = (m, p, b, h) => req(hard.base, m, p, b, { 'X-Api-Key': TOKEN, ...(h || {}) })
/** 账号实例请求；带 openid 时自动附加会话令牌 */
const ID = (m, p, b, session) =>
  req(ident.base, m, p, b, session ? { 'X-Session-Token': session } : undefined)

/** [14] 存储层用例自己拉起/重启的实例，统一在 finally 里收尸 */
const extraChildren = []

const C = encodeURIComponent('成都')
const D = encodeURIComponent('大理')
const AUTHOR = encodeURIComponent('阿哲')

try {
  // ═══════════════ 城市攻略 ═══════════════

  section('[1] 健康检查')
  const h = await M('GET', '/api/health')
  ok(h.status === 200 && h.data.ok === true, 'GET /api/health -> ok:true', h.data)
  ok(typeof h.data.version === 'string' && !!h.data.counts, 'health 带版本与计数', h.data.version)

  section('[2] 阿哲发布成都攻略（去过）')
  const p1 = await M('POST', `/api/cities/${C}/guides`, {
    author: '阿哲',
    status: 'visited',
    visitDate: '2026-05-01',
    guide: 'Day1 宽窄巷子+人民公园鹤鸣茶社; Day2 熊猫基地早上7点去; Day3 都江堰',
    review: '火锅必吃蜀九香，春熙路人多但值得。整体节奏舒服。',
    rating: 5
  })
  ok(p1.status === 200 && !!p1.data.guide?.id, 'POST upsert 返回 guide', p1.data)
  ok(p1.data.guide?.guide?.includes('宽窄巷子'), '攻略文本已存')

  section('[3] Yuki 发布成都（想去，写想去理由）')
  const p2 = await M('POST', `/api/cities/${C}/guides`, {
    author: 'Yuki',
    status: 'wish',
    wishNote: '看阿哲的攻略种草了，最想去看熊猫和吃火锅'
  })
  ok(p2.status === 200 && p2.data.guide?.author === 'Yuki', '第二位作者写入成功', p2.data)
  ok(p2.data.guide?.id !== p1.data.guide?.id, '两条记录 id 不同')

  section('[4] 读取成都共享攻略（多人可见）')
  const g = await M('GET', `/api/cities/${C}`)
  ok(g.data.guides?.length === 2, '成都返回 2 条攻略', g.data.guides?.length)
  const authors = (g.data.guides || []).map((x) => x.author).sort()
  ok(JSON.stringify(authors) === JSON.stringify(['Yuki', '阿哲']), '作者为 Yuki + 阿哲', authors)

  section('[5] upsert 幂等：阿哲再次发布应更新而非新增')
  const p1b = await M('POST', `/api/cities/${C}/guides`, {
    author: '阿哲',
    rating: 4,
    review: '补充：宽窄巷子晚上更热闹'
  })
  ok(p1b.data.guide?.id === p1.data.guide?.id, '同一 (城市,作者) id 不变（upsert）')
  ok(p1b.data.guide?.rating === 4, '评分已更新为 4', p1b.data.guide?.rating)
  ok(p1b.data.guide?.guide?.includes('宽窄巷子'), '未传的字段保持原值（guide 仍在）')
  const g2 = await M('GET', `/api/cities/${C}`)
  ok(g2.data.guides?.length === 2, '成都仍是 2 条（没有重复插入）', g2.data.guides?.length)

  section('[6] Yuki 在大理发布（跨城市隔离）')
  await M('POST', `/api/cities/${D}/guides`, {
    author: 'Yuki',
    status: 'visited',
    guide: '洱海环湖骑行，双廊住一晚',
    rating: 5
  })
  const d = await M('GET', `/api/cities/${D}`)
  ok(d.data.guides?.length === 1, '大理独立 1 条', d.data.guides?.length)
  ok(d.data.guides?.[0]?.guide?.includes('洱海'), '大理内容正确')

  section('[7] 全量聚合 + 按状态过滤')
  const all = await M('GET', '/api/cities')
  ok(all.data.cities?.length === 2, '聚合出 2 个城市', all.data.cities?.map((c) => c.name))
  const visited = await M('GET', '/api/cities?status=visited')
  const vNames = (visited.data.cities || []).map((c) => c.name).sort()
  ok(JSON.stringify(vNames) === JSON.stringify(['大理', '成都'].sort()), 'status=visited -> 成都+大理', vNames)
  const wish = await M('GET', '/api/cities?status=wish')
  ok(JSON.stringify((wish.data.cities || []).map((c) => c.name)) === JSON.stringify(['成都']), 'status=wish -> 仅成都')

  section('[8] PUT 更新单条 / DELETE 删除')
  const upd = await M('PUT', `/api/guides/${p2.data.guide.id}`, { wishNote: '更想去看雪山' })
  ok(upd.status === 200 && upd.data.guide?.wishNote?.includes('雪山'), 'PUT 更新成功', upd.data)
  const del = await M('DELETE', `/api/guides/${p2.data.guide.id}`)
  ok(del.status === 200 && del.data.ok === true, 'DELETE 成功', del.data)
  const g3 = await M('GET', `/api/cities/${C}`)
  ok(g3.data.guides?.length === 1, '成都剩 1 条（Yuki 已删）', g3.data.guides?.length)

  section('[9] 按作者撤回（删城市时同步撤回我的攻略）')
  const beforeR = await M('GET', `/api/cities/${C}`)
  ok((beforeR.data.guides || []).some((x) => x.author === '阿哲'), '撤回前存在阿哲的攻略')
  const retract = await M('DELETE', `/api/cities/${C}/guides?author=${AUTHOR}`)
  ok(retract.status === 200 && retract.data.removed === 1, '撤回 1 条', retract.data)
  const afterR = await M('GET', `/api/cities/${C}`)
  ok(!(afterR.data.guides || []).some((x) => x.author === '阿哲'), '撤回后阿哲的攻略消失')
  ok(afterR.data.guides?.length === 0, '成都已无攻略', afterR.data.guides?.length)
  const otherCity = await M('GET', `/api/cities/${D}`)
  ok(otherCity.data.guides?.length === 1, '撤回只影响成都，大理不受影响')
  const noAuthorDel = await M('DELETE', `/api/cities/${C}/guides`)
  ok(noAuthorDel.status === 400, '缺 author 的撤回 -> 400', noAuthorDel.status)

  section('[10] 错误处理')
  ok((await M('GET', '/api/guides/nope')).status === 404, '不存在的 guide -> 404')
  ok((await M('GET', '/api/unknown')).status === 404, '未知路径 -> 404')
  const noAuthor = await M('POST', `/api/cities/${C}/guides`, { guide: '匿名测试' })
  ok(noAuthor.data.guide?.author === '匿名', '缺 author 时默认「匿名」', noAuthor.data.guide?.author)

  // ═══════════════ 行程同步 ═══════════════

  section('[11] 行程空间同步')
  const T = 'trip_smoke_001'
  const t0 = Date.now()
  const mkDoc = (over) => ({
    trip: {
      id: T,
      title: '成都四日 · 吃遍烟火',
      destination: '成都',
      startDate: '2026-10-01',
      endDate: '2026-10-04',
      currency: '¥',
      budget: 3500,
      memberIds: ['m1', 'm2'],
      createdAt: t0,
      updatedAt: t0
    },
    members: [
      { id: 'm1', name: '我', colorIndex: 0, weight: 1, isSelf: true, updatedAt: t0 },
      { id: 'm2', name: '阿哲', colorIndex: 1, weight: 1, updatedAt: t0 }
    ],
    days: [{ id: 'd1', date: '2026-10-01', index: 0, title: '第 1 天', note: '', updatedAt: t0 }],
    items: [
      {
        id: 'i1', dayId: 'd1', order: 0, time: '09:00', type: 'spot', title: '宽窄巷子',
        address: '', lat: 30.66, lng: 104.05, cost: 0, duration: 90, note: '', done: false, updatedAt: t0
      }
    ],
    expenses: [
      {
        id: 'e1', title: '蜀九香火锅', amount: 428, category: 'food', date: '2026-10-01',
        payerId: 'm2', participants: [{ memberId: 'm1', share: 1 }, { memberId: 'm2', share: 1 }],
        splitMode: 'even', note: '', createdAt: t0, updatedAt: t0
      }
    ],
    ...over
  })

  const s1 = await M('POST', `/api/trips/${T}`, { author: '阿哲', deviceId: 'dev_a', doc: mkDoc({}) })
  ok(s1.status === 200 && s1.data.space.rev === 1, 'A 首次推送 -> rev 1', s1.data.space)
  const code = s1.data.space.code
  ok(/^[A-Z0-9]{6}$/.test(code || ''), '分配 6 位分享码 ' + code)
  ok(s1.data.applied?.added === 6, '记账 6 条新增（行程+2成员+1天+1项+1账单）', s1.data.applied)
  ok(s1.data.doc.expenses.length === 1 && s1.data.doc.expenses[0].amount === 428, '账单已入库')

  const idem = await M('POST', `/api/trips/${T}`, { author: '阿哲', doc: mkDoc({}) })
  ok(idem.data.changed === false && idem.data.space.rev === 1, '重复推送幂等，rev 不涨', {
    changed: idem.data.changed,
    rev: idem.data.space.rev
  })

  // 注意：别把这个变量叫 `join` —— 会遮蔽 node:path 的 join，后面所有拼路径的代码都会炸
  const joined = await M('GET', `/api/trips/by-code/${code}`)
  ok(joined.status === 200 && joined.data.space.doc.members.length === 2, 'B 凭分享码加入，拿到 2 名成员')
  ok(joined.data.space.doc.expenses[0].title === '蜀九香火锅', '加入方能看到同一笔账单')
  ok((await M('GET', '/api/trips/by-code/ZZZZZZ')).status === 404, '错码 -> 404')
  ok((await M('GET', '/api/trips/by-code/ab')).status === 400, '码太短 -> 400')

  // B 新增成员（时间更新）
  const t1 = t0 + 60_000
  const s2 = await M('POST', `/api/trips/${T}`, {
    author: 'Yuki',
    baseRev: 1,
    doc: mkDoc({
      members: [
        ...mkDoc({}).members,
        { id: 'm3', name: '小林', colorIndex: 2, weight: 1, updatedAt: t1 }
      ]
    })
  })
  ok(s2.data.space.rev === 2, 'B 新增成员 -> rev 2', s2.data.space.rev)
  ok(s2.data.doc.members.length === 3, '合并后 3 名成员', s2.data.doc.members.length)
  ok(s2.data.staleBase === false, 'baseRev 一致 -> staleBase=false')

  // A 用两份成员的旧快照推回来
  const s3 = await M('POST', `/api/trips/${T}`, { author: '阿哲', baseRev: 2, doc: mkDoc({}) })
  ok(s3.data.doc.members.length === 3, 'A 的旧快照不会删掉 B 新增的成员', s3.data.doc.members.length)

  const s4 = await M('POST', `/api/trips/${T}`, {
    author: 'Yuki',
    baseRev: 1,
    doc: mkDoc({
      members: [
        { id: 'm1', name: '我', colorIndex: 0, weight: 1, updatedAt: t0 },
        { id: 'm2', name: '阿哲', colorIndex: 1, weight: 1, updatedAt: t0 },
        { id: 'm3', name: '小林', colorIndex: 2, weight: 1, updatedAt: t1 }
      ]
    })
  })
  ok(s4.data.staleBase === true, 'baseRev 过期 -> staleBase=true（提示别人改过）', s4.data.staleBase)

  // LWW
  const s5 = await M('POST', `/api/trips/${T}`, {
    author: '阿哲',
    doc: mkDoc({
      members: [
        { id: 'm1', name: '旧名字', colorIndex: 0, weight: 1, updatedAt: t0 },
        { id: 'm2', name: '阿哲', colorIndex: 1, weight: 1, updatedAt: t0 },
        { id: 'm3', name: '小林', colorIndex: 2, weight: 1, updatedAt: t1 }
      ]
    })
  })
  ok(s5.data.doc.members.find((m) => m.id === 'm1').name === '我', '更旧的 updatedAt 不覆盖（LWW）')

  const t2 = t0 + 120_000
  const s6 = await M('POST', `/api/trips/${T}`, {
    author: '阿哲',
    doc: mkDoc({
      members: [
        { id: 'm1', name: '我', colorIndex: 0, weight: 1, updatedAt: t2 },
        { id: 'm2', name: '阿哲', colorIndex: 1, weight: 1, updatedAt: t0 },
        { id: 'm3', name: '小林', colorIndex: 2, weight: 1, updatedAt: t1 }
      ]
    })
  })
  ok(s6.data.doc.members.find((m) => m.id === 'm1').updatedAt === t2, '更新的 updatedAt 覆盖')

  // 墓碑删除
  const s7 = await M('POST', `/api/trips/${T}`, {
    author: 'Yuki',
    tombstones: [{ kind: 'member', id: 'm3', deletedAt: t2 + 10_000 }]
  })
  ok(s7.data.doc.members.length === 2, '墓碑删除成员生效', s7.data.doc.members.length)

  const s8 = await M('POST', `/api/trips/${T}`, {
    author: '阿哲',
    doc: mkDoc({
      members: [
        { id: 'm1', name: '我', colorIndex: 0, weight: 1, updatedAt: t2 },
        { id: 'm2', name: '阿哲', colorIndex: 1, weight: 1, updatedAt: t0 },
        { id: 'm3', name: '小林', colorIndex: 2, weight: 1, updatedAt: t1 }
      ]
    })
  })
  ok(!s8.data.doc.members.some((m) => m.id === 'm3'), '已删成员不会被旧快照复活', s8.data.doc.members.map((m) => m.id))

  // 离线只推墓碑（doc: null）
  const tb = [{ kind: 'expense', id: 'e9', deletedAt: t2 + 20_000 }]
  const s9 = await M('POST', `/api/trips/${T}`, { author: 'Yuki', doc: null, tombstones: tb })
  ok(s9.status === 200 && Array.isArray(s9.data.doc.members), 'doc:null 仅推墓碑可用', s9.status)
  const s10 = await M('POST', `/api/trips/${T}`, { author: 'Yuki', doc: null, tombstones: tb })
  ok(s10.data.changed === false, '重复推同一墓碑 -> changed:false（幂等）')

  // 列表 / 详情 / 删除
  const list = await M('GET', '/api/trips')
  ok(list.data.spaces?.length === 1, '列表返回 1 个空间', list.data.spaces?.length)
  ok(list.data.spaces[0].counts.items === 1, '列表带条数概要', list.data.spaces[0].counts)
  ok((await M('GET', `/api/trips/${T}`)).data.space.doc.trip.title.includes('成都'), 'GET 单空间可取')
  ok((await M('GET', '/api/trips/no-such-trip')).status === 404, '不存在的空间 -> 404')

  const delSpace = await M('DELETE', `/api/trips/${T}`)
  ok(delSpace.status === 200 && delSpace.data.deleted === true, 'DELETE 空间成功', delSpace.data)
  ok((await M('GET', '/api/trips?active=1')).data.spaces.length === 0, '删除后不在「在用」列表')
  ok(
    (await M('GET', '/api/trips')).data.spaces.some((s) => s.id === T && s.deleted === true),
    '默认列表仍报告已删空间（否则别的设备永远学不到删除）'
  )
  ok((await M('GET', `/api/trips/${T}`)).data.space.deleted === true, '按 id 取已删空间带 deleted 标记')
  ok((await M('GET', `/api/trips/by-code/${code}`)).status === 404, '删除后分享码失效 -> 404')

  // ═══════════════ 写入校验 ═══════════════

  section('[12] 写入校验与清洗')
  const long = await M('POST', `/api/cities/${C}/guides`, {
    author: '长文本用户',
    guide: 'x'.repeat(6000),
    review: 'y'.repeat(2500),
    rating: 99,
    visitDate: '2026/13/45'
  })
  ok(long.data.guide.guide.length === 5000, 'guide 截断到 5000 字', long.data.guide.guide.length)
  ok(long.data.guide.review.length === 2000, 'review 截断到 2000 字', long.data.guide.review.length)
  ok(long.data.guide.rating === undefined, '越界 rating 被忽略', long.data.guide.rating)
  ok(long.data.guide.visitDate === undefined, '非法日期被忽略', long.data.guide.visitDate)
  ok(Array.isArray(long.data.warnings) && long.data.warnings.length >= 3, '返回 warnings 告知被截断', long.data.warnings)

  // 用原始 JSON 文本发送：对象字面量里的 __proto__ 会被 JS 引擎当原型赋值，
  // 只有字符串形式的 JSON 才会生成真正的 "__proto__" 自有属性，这样才测得到服务端。
  const dirty = await M(
    'POST',
    `/api/cities/${C}/guides`,
    JSON.stringify({
      author: '注入者',
      guide: '正常内容',
      evilField: '不该落库',
      __proto__: { polluted: 'yes' },
      constructor: { polluted: 'yes' }
    })
  )
  const dirtyJson = JSON.stringify(dirty.data.guide)
  ok(dirtyJson.indexOf('evilField') === -1, '未在白名单的字段被丢弃', Object.keys(dirty.data.guide))
  ok(dirtyJson.indexOf('polluted') === -1, '原型污染键未落库', dirtyJson.slice(0, 140))
  ok({}.polluted === undefined, 'Object.prototype 未被污染')

  const big = await M('POST', `/api/trips/trip_cap_test`, {
    author: '灌爆者',
    doc: {
      trip: { id: 'trip_cap_test', title: '大', updatedAt: t0 },
      members: Array.from({ length: 900 }, (_, i) => ({
        id: 'mc' + i, name: 'n' + i, colorIndex: 0, weight: 1, updatedAt: t0
      })),
      days: [], items: [], expenses: []
    }
  })
  ok(big.data.doc.members.length <= 200, '成员数被截到上限 200', big.data.doc.members.length)

  ok((await M('POST', '/api/trips/bad id', { author: 'x', doc: mkDoc({}) })).status === 400, '非法 trip id -> 400')
  ok((await M('POST', `/api/trips/${T}x`, { author: 'x', doc: { members: [] } })).status === 400, 'doc 缺 trip -> 400')

  // ═══════════════ 安全防线 ═══════════════

  section('[13] 安全防线（加固实例）')

  const noToken = await req(hard.base, 'GET', '/api/trips')
  ok(noToken.status === 401, '不带密钥 -> 401', { s: noToken.status, d: noToken.data })
  const badToken = await req(hard.base, 'GET', '/api/trips', undefined, { 'X-Api-Key': 'wrong' })
  ok(badToken.status === 401 && badToken.data.reason === 'bad-token', '错误密钥 -> 401 bad-token', badToken.data)
  const byBearer = await req(hard.base, 'GET', '/api/trips', undefined, { Authorization: 'Bearer ' + TOKEN })
  ok(byBearer.status === 200, 'Bearer 方式 -> 200', byBearer.status)
  const byApiKey = await H('GET', '/api/trips')
  ok(byApiKey.status === 200, 'X-Api-Key 方式 -> 200', byApiKey.status)
  const healthNoToken = await req(hard.base, 'GET', '/api/health')
  ok(healthNoToken.status === 200, '健康检查豁免鉴权 -> 200', healthNoToken.status)

  const corsOk = await H('GET', '/api/health', undefined, { Origin: 'https://ok.example' })
  ok(corsOk.headers.get('access-control-allow-origin') === 'https://ok.example', '白名单来源回显 ACAO')
  ok((corsOk.headers.get('vary') || '').includes('Origin'), '响应带 Vary: Origin')
  const corsBad = await H('GET', '/api/health', undefined, { Origin: 'https://evil.example' })
  ok(corsBad.headers.get('access-control-allow-origin') === null, '非白名单来源不下发 ACAO')

  ok(corsOk.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff')
  ok(corsOk.headers.get('x-frame-options') === 'DENY', 'X-Frame-Options: DENY')
  ok((corsOk.headers.get('cache-control') || '').includes('no-store'), 'Cache-Control: no-store')
  ok((await H('GET', '/api/health', undefined, { 'X-Request-Id': 'trace-abc' })).headers.get('x-request-id') === 'trace-abc', '回显 X-Request-Id')

  const tooBig = await H('POST', `/api/cities/${C}/guides`, { author: 'x', guide: 'z'.repeat(3000) })
  ok(tooBig.status === 413, '超过体积上限 -> 413', tooBig.status)

  let malformedStatus = 0
  try {
    malformedStatus = (await H('GET', '/api/cities/%E4%B8%AD%ZZ/guides')).status
  } catch {
    malformedStatus = -1
  }
  ok(malformedStatus === 400 || malformedStatus === 404, '畸形 URI 不会 500', malformedStatus)

  const wrongMethod = await H('PUT', '/api/trips')
  ok(wrongMethod.status === 405, '不支持的方法 -> 405', wrongMethod.status)
  ok((wrongMethod.headers.get('allow') || '').includes('GET'), '405 带 Allow 头', wrongMethod.headers.get('allow'))

  let rateLimited = null
  for (let i = 0; i < 80; i += 1) {
    const r = await H('GET', '/api/trips')
    if (r.status === 429) {
      rateLimited = r
      break
    }
  }
  ok(rateLimited !== null, '持续请求最终被限流 -> 429')
  if (rateLimited) {
    ok(Number(rateLimited.headers.get('retry-after')) > 0, '429 带 Retry-After', rateLimited.headers.get('retry-after'))
    ok(rateLimited.data.error === 'too many requests', '429 错误体正确', rateLimited.data)
  } else {
    ok(false, '429 带 Retry-After（未触发限流，跳过）')
    ok(false, '429 错误体正确（未触发限流，跳过）')
  }

  // ═══════════════ [14] 存储层（SQLite）═══════════════
  //
  // 前面所有用例都是走 HTTP 验语义，对底层是 JSON 还是 SQLite 无感 —— 这是好事（说明改造没破坏行为），
  // 但也就意味着它们**证明不了**存储层本身正确。这里补三件只有换引擎才需要验的事：
  //   1. 进程重启后数据还在（优雅关闭是否真的把数据落了盘）；
  //   2. 写入是按空间隔离的（改 A 不会动 B 的 rev）；
  //   3. 旧版 db.json 能被自动迁移进来，且旧文件被保留而非删除。

  section('[14] SQLite 存储：持久化 / 空间隔离 / 旧 JSON 迁移')

  const STORE_PORT = 8791
  const storeBase = `http://localhost:${STORE_PORT}`
  const storeDir = mkdtempSync(join(tmpdir(), 'tx-smoke-store-'))

  async function bootStore(dir, port) {
    const base = `http://localhost:${port}`
    const child = spawn(process.execPath, [join(__dirname, 'index.mjs')], {
      // 收一下输出：启动失败时把子进程日志一起抛出来，
      // 否则 `stdio: 'ignore'` 只会给你一句「启动超时」，完全不知道崩在哪。
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), DATA_DIR: dir }
    })
    let output = ''
    const collect = (d) => {
      output = (output + d).slice(-4000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    extraChildren.push(child)
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 150))
      if (await alive(base)) return child
    }
    child.kill()
    throw new Error(`存储实例启动超时：${base}\n--- 子进程输出 ---\n${output}`)
  }

  /** 发 SIGTERM 走优雅关闭（会 checkpoint + 关库），并等端口真正释放 */
  async function stopStore(child, port) {
    const base = `http://localhost:${port}`
    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      child.once('exit', finish)
      child.kill('SIGTERM')
      setTimeout(() => {
        child.kill('SIGKILL')
        finish()
      }, 4000)
    })
    for (let i = 0; i < 50; i += 1) {
      if (!(await alive(base))) return
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  let storeChild = await bootStore(storeDir, STORE_PORT)
  const SP = (m, p, b) => req(storeBase, m, p, b)

  const t0s = Date.now()
  const mkPersist = (id, title, dest, memberIds, updatedAt, members) => ({
    trip: {
      id,
      title,
      destination: dest,
      startDate: '2026-08-01',
      endDate: '2026-08-03',
      currency: '¥',
      budget: 0,
      memberIds,
      createdAt: t0s,
      updatedAt
    },
    members,
    days: [],
    items: [],
    expenses: []
  })

  await SP('POST', '/api/trips/persist-a', {
    author: '持久化测试',
    doc: mkPersist('persist-a', '持久化行程', '西安', ['m1'], t0s, [
      { id: 'm1', name: '甲', colorIndex: 0, weight: 1, isSelf: true, updatedAt: t0s }
    ])
  })
  await SP('POST', '/api/trips/persist-b', {
    author: '持久化测试',
    doc: mkPersist('persist-b', '另一个行程', '大理', [], t0s, [])
  })
  await SP('POST', `/api/cities/${C}/guides`, { author: '持久化测试', status: 'visited', guide: '落库校验' })

  const beforeRestart = await SP('GET', '/api/trips?withDoc=1')
  const codeA = beforeRestart.data.spaces.find((s) => s.id === 'persist-a')?.code
  const revB1 = beforeRestart.data.spaces.find((s) => s.id === 'persist-b')?.rev
  ok(existsSync(join(storeDir, 'travel.sqlite3')), 'SQLite 库文件已创建')
  ok(!existsSync(join(storeDir, 'db.json')), '新路径不再产生 db.json')

  // 空间隔离：改 A 不应动到 B 的 rev
  const t1s = t0s + 5000
  await SP('POST', '/api/trips/persist-a', {
    author: '持久化测试',
    doc: mkPersist('persist-a', '持久化行程 v2', '西安', ['m1', 'm2'], t1s, [
      { id: 'm1', name: '甲', colorIndex: 0, weight: 1, isSelf: true, updatedAt: t0s },
      { id: 'm2', name: '乙', colorIndex: 1, weight: 1, updatedAt: t1s }
    ])
  })
  const afterEditA = await SP('GET', '/api/trips')
  const bRow = afterEditA.data.spaces.find((s) => s.id === 'persist-b')
  ok(bRow?.rev === revB1, '改 A 不动 B 的 rev（写入按空间隔离）', { before: revB1, after: bRow?.rev })

  // ── 重启：SIGTERM 优雅关闭，再用同一数据目录起来 ──
  await stopStore(storeChild, STORE_PORT)
  storeChild = await bootStore(storeDir, STORE_PORT)

  const afterRestart = await SP('GET', '/api/trips?withDoc=1')
  const aRow = afterRestart.data.spaces.find((s) => s.id === 'persist-a')
  ok(afterRestart.data.spaces.length === 2, '重启后两个空间都在', afterRestart.data.spaces.length)
  ok(aRow?.doc?.trip?.title === '持久化行程 v2', '重启后行程内容完好', aRow?.doc?.trip?.title)
  ok(aRow?.doc?.members?.length === 2, '重启后成员齐（含重启前新加的）', aRow?.doc?.members?.length)
  ok(aRow?.code === codeA, '重启后分享码不变', { before: codeA, after: aRow?.code })
  const cityAfter = await SP('GET', `/api/cities/${C}`)
  ok(
    (cityAfter.data.guides || []).some((g) => g.author === '持久化测试'),
    '重启后攻略仍在'
  )
  const byCodeAfter = await SP('GET', `/api/trips/by-code/${codeA}`)
  ok(byCodeAfter.status === 200 && byCodeAfter.data.space.id === 'persist-a', '重启后分享码仍可加入', byCodeAfter.status)

  await stopStore(storeChild, STORE_PORT)

  // ── 旧版 JSON 自动迁移 ──
  const MIG_PORT = 8792
  const migBase = `http://localhost:${MIG_PORT}`
  const migDir = mkdtempSync(join(tmpdir(), 'tx-smoke-migrate-'))
  const legacy = {
    version: 2,
    guides: [
      {
        id: 'legacy-guide-1',
        cityName: '西安',
        author: '老用户',
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        status: 'visited',
        visitDate: '2025-10-01',
        guide: '兵马俑早上去，人少',
        review: '肉夹馍不错',
        rating: 5
      }
    ],
    spaces: {
      'legacy-trip-1': {
        id: 'legacy-trip-1',
        code: 'OLDXYZ',
        rev: 3,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        updatedBy: '老用户',
        retiredCodes: [],
        digest: '',
        tombstones: [],
        doc: {
          trip: {
            id: 'legacy-trip-1',
            title: '遗留行程',
            destination: '西安',
            startDate: '2026-01-01',
            endDate: '2026-01-03',
            currency: '¥',
            budget: 0,
            memberIds: ['m1'],
            createdAt: 1700000000000,
            updatedAt: 1700000000000
          },
          members: [
            {
              id: 'm1',
              tripId: 'legacy-trip-1',
              name: '老用户',
              colorIndex: 0,
              weight: 1,
              isSelf: true,
              updatedAt: 1700000000000
            }
          ],
          days: [],
          items: [],
          expenses: []
        }
      }
    }
  }
  writeFileSync(join(migDir, 'db.json'), JSON.stringify(legacy, null, 2))
  const migChild = await bootStore(migDir, MIG_PORT)

  const migTrips = await req(migBase, 'GET', '/api/trips?withDoc=1')
  ok(
    migTrips.data.spaces.length === 1 && migTrips.data.spaces[0].title === '遗留行程',
    '旧 JSON 里的行程已导入',
    migTrips.data.spaces.map((s) => s.title)
  )
  ok(migTrips.data.spaces[0]?.doc?.members?.length === 1, '旧的成员记录一并导入')
  ok(migTrips.data.spaces[0]?.rev === 3, '旧 rev 保持不变', migTrips.data.spaces[0]?.rev)

  const migCity = await req(migBase, 'GET', `/api/cities/${encodeURIComponent('西安')}`)
  ok(
    migCity.data.guides.length === 1 && migCity.data.guides[0].guide === '兵马俑早上去，人少',
    '旧 JSON 里的攻略已导入',
    migCity.data.guides
  )

  const migByCode = await req(migBase, 'GET', '/api/trips/by-code/OLDXYZ')
  ok(migByCode.status === 200 && migByCode.data.space.id === 'legacy-trip-1', '旧分享码迁移后仍可用', migByCode.status)

  ok(!existsSync(join(migDir, 'db.json')), '迁移后旧 JSON 已让位')
  ok(existsSync(join(migDir, 'db.json.migrated')), '旧 JSON 归档为 .migrated（保留而非删除）')

  // 再启一次：库已非空，不应重复导入
  await stopStore(migChild, MIG_PORT)
  const migChild2 = await bootStore(migDir, MIG_PORT)
  const migAgain = await req(migBase, 'GET', '/api/trips')
  ok(migAgain.data.spaces.length === 1, '再次启动不会重复导入', migAgain.data.spaces.length)
  await stopStore(migChild2, MIG_PORT)

  // ═══════════════ [15] HLC 逻辑时钟 ═══════════════
  //
  // 专验「谁更新」的判断不再被设备时钟带偏。都跑在已有实例上，不需要额外进程。

  section('[15] HLC 逻辑时钟：超前封顶 / 因果序 / 幂等 / 老数据兼容')

  const clkT0 = Date.now()
  const mkTripDoc = (id, title, hlc, updatedAt) => ({
    trip: {
      id,
      title,
      destination: '时钟测试',
      startDate: '2026-08-01',
      endDate: '2026-08-02',
      currency: '¥',
      budget: 0,
      memberIds: [],
      createdAt: clkT0,
      updatedAt,
      ...(hlc ? { hlc } : {})
    },
    members: [],
    days: [],
    items: [],
    expenses: []
  })

  const CLK = '/api/trips/clock-test'

  // 1) 正常时钟：原样通过，不标记超前
  const clkNormal = await M('POST', CLK, {
    author: '正常钟',
    doc: mkTripDoc('clock-test', '正常钟改的', { t: clkT0, c: 0, n: 'aaaa1111' }, clkT0)
  })
  ok(clkNormal.status === 200 && clkNormal.data.skewed === 0, '正常时钟不被标记超前', clkNormal.data.skewed)
  ok(clkNormal.data.doc.trip.hlc?.t === clkT0, 'HLC 原样保存')

  // 2) 超前 3 小时：标记出来，但时间戳**原样入库**
  //
  // 这里刻意断言「存的是原始值」：早期实现会把超前值夹到 now+skew 再存，
  // 结果同一条记录每次推送都被夹到一个更大的值，changed 永远为 true。
  const crazyT = clkT0 + 3 * 3600 * 1000
  const clkCrazy = await M('POST', CLK, {
    author: '快三小时',
    doc: mkTripDoc('clock-test', '快钟改的', { t: crazyT, c: 0, n: 'bbbb2222' }, crazyT)
  })
  ok(clkCrazy.data.skewed === 1, '超前 3 小时的记录被标记', clkCrazy.data.skewed)
  ok(clkCrazy.data.doc.trip.hlc.t === crazyT, '时间戳原样保留（只改比较口径，不改写存储）')
  ok(clkCrazy.data.doc.trip.title === '快钟改的', '超前记录本身照常写入')

  // 3) 封顶生效：时间戳虚高得更多、但节点号更小的记录，不该因此获胜
  //
  // 两条都明显超前 ⇒ 都压到同一上界，胜负改由 c / n 决定，
  // 而不是「谁的时间戳虚高得更多」。这正是封顶要达到的效果。
  const clkMoreCrazy = await M('POST', CLK, {
    author: '快五小时',
    doc: mkTripDoc('clock-test', '快五小时改的', { t: clkT0 + 5 * 3600 * 1000, c: 0, n: '00000000' }, clkT0)
  })
  ok(clkMoreCrazy.data.doc.trip.title === '快钟改的', '更虚高的时间戳不再自动获胜（压到同一上界后比节点号）')
  ok(clkMoreCrazy.data.applied.conflicts === 1, '被判为落后而非更新', clkMoreCrazy.data.applied)

  // 4) 因果序：慢钟设备看到对方改动之后再改，必须赢
  //
  // 真实客户端这里会做 HLC 的 receive（把本地时钟抬到不早于刚看到的值）再编辑。
  // 测试直接模拟结果：同 t、c 加一 ⇒ 严格更晚。
  const seenHlc = clkCrazy.data.doc.trip.hlc
  const clkCausal = await M('POST', CLK, {
    author: '慢钟但后改',
    doc: mkTripDoc('clock-test', '慢钟后改的', { t: seenHlc.t, c: seenHlc.c + 1, n: 'cccc3333' }, Date.now())
  })
  ok(clkCausal.data.doc.trip.title === '慢钟后改的', '看到对方改动后再改，一定排在后面（因果性）')
  ok(clkCausal.data.applied.updated === 1, '判定为更新而非冲突', clkCausal.data.applied)

  // 5) 老数据 / 老客户端：只有 updatedAt、没有 hlc，照样能排队且不越权
  const clkLegacy = await M('POST', CLK, {
    author: '老客户端',
    doc: mkTripDoc('clock-test', '老客户端的旧内容', undefined, clkT0 - 60_000)
  })
  ok(clkLegacy.data.doc.trip.title === '慢钟后改的', '无 hlc 的老记录不会覆盖新记录')
  ok(clkLegacy.data.applied.conflicts === 1, '老记录被判为落后', clkLegacy.data.applied)
  ok(clkLegacy.data.skewed === 0, '无 hlc 的老记录不触发超前标记')

  // 5b) 陈旧 hlc 的兜底：客户端把服务端下发的 hlc 原样留着，编辑时只更新了 updatedAt
  //
  // 这是真实踩过的坑。客户端 applyServerDoc 把服务端下发的 doc.trip 整条存进本地
  // （**含 hlc 字段**），此后编辑只更新 updatedAt、不动 hlc。服务端若优先采信那个陈旧 hlc，
  // 比较结果既不是「更新」也不是「冲突」，编辑被**静默丢弃** ——
  // 现象是 applied.conflicts === 0 且内容纹丝不动，排查时极具迷惑性
  // （用不带 hlc 的请求能复现成功、走真实客户端流程却不行）。
  //
  // 修法：归一化一律走 recordHlc(raw.hlc, updatedAt)，取两者较晚者。
  // 用独立空间，避免与上面那条超前 3 小时的记录互相干扰。
  const STALE = '/api/trips/clock-stale'
  const staleT0 = Date.now()
  const staleDoc = (title, hlc, updatedAt) => mkTripDoc('clock-stale', title, hlc, updatedAt)
  const STALE_HLC = { t: staleT0, c: 0, n: 'aaaa1111' }

  const stale0 = await M('POST', STALE, {
    author: '客户端',
    doc: staleDoc('基线', STALE_HLC, staleT0)
  })
  ok(stale0.data.applied.added === 1, '基线写入成功')

  const stale1 = await M('POST', STALE, {
    author: '客户端',
    // hlc 仍是服务端下发的那一个（陈旧），updatedAt 才是真实编辑时间
    doc: staleDoc('只更新了 updatedAt', STALE_HLC, staleT0 + 5_000)
  })
  ok(stale1.data.doc.trip.title === '只更新了 updatedAt', '陈旧 hlc 不再吞掉编辑')
  ok(
    stale1.data.applied.updated === 1,
    '被判为更新（而非「既不更新也不冲突」）',
    stale1.data.applied
  )
  ok(stale1.data.skewed === 0, 'updatedAt 只超前 5 秒，不触发超前标记', stale1.data.skewed)

  // 5c) 兜底不能变成「随便报个 updatedAt 就能赢」：陈旧 hlc + 更旧的 updatedAt 仍然输
  const stale2 = await M('POST', STALE, {
    author: '客户端',
    doc: staleDoc('陈旧内容', STALE_HLC, staleT0 - 1_000)
  })
  ok(stale2.data.doc.trip.title === '只更新了 updatedAt', '取较晚者不等于盲目采信 updatedAt')
  ok(stale2.data.applied.conflicts === 1, '更旧的内容被判为落后', stale2.data.applied)

  // 5d) 谎报未来 updatedAt：会被标记超前，但服务端仍**原样入库**、不改写
  //
  // 它确实会赢（在我们看来它就是「最新」），但封顶把它的统治力限制在 1 分钟量级 ——
  // 正常时钟很快就能追上并超过它。这是 capHlc 的设计意图，不是漏网。
  const futT = Date.now() + 3 * 3600 * 1000
  const stale3 = await M('POST', STALE, {
    author: '谎报未来',
    doc: staleDoc('谎报未来', undefined, futT)
  })
  ok(stale3.data.skewed >= 1, '谎报未来的 updatedAt 被标记为超前', stale3.data.skewed)
  ok(stale3.data.doc.trip.hlc.t === futT, '超前值原样入库（只改比较口径，不改写存储）')
  ok(stale3.data.doc.trip.title === '谎报未来', '未来时间戳确实是最新的（但统治力被限制在 1 分钟内）')

  // 5e) 编码格式锁定：定长字符串的字典序必须等于三元组序
  //
  // 这条守的是「两端同一把尺子」。服务端用这套编码存/比，客户端
  // src/services/hlc.ts 用同一份格式（客户端拿不到 node:crypto，节点号生成方式不同，
  // 但**编码必须逐字节一致**）。任何一侧改了格式，这条都会炸。
  // 客户端那侧有一模一样的字面量断言（scripts/client-sync-test.mjs），
  // 两条各自对同一个字面量，等于双侧对齐。
  ok(
    encodeHlc({ t: 1, c: 0, n: '00000000' }) === '000000000000001-000000-00000000',
    '编码样例（最小值）',
    encodeHlc({ t: 1, c: 0, n: '00000000' })
  )
  ok(
    encodeHlc({ t: 1789622509947, c: 3, n: 'ab12cd34' }) ===
      '001789622509947-000003-ab12cd34',
    '编码样例（常规值）',
    encodeHlc({ t: 1789622509947, c: 3, n: 'ab12cd34' })
  )
  const encSeq = [
    { t: 5, c: 0, n: '00000000' },
    { t: 5, c: 1, n: '00000000' },
    { t: 5, c: 1, n: '00000001' },
    { t: 6, c: 0, n: '00000000' }
  ].map(encodeHlc)
  ok(encSeq.join('|') === [...encSeq].sort().join('|'), '定长编码后字典序 == 三元组序', encSeq)

  // 6) 幂等回归守卫：同一条超前记录重复推送，不能被反复判定为「有变化」
  //
  // 这是上面「原样入库」的直接后果，也是最容易踩回去的坑：
  // 一旦有人把封顶结果写进存储，rev 就会无限增长、所有客户端被迫反复全量拉取。
  const IDEM = '/api/trips/clock-idem'
  const idemDoc = () => mkTripDoc('clock-idem', '超前内容', { t: crazyT, c: 0, n: 'eeee5555' }, crazyT)
  const idem0 = await M('POST', IDEM, { author: '快钟', doc: idemDoc() })
  ok(idem0.data.changed === true && idem0.data.applied.added === 1, '超前记录首次写入成功', idem0.data.applied)
  await M('POST', IDEM, { author: '快钟', doc: idemDoc() })
  const idem2 = await M('POST', IDEM, { author: '快钟', doc: idemDoc() })
  ok(idem2.data.changed === false, '重复推同一超前记录 -> changed:false（幂等）', idem2.data.changed)
  ok(
    idem2.data.serverRev === idem0.data.serverRev,
    'rev 不再无谓增长',
    { first: idem0.data.serverRev, third: idem2.data.serverRev }
  )

  // 7) 服务端删除盖章：墓碑 HLC 必须晚于所有已接受的**正常**记录
  //
  // 注意这里全程用正常时间戳。一个时钟超前几小时的设备，它的记录在封顶后
  // 仍可能盖过服务端刚盖的墓碑 —— 那是 LWW + 不可信时钟的固有代价，
  // 已记入 README 的已知边界，不作为断言。
  const NORM = '/api/trips/clock-normal'
  const normDoc = (title) => mkTripDoc('clock-normal', title, { t: clkT0, c: 0, n: 'ffff6666' }, clkT0)
  const norm0 = await M('POST', NORM, { author: '正常钟', doc: normDoc('正常内容') })
  ok(norm0.data.applied.added === 1, '正常记录写入成功')

  await M('DELETE', NORM)
  const normDel = await M('GET', NORM)
  ok(normDel.data.space.deleted === true, '服务端删除后标记为已删')

  const normRevive = await M('POST', NORM, { author: '想复活', doc: normDoc('复活尝试') })
  ok(normRevive.data.space.deleted === true, '删除后旧快照推不回来（墓碑 HLC 更大）')
  ok(normRevive.data.doc.trip.title === '正常内容', '内容仍是删除前的最后版本')

  // ═══════════════ [16] 字段级合并 ═══════════════
  //
  // 记录级 LWW 的固有代价：两人各改同一条记录的不同字段，仍然丢一边。
  // 这里给每个字段各带一个时间戳（`fhlc`），逐字段比，两边都保住。
  //
  // 关键设计：字段戳映射必须**完整**。缺字段会退回记录级 hlc，而记录级 hlc 是各字段的
  // 最大值、会被别的字段顶高 —— 于是「只改了预算」的客户端会把标题的生效时间一起顶高，
  // 反过来盖掉别人刚改的标题。所以服务端插入时先补全映射，客户端收到后原样回传、只顶自己改的字段。

  section('[16] 字段级合并：不同字段各改一边，两边都保住')

  const FLD = '/api/trips/field-merge'
  const FT0 = Date.now()
  const FH = (t, n) => ({ t, c: 0, n })
  const fldDoc = (trip, updatedAt) => ({
    trip: { ...trip, updatedAt },
    members: [],
    days: [],
    items: [],
    expenses: []
  })

  // 1) 基线：不带 fhlc，服务端负责补全映射
  const fld0 = await M('POST', FLD, {
    author: 'A',
    doc: fldDoc(
      {
        id: 'field-merge',
        title: '原标题',
        destination: '成都',
        startDate: '2026-11-01',
        endDate: '2026-11-02',
        currency: '¥',
        budget: 100,
        memberIds: [],
        createdAt: FT0
      },
      FT0
    )
  })
  const fldKeys = Object.keys(fld0.data.doc.trip.fhlc || {})
  ok(fld0.data.applied.added === 1, '基线建立')
  ok(
    fldKeys.length >= 6 && !fldKeys.includes('fhlc') && !fldKeys.includes('updatedAt'),
    '服务端自动补全字段戳映射（且不含元数据键）',
    fldKeys
  )

  const baseF = fld0.data.doc.trip.fhlc

  // 2) A 只改标题：映射里只把 title 顶新，其余沿用服务端下发的那份
  const fldA = await M('POST', FLD, {
    author: 'A',
    doc: fldDoc(
      {
        id: 'field-merge',
        title: 'A 改的标题',
        destination: '成都',
        startDate: '2026-11-01',
        endDate: '2026-11-02',
        currency: '¥',
        budget: 100,
        memberIds: [],
        createdAt: FT0,
        fhlc: { ...baseF, title: FH(FT0 + 1000, 'aaaaaaaa') }
      },
      FT0 + 1000
    )
  })
  ok(fldA.data.doc.trip.title === 'A 改的标题', 'A 的标题生效')

  // 3) B 手里是同一条基线，改的是预算 —— 它的标题还是旧的。
  //    这一步是整节的要害：记录级 LWW 下 B 的记录级戳更大，会把 A 的标题整条盖回去。
  const fldB = await M('POST', FLD, {
    author: 'B',
    doc: fldDoc(
      {
        id: 'field-merge',
        title: '原标题',
        destination: '成都',
        startDate: '2026-11-01',
        endDate: '2026-11-02',
        currency: '¥',
        budget: 9999,
        memberIds: [],
        createdAt: FT0,
        fhlc: { ...baseF, budget: FH(FT0 + 2000, 'bbbbbbbb') }
      },
      FT0 + 2000
    )
  })
  ok(fldB.data.doc.trip.budget === 9999, 'B 的预算生效')
  ok(fldB.data.doc.trip.title === 'A 改的标题', 'B 手里的旧标题**没有**盖掉 A 的标题')
  ok(
    fldB.data.applied.updated === 1 && fldB.data.applied.conflicts === 0,
    '一半新一半旧算 updated（不是 conflict）',
    fldB.data.applied
  )

  // 4) A 再推一次自己的快照（标题新、预算旧）→ 预算不能回退
  const fldA2 = await M('POST', FLD, {
    author: 'A',
    doc: fldDoc(
      {
        id: 'field-merge',
        title: 'A 改的标题',
        destination: '成都',
        startDate: '2026-11-01',
        endDate: '2026-11-02',
        currency: '¥',
        budget: 100,
        memberIds: [],
        createdAt: FT0,
        fhlc: { ...baseF, title: FH(FT0 + 1000, 'aaaaaaaa') }
      },
      FT0 + 1000
    )
  })
  ok(fldA2.data.doc.trip.budget === 9999, '陈旧预算不会回退')
  ok(fldA2.data.doc.trip.title === 'A 改的标题', '标题保持')
  ok(fldA2.data.applied.conflicts === 1, '一个字段都没赢 → conflicts 1（语义没变）', fldA2.data.applied)
  ok(fldA2.data.changed === false, '重复推同一份 → changed:false（字段级合并没破坏幂等）')

  // 5) 老客户端（不带 fhlc）→ 整条退到记录级 LWW，行为与加这个特性之前一致
  const fldLegacy = await M('POST', FLD, {
    author: '老客户端',
    doc: fldDoc(
      {
        id: 'field-merge',
        title: '老客户端整条覆盖',
        destination: '成都',
        startDate: '2026-11-01',
        endDate: '2026-11-02',
        currency: '¥',
        budget: 100,
        memberIds: [],
        createdAt: FT0
      },
      FT0 + 3000
    )
  })
  ok(
    fldLegacy.data.doc.trip.title === '老客户端整条覆盖' && fldLegacy.data.doc.trip.budget === 100,
    '无字段戳的老客户端仍是整条 LWW'
  )

  // 6) fhlc 是客户端提交的，必须当不可信输入：非法字段名 / 非法时间戳一律丢弃
  const fldDirty = await M('POST', FLD, {
    author: 'A',
    doc: fldDoc(
      {
        id: 'field-merge',
        title: '脏值测试',
        destination: '成都',
        startDate: '2026-11-01',
        endDate: '2026-11-02',
        currency: '¥',
        budget: 100,
        memberIds: [],
        createdAt: FT0,
        fhlc: {
          title: { t: 'abc' },
          '坏键!': FH(FT0 + 9e6, 'dddddddd'),
          updatedAt: FH(FT0 + 9e6, 'eeeeeeee'),
          budget: FH(FT0 + 4000, 'cccccccc')
        }
      },
      FT0 + 4000
    )
  })
  const dirtyF = fldDirty.data.doc.trip.fhlc || {}
  ok(!Object.keys(dirtyF).includes('坏键!'), '非法字段名被丢弃', Object.keys(dirtyF))
  ok(!Object.keys(dirtyF).includes('updatedAt'), '元数据键不参与字段级合并', Object.keys(dirtyF))
  ok(dirtyF.budget?.t === FT0 + 4000, '合法字段戳被采纳')
  ok(dirtyF.title?.t !== 'abc' && Number.isFinite(dirtyF.title?.t), '非法时间戳被丢弃后回退成合法值')

  // ═══════════════ [16.5] digestOf 指纹 ═══════════════
  //
  // digestOf 曾直接 JSON.stringify 整个 doc：记录里字段的插入顺序、数组里记录的
  // 排列顺序一变（存储层回读、客户端提交次序都会造成），同内容也算变化 →
  // rev 无谓增长、所有客户端被迫重拉，幂等性就废了。后改成 stableValue（对象键
  // 递归排序）+ 数组按 id 排序。这里用**同一份内容、不同键序/数组序**的两份 space
  // 钉住这条性质 —— 谁把 stableValue 退回裸 stringify，这里当场变红。
  section('[16.5] digestOf：同内容不同键序/数组序 → 同指纹')

  {
    // 只为拿 _internal.digestOf：handle() 不会在单测里被调用，依赖给最小假件即可
    const { digestOf } = createTripsRouter({
      http: {},
      db: {},
      log: { info() {}, warn() {}, error() {} }
    })._internal

    /** 每一层都把键的插入顺序整个翻过来（数组原样保留 —— 数组序由按 id 排序管） */
    const flipDeep = (o) =>
      Object.fromEntries(
        Object.entries(o)
          .map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? flipDeep(v) : v])
          .reverse()
      )

    const rec = (id, title) => ({
      id,
      dayId: 'd1',
      tripId: 't1',
      order: 0,
      time: '09:00',
      type: 'spot',
      title,
      address: '成都',
      lat: 30.5,
      lng: 104.0,
      cost: 30,
      duration: 60,
      note: '',
      done: false,
      updatedAt: 1000,
      hlc: { t: 1000, c: 0, n: 'aaaaaaaa' },
      fhlc: { title: { t: 1000, c: 0, n: 'aaaaaaaa' }, cost: { t: 900, c: 0, n: 'aaaaaaaa' } }
    })

    const mkSpace = (flip) => {
      const rec1 = rec('r1', '宽窄巷子')
      const rec2 = rec('r2', '人民公园')
      const space = {
        doc: {
          trip: {
            id: 't1',
            title: '成都两日',
            destination: '成都',
            startDate: '2026-11-01',
            endDate: '2026-11-02',
            currency: '¥',
            budget: 500,
            memberIds: ['m1'],
            createdAt: 1,
            updatedAt: 1000,
            hlc: { t: 1000, c: 0, n: 'aaaaaaaa' }
          },
          members: [{ id: 'm1', tripId: 't1', name: '甲', colorIndex: 0, weight: 1, updatedAt: 1000 }],
          days: [{ id: 'd1', tripId: 't1', date: '2026-11-01', index: 0, title: '第一天', note: '' }],
          items: [rec1, rec2],
          expenses: []
        },
        tombstones: [{ kind: 'item', id: 'x1', deletedAt: 5, hlc: { t: 5, c: 0, n: 'bbbbbbbb' } }]
      }
      if (flip) {
        space.doc.items.reverse() // 数组序翻转
        space.doc = flipDeep(space.doc) // 所有对象键序翻转
        space.tombstones = [flipDeep(space.tombstones[0])]
      }
      return space
    }

    const da = digestOf(mkSpace(false))
    const db2 = digestOf(mkSpace(true))
    ok(da === db2, '键序全翻转 + 数组倒序 → 指纹不变', { a: da, b: db2 })

    // 负对照：内容真的变了 → 指纹必须变（防止断言恒真）
    const diffSpace = mkSpace(true)
    diffSpace.doc.items[0].title = '内容变了'
    ok(da !== digestOf(diffSpace), '内容变了 → 指纹必须变（负对照）', digestOf(diffSpace))
  }

  // ═══════════════ 账号体系 ═══════════════

  section('[17] 身份模块（纯逻辑，不经过网络）')
  {
    const m = createIdentity({ sessionSecret: 'k1', ttlMs: 1000, devLogin: true })
    const s = m.issue('aaaa1111bbbb2222')
    ok(m.verify(s.token).ok, '自己签的令牌能验过')
    ok(m.verify(s.token).openid === 'aaaa1111bbbb2222', '验出的 openid 与签发一致')
    const late = m.verify(s.token, s.expiresAt + 1)
    ok(!late.ok && late.reason === 'expired', '过期令牌被拒，且 reason 是 expired（与签名错误分开）', late)
    ok(m.verify(s.token, s.expiresAt - 1).ok, '过期前一刻仍然有效', { exp: s.expiresAt })

    // 换密钥 ⇒ 旧令牌全废（这是唯一能做的事后吊销手段，必须成立）
    const m2 = createIdentity({ sessionSecret: 'k2', ttlMs: 1000, devLogin: true })
    ok(!m2.verify(s.token).ok, '签名密钥变了，旧令牌失效')

    ok(!m.verify('').ok, '空令牌被拒')
    ok(!m.verify('xxxx').ok, '没有 wxs_ 前缀的串被拒')
    ok(!m.verify('wxs_a.b').ok, '段数不对被拒')
    ok(!m.verify('wxs_' + 'aaaa1111bbbb2222' + '.9999999999999.zzzz').ok, '签名不对被拒')

    // openid 归一：非法一律拒绝，**不截断**（截断会让两个不同 openid 撞成同一个）
    ok(m.issue('x'.repeat(200)) === null, '超长 openid 被拒（不截断，避免碰撞）')
    ok(m.issue('bad openid') === null, '含空格 / 非法字符的 openid 被拒')
    ok(m.issue('') === null, '空 openid 被拒')
    ok(!m.verify('wxs_' + 'x'.repeat(200) + '.9999999999999.zzz').ok, '超长 openid 的令牌被拒')

    // dev 登录：同一 code 同一身份（测试可复现的前提）
    const d1 = await m.loginWithCode('code-x')
    const d2 = await m.loginWithCode('code-x')
    ok(d1.ok && d1.dev && d1.openid === d2.openid, 'dev 登录对同一 code 确定性', d1.openid)
    const noCfg = createIdentity({ sessionSecret: 'k1' })
    const r = await noCfg.loginWithCode('code-x')
    ok(!r.ok && r.reason === 'not-configured', '未配置且未开 dev 登录 → not-configured（不是失败）', r)
    ok((await noCfg.loginWithCode('')).reason === 'missing-code', '缺 code → missing-code')
  }

  // [17] 的网络部分整体包在一个块里：前面 [1]~[16] 已经用掉了一大批短变量名
  // （g1 / g2 / listA / code …），块作用域是这里最省事的隔离方式。
  {
  section('[17] 登录接口 + 会话令牌（网络链路）')
  const loginA = await ID('POST', '/api/auth/wx', { code: 'code-alpha' })
  ok(loginA.status === 200, 'dev 登录成功', loginA.status)
  const openidA = String(loginA.data.openid || '')
  const sessA = String(loginA.data.token || '')
  ok(/^dev[0-9a-f]{24}$/.test(openidA), '换到确定性假 openid ' + openidA.slice(0, 10) + '…')
  ok(sessA.startsWith('wxs_') && sessA.includes(openidA), '会话令牌带 wxs_ 前缀且绑定该 openid')
  ok(Number(loginA.data.expiresAt) > Date.now(), '令牌带未来的过期时间')

  const loginB = await ID('POST', '/api/auth/wx', { code: 'code-beta' })
  const openidB = String(loginB.data.openid || '')
  const sessB = String(loginB.data.token || '')
  ok(openidB && openidB !== openidA, '不同 code 换到不同 openid')

  ok((await ID('POST', '/api/auth/wx', {})).status === 400, '缺 code → 400')
  ok((await ID('GET', '/api/auth/me')).status === 401, '不带令牌查 me → 401')
  const meA = await ID('GET', '/api/auth/me', undefined, sessA)
  ok(meA.status === 200 && meA.data.openid === openidA, '带令牌能查到自己的身份')

  // 篡改签名
  const lastCh = sessA.slice(-1) === 'a' ? 'b' : 'a'
  ok(
    (await ID('GET', '/api/auth/me', undefined, sessA.slice(0, -1) + lastCh)).status === 401,
    '篡改签名的令牌被拒'
  )
  // 挪用：拿 B 的签名配 A 的 openid（签名必须绑定 openid，否则可任意伪装成别人）
  const expA = sessA.split('.')[1]
  const sigB = sessB.split('.').pop()
  ok(
    (await ID('GET', '/api/auth/me', undefined, `wxs_${openidA}.${expA}.${sigB}`)).status === 401,
    '借用他人签名的令牌被拒（签名与 openid 绑定）'
  )
  ok((await ID('POST', '/api/auth/logout', undefined, sessA)).status === 200, '登出是客户端动作，服务端只回 200')

  // 两套凭据正交且**都需要**：会话令牌回答「你是谁」，共享密钥回答「这个客户端能不能进门」。
  // 把两者混在一个头里（比如都塞 Authorization: Bearer）迟早出事 —— 这里把边界钉死。
  const credHeaders = (h) => req(cred.base, 'GET', '/api/auth/me', undefined, h)
  ok(
    (await credHeaders({ Authorization: `Bearer ${sessA}` })).status === 401,
    '会话令牌塞进 Authorization 不被当成共享密钥'
  )
  ok(
    (await credHeaders({ 'X-Session-Token': sessA })).status === 401,
    '只有身份、没有共享密钥 → 仍被门禁挡住'
  )
  const bothCreds = await credHeaders({ 'X-Api-Key': TOKEN, 'X-Session-Token': sessA })
  ok(bothCreds.status === 200 && bothCreds.data.openid === openidA, '两套凭据都给才通过，且身份解析正确', bothCreds.data)
  // 未配置微信且未开 dev 登录的实例：503 而不是 401（运维问题要看得见）
  ok((await M('POST', '/api/auth/wx', { code: 'x' })).status === 503, '未配置微信登录 → 503（不是 401）')

  section('[17] 空间归属与授权')
  // 有身份创建 → 空间归创建者
  const T3 = 'smoke_ident_owned'
  const t3 = Date.now()
  const doc3 = {
    trip: {
      id: T3,
      title: '账号用例',
      destination: '青岛',
      startDate: '2026-11-01',
      endDate: '2026-11-02',
      currency: '¥',
      budget: 100,
      memberIds: [],
      createdAt: t3,
      updatedAt: t3
    },
    members: [],
    days: [],
    items: [],
    expenses: []
  }
  const pushOwned = await ID('POST', `/api/trips/${T3}`, { author: '阿哲', deviceId: 'dev_a', doc: doc3 }, sessA)
  ok(pushOwned.status === 200, '有身份创建空间成功', pushOwned.status)
  const codeOwned = pushOwned.data.space.code
  ok(/^[A-Z0-9]{6}$/.test(codeOwned || ''), '拿到分享码 ' + codeOwned)
  ok(
    !JSON.stringify(pushOwned.data.space).includes(openidA),
    '空间 brief 里不带 openid（不广播身份标识）'
  )

  /** 写请求：用 doc:null + 空墓碑，让请求能走到权限判定（权限检查与文档内容无关） */
  const poke = (id, session) =>
    ID('POST', `/api/trips/${id}`, { author: '谁', deviceId: 'dev_x', doc: null, tombstones: [] }, session)

  ok((await poke(T3, sessB)).status === 403, '非成员写入有主空间 → 403')
  ok((await poke(T3, null)).status === 403, '无身份写入有主空间 → 403')
  ok((await poke(T3, sessA)).status === 200, '创建者本人能写')

  const listA = await ID('GET', '/api/trips', undefined, sessA)
  const listB = await ID('GET', '/api/trips', undefined, sessB)
  ok(listA.data.spaces.some((s) => s.id === T3), 'A 的列表里有自己的行程')
  ok(!listB.data.spaces.some((s) => s.id === T3), 'B 的列表里没有别人未分享的行程（按用户隔离）')
  ok(
    !(await ID('GET', '/api/trips', undefined, null)).data.spaces.some((s) => s.id === T3),
    '匿名列表不返回他人有主空间（否则未登录的同步会把别人行程并进本地）'
  )

  // 凭码加入 → 成为成员
  const joinB = await ID('POST', '/api/trips/join', { code: codeOwned }, sessB)
  ok(joinB.status === 200 && joinB.data.joined === true, 'B 凭码加入，被登记为成员', joinB.data.joined)
  ok((await poke(T3, sessB)).status === 200, '加入后 B 能写了')
  ok(
    (await ID('GET', '/api/trips', undefined, sessB)).data.spaces.some((s) => s.id === T3),
    '加入后该行程出现在 B 的列表里'
  )
  ok((await ID('POST', '/api/trips/join', { code: 'ZZZZZZ' }, sessB)).status === 404, '不存在的分享码 → 404')
  ok((await ID('POST', '/api/trips/join', { code: '!!' })).status === 400, '畸形分享码 → 400')

  // 换码也是成员级操作
  ok((await ID('POST', `/api/trips/${T3}/code`, undefined, null)).status === 403, '无身份不能换分享码')
  ok((await ID('POST', `/api/trips/${T3}/code`, undefined, sessB)).status === 200, '成员能换分享码')

  section('[17] 无主空间兼容口径 + 认领')
  const T4 = 'smoke_ident_orphan'
  const t4 = Date.now()
  const doc4 = { ...doc3, trip: { ...doc3.trip, id: T4, title: '老行程', createdAt: t4, updatedAt: t4 } }
  const pushOrphan = await ID('POST', `/api/trips/${T4}`, { author: '匿名', deviceId: 'dev_o', doc: doc4 })
  ok(pushOrphan.status === 200, '无身份创建 → 无主空间（完全保持旧行为）')
  const codeOrphan = pushOrphan.data.space.code
  ok((await poke(T4, sessA)).status === 200, '无主空间对已登录用户开放（存量数据不该突然写不动）')
  ok((await poke(T4, sessB)).status === 200, '无主空间对另一个身份也开放')
  ok((await poke(T4, null)).status === 200, '无主空间对匿名同样开放')
  ok(
    (await ID('GET', '/api/trips', undefined, sessA)).data.spaces.some((s) => s.id === T4),
    '无主空间对所有登录用户可见（不让存量行程凭空消失）'
  )

  ok((await ID('POST', `/api/trips/${T4}/claim`, { code: codeOrphan })).status === 401, '未登录不能认领')
  ok(
    (await ID('POST', `/api/trips/${T4}/claim`, { code: codeOwned }, sessA)).status === 403,
    '码与空间不匹配 → 403（不能拿自己空间的码去认领别人的）'
  )
  const claim = await ID('POST', `/api/trips/${T4}/claim`, { code: codeOrphan }, sessA)
  ok(claim.status === 200, 'A 凭码认领无主空间成功', claim.status)
  ok((await poke(T4, sessA)).status === 200, '认领者本人能写')
  ok((await poke(T4, null)).status === 403, '认领后匿名写入被拒（权限模型已切换）')
  ok((await poke(T4, sessB)).status === 403, '认领后非成员写入被拒')
  ok(
    (await ID('POST', `/api/trips/${T4}/claim`, { code: codeOrphan }, sessB)).status === 409,
    '已有归属的空间不能再被认领（否则就是个抢行程的后门）'
  )

  section('[17] 攻略归属：昵称不再等于身份')
  const QD = encodeURIComponent('青岛')
  const g1 = await ID('POST', `/api/cities/${QD}/guides`, { author: '阿哲', status: 'visited', guide: '栈桥值得去' }, sessA)
  ok(g1.status === 200, 'A 带身份发布攻略')
  const guideId = g1.data.guide?.id || ''
  ok(!('authorOpenid' in (g1.data.guide || {})), '响应里不带 authorOpenid', Object.keys(g1.data.guide || {}))
  ok(
    !JSON.stringify(await ID('GET', `/api/cities/${QD}`)).includes(openidA),
    '攻略列表响应里不含任何 openid'
  )

  // B 把昵称改成「阿哲」想覆盖 / 删除 A 的攻略
  const g2 = await ID('POST', `/api/cities/${QD}/guides`, { author: '阿哲', status: 'visited', guide: '我说了算' }, sessB)
  ok(g2.status === 403, '同名攻略已归属他人 → 拒绝覆盖（冒名发不出去）', g2.status)
  ok((await ID('PUT', `/api/guides/${guideId}`, { review: '乱改' }, sessB)).status === 403, '他人不能改我的攻略')
  ok((await ID('DELETE', `/api/guides/${guideId}`, undefined, sessB)).status === 403, '他人不能删我的攻略')

  // 带身份撤回按 openid 走：随便填个昵称也删不掉别人的
  const withdrawFake = await ID('DELETE', `/api/cities/${QD}/guides?author=${AUTHOR}`, undefined, sessB)
  ok(withdrawFake.data.removed === 0, '带身份撤回按 openid，捏造昵称删不掉别人的攻略', withdrawFake.data)
  ok((await ID('PUT', `/api/guides/${guideId}`, { review: '确实不错' }, sessA)).status === 200, '本人能改自己的攻略')
  const stillThere = await ID('GET', `/api/cities/${QD}`)
  ok(stillThere.data.guides.length === 1 && stillThere.data.guides[0].review === '确实不错', '攻略仍在且是本人改后的内容')
  const withdrawMine = await ID('DELETE', `/api/cities/${QD}/guides`, undefined, sessA)
  ok(withdrawMine.data.removed === 1, 'A 撤回自己的攻略（按 openid）', withdrawMine.data)

  // 无归属的老攻略（未登录发布）仍走旧口径，未接账号体系的部署不受影响
  const legacyG = await ID('POST', `/api/cities/${QD}/guides`, { author: '老用户', status: 'wish', wishNote: '想去' })
  ok(legacyG.status === 200, '未登录发布的攻略仍可写（旧行为不变）')
  ok(
    (await ID('PUT', `/api/guides/${legacyG.data.guide.id}`, { wishNote: '改一下' })).status === 200,
    '无归属的老攻略保持旧口径（谁都能改）'
  )

  section('[17] 发现广场（所有登录用户可见）')
  // 匿名不能逛广场：广场是「登录用户」的可见性，不是公开互联网页面
  ok((await ID('GET', '/api/trips/discover')).status === 401, '匿名逛广场 → 401')

  // 此刻 ident 实例里有：T3（A 拥有、B 是成员）、T4（A 认领拥有）。
  // B 的广场里两条都该出现；只有 T3 标 mine；T4 不是 B 的 → **必须没有 code**。
  const discB = await ID('GET', '/api/trips/discover', undefined, sessB)
  ok(discB.status === 200, '登录用户能拉广场列表', discB.status)
  const bT3 = discB.data.trips.find((s) => s.id === T3)
  const bT4 = discB.data.trips.find((s) => s.id === T4)
  ok(bT3 && bT4, '广场列出全部未删除行程（含不属于自己的）', discB.data.trips.map((s) => s.id))
  ok(bT3?.mine === true, '我参与的行程标 mine（成员）')
  ok(bT4?.mine === false, '别人的行程不标 mine')
  ok(bT4 && !('code' in bT4), '非 mine 条目不带分享码（code = 加入即写权，不能随广场广播）')
  ok(bT3 && typeof bT3.code === 'string' && bT3.code, 'mine 条目保留分享码（本来就在我的行程里）')

  const discA = await ID('GET', '/api/trips/discover', undefined, sessA)
  ok(
    discA.data.trips.find((s) => s.id === T3)?.mine === true &&
      discA.data.trips.find((s) => s.id === T4)?.mine === true,
    'owner 看自己的两条都标 mine'
  )

  // 已删除的行程不出现在广场
  const T5 = 'smoke_disc_deleted'
  const t5 = Date.now()
  const doc5 = { ...doc3, trip: { ...doc3.trip, id: T5, title: '将被删除', createdAt: t5, updatedAt: t5 } }
  const pushT5 = await ID('POST', `/api/trips/${T5}`, { author: '小北', deviceId: 'dev_b', doc: doc5 }, sessB)
  ok(pushT5.status === 200, 'B 创建第三个空间')
  await ID('DELETE', `/api/trips/${T5}`, undefined, sessB)
  ok(
    !(await ID('GET', '/api/trips/discover', undefined, sessB)).data.trips.some((s) => s.id === T5),
    '已删除的行程不进广场'
  )

  section('[17] 我的足迹回拉（按 openid 归属）')
  ok((await ID('GET', '/api/my/guides')).status === 401, '匿名拉我的足迹 → 401')

  const QD2 = encodeURIComponent('青岛')
  const CD = encodeURIComponent('成都')
  const BJ = encodeURIComponent('北京')
  const up1 = await ID('POST', `/api/cities/${QD2}/guides`, { author: '阿哲', status: 'visited', guide: '栈桥' }, sessA)
  const up2 = await ID('POST', `/api/cities/${CD}/guides`, { author: '阿哲', status: 'wish', wishNote: '看熊猫' }, sessA)
  const up3 = await ID('POST', `/api/cities/${BJ}/guides`, { author: '小北', status: 'visited', guide: '烤鸭' }, sessB)
  ok(up1.status === 200 && up2.status === 200 && up3.status === 200, 'A 发两条、B 发一条足迹')

  const mineA = await ID('GET', '/api/my/guides', undefined, sessA)
  ok(mineA.status === 200, 'A 拉回自己的足迹')
  const mineAList = mineA.data.guides || []
  ok(
    mineAList.length === 2 &&
      mineAList.some((g) => g.cityName === '青岛') &&
      mineAList.some((g) => g.cityName === '成都'),
    'A 只看到自己的两条（归属按 openid，不看昵称）',
    mineAList.map((g) => g.cityName)
  )
  ok(!mineAList.some((g) => g.cityName === '北京'), '别人的足迹不在我的回拉里')
  ok(mineAList.every((g) => !('authorOpenid' in g)), '回拉响应里不带 authorOpenid')

  const mineB = await ID('GET', '/api/my/guides', undefined, sessB)
  ok(
    (mineB.data.guides || []).length === 1 && mineB.data.guides[0].cityName === '北京',
    'B 只拉回自己的那条'
  )
  }

  // ═══════════════════ [18] 实时同步（WebSocket）═══════════════════
  //
  // 分三层测：
  //   A. 协议层纯函数 —— 帧编解码的边界（逐字节喂入 / 未掩码 / 分片 / 超限 / 控制帧约束）
  //   B. 订阅中心纯函数 —— 合并窗口、排除发起者、订阅上限
  //   C. 端到端 —— 握手与鉴权、订阅授权、跨连接推送、心跳
  // 前两层不碰网络，所以任何失败都能精确指到「哪一行逻辑错了」。
  {
    section('[18] WS 协议层：帧编解码')
    // RFC 6455 §1.3 的官方示例：错一个字节整个握手就废了，所以拿它当基准
    ok(acceptKey('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'Sec-WebSocket-Accept 与 RFC 示例一致')

    // 三档长度编码：<126 直接用 7 位；126-65535 用 16 位；以上用 64 位
    for (const n of [0, 5, 125, 126, 65535, 65536]) {
      const msg = 'x'.repeat(n)
      const frame = encodeFrame(OPCODE.TEXT, msg, { mask: true })
      let got = null
      const p = createFrameParser({ maxPayload: 1 << 20, onMessage: (op, pl) => (got = pl.toString()) })
      // **逐字节**喂入：把「TCP 把帧切在头部中间」这种真实但难复现的情况变成确定性用例
      for (const b of frame) p.push(Buffer.from([b]))
      ok(got === msg, `长度 ${n} 的文本帧往返一致（逐字节喂入）`)
    }

    {
      let err = null
      const p = createFrameParser({ onError: (e) => (err = e) })
      p.push(encodeFrame(OPCODE.TEXT, 'hi')) // 默认不带掩码
      ok(err?.reason === 'client frame must be masked', '未掩码的客户端帧 → 协议错误（防代理缓存投毒）')
      ok(err?.code === CLOSE.PROTOCOL_ERROR, '掩码错误用 1002 而不是超限码', err?.code)
    }

    {
      let got = null
      const p = createFrameParser({
        onMessage: (op, pl) => (got = `${op}:${pl.toString()}`)
      })
      p.push(
        Buffer.concat([
          encodeFrame(OPCODE.TEXT, 'he', { mask: true, fin: false }),
          encodeFrame(OPCODE.CONT, 'll', { mask: true, fin: false }),
          encodeFrame(OPCODE.CONT, 'o', { mask: true, fin: true })
        ])
      )
      ok(got === '1:hello', '分片消息会被攒齐后一次性交付（三段）', got)
    }

    {
      const got = []
      const p = createFrameParser({ onMessage: (op, pl) => got.push(pl.toString()) })
      p.push(Buffer.concat(['a', 'b', 'c'].map((s) => encodeFrame(OPCODE.TEXT, s, { mask: true }))))
      ok(got.join(',') === 'a,b,c', '一个 TCP 块里挤三个帧能全部解析出来', got)
    }

    {
      const cases = [
        ['分片的控制帧', encodeFrame(OPCODE.PING, 'x', { mask: true, fin: false }), 'fragmented control frame'],
        ['没有首帧的延续帧', encodeFrame(OPCODE.CONT, 'x', { mask: true }), 'continuation frame without a preceding data frame'],
        ['保留位非 0（未协商扩展）', (() => { const f = encodeFrame(OPCODE.TEXT, 'x', { mask: true }); f[0] |= 0x40; return f })(), 'reserved bits set without an extension'],
        ['保留 opcode', encodeFrame(0x3, 'x', { mask: true }), 'unknown opcode 3']
      ]
      for (const [label, frame, expect] of cases) {
        let err = null
        const p = createFrameParser({ onError: (e) => (err = e) })
        p.push(frame)
        ok(err?.reason === expect, `拒绝${label}`, err?.reason)
      }
    }

    {
      let err = null
      const p = createFrameParser({ maxPayload: 1024, onError: (e) => (err = e) })
      p.push(encodeFrame(OPCODE.TEXT, 'y'.repeat(2000), { mask: true }))
      ok(err?.reason === 'payload too large', '超过 maxPayload 的帧被拒', err?.reason)
      ok(err?.code === CLOSE.TOO_BIG, '超限用 1009（不是 1002）—— 客户端能据此区分「我发太大了」', err?.code)
    }

    {
      let info = null
      const p = createFrameParser({ onClose: (c) => (info = c) })
      const body = Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from('bye', 'utf-8')])
      p.push(encodeFrame(OPCODE.CLOSE, body, { mask: true }))
      ok(info?.code === 1000 && info?.reason === 'bye', '关闭帧能解析出状态码与原因', info)
    }

    {
      let onMsg = false
      let err = null
      const p = createFrameParser({ onMessage: () => (onMsg = true), onError: (e) => (err = e) })
      p.push(encodeFrame(OPCODE.BIN, Buffer.from([1, 2, 3]), { mask: true }))
      ok(onMsg && !err, '二进制帧本身是合法帧（业务层再决定不支持）')
    }

    section('[18] WS 协议层：发送背压（慢消费者保护）')
    {
      // 假 socket：协议层只依赖 on/emit/write/end/destroy/destroyed/writableLength。
      // writableLength 只涨不消 —— 正是「客户端停止读 TCP」的确定性复现
      // （真 socket 要靠内核缓冲全满才复现，慢且不稳；假 socket 把它变成一个数）。
      const makeSlowSocket = ({ writableLength = 0, writeReturns = true } = {}) => {
        const listeners = {}
        const s = {
          destroyed: false,
          writableLength,
          written: [],
          on(ev, fn) {
            ;(listeners[ev] = listeners[ev] || []).push(fn)
          },
          write(buf) {
            s.written.push(buf)
            s.writableLength += buf.length
            return writeReturns
          },
          emit(ev, arg) {
            for (const fn of [...(listeners[ev] || [])]) fn(arg)
          },
          end() {
            s.destroyed = true
            s.emit('close')
          },
          destroy() {
            s.destroyed = true
            s.emit('close')
          }
        }
        return s
      }

      // 正常路径：缓冲在限内，帧照发
      {
        const sock = makeSlowSocket()
        const conn = createWsConnection(sock, { id: 'bp-ok', maxBufferedBytes: 1024 })
        const r = conn.send({ t: 'update', rev: 1 })
        ok(r === true && sock.written.length === 1 && !conn.closed, '缓冲在限内：帧正常写出', { r, closed: conn.closed })
      }

      // 超限：踢下线 + 关闭帧必须真的排得出去
      {
        const sock = makeSlowSocket({ writableLength: 2048 })
        const errs = []
        const conn = createWsConnection(sock, {
          id: 'bp-slow',
          maxBufferedBytes: 1024,
          onError: (e) => errs.push(e)
        })
        const r = conn.send({ t: 'update', rev: 1 })
        ok(r === false && conn.closed, '缓冲超限：数据帧被拒且连接被踢', { r, closed: conn.closed })
        ok(errs.some((e) => e.reason === 'send-buffer-overflow'), '踢人时留下 overflow 记账（排障用）', errs)
        ok(
          sock.written.length === 1 && (sock.written[0][0] & 0x0f) === OPCODE.CLOSE,
          '关闭帧不受背压限制（连接因发不动才被踢，关闭帧再被挡就是强拆）',
          sock.written.length
        )
        // 踢完之后不再写任何数据帧
        conn.send({ t: 'update', rev: 2 })
        ok(sock.written.length === 1, '已关闭的连接不再接受任何数据帧', sock.written.length)
      }

      // 边界：正好到限仍放行（严格大于才算超）
      {
        const sock = makeSlowSocket({ writableLength: 1024 })
        const conn = createWsConnection(sock, { id: 'bp-edge', maxBufferedBytes: 1024 })
        ok(conn.send({ t: 'update', rev: 1 }) === true, '缓冲恰好等于上限：仍放行（> 才算超）', sock.writableLength)
      }

      // maxBufferedBytes=0：显式关闭保护
      {
        const sock = makeSlowSocket({ writableLength: 1 << 20 })
        const conn = createWsConnection(sock, { id: 'bp-off', maxBufferedBytes: 0 })
        ok(conn.send({ t: 'update', rev: 1 }) === true && !conn.closed, 'maxBufferedBytes=0 表示不设限', {})
      }
    }

    section('[18] 订阅中心：扇出与合并')
    {
      const sent = []
      const mk = (id) => ({
        id,
        subscriptions: new Set(),
        send: (m) => sent.push({ to: id, ...m })
      })
      const hub = createHub({ coalesceMs: 30 })
      const a = mk('a')
      const b = mk('b')
      hub.add(a)
      hub.add(b)

      ok(hub.subscribe(a, 'S1').ok && hub.subscribe(b, 'S1').ok, '两个连接订阅同一空间')
      ok(hub.subscriberCount('S1') === 2, '订阅者计数正确', hub.subscriberCount('S1'))

      hub.notify('S1', { rev: 1, updatedBy: 'x' })
      await sleep(80)
      ok(sent.length === 2 && sent.every((m) => m.t === 'update' && m.rev === 1), '变化被扇出给两个订阅者', sent)

      // 排除发起连接
      sent.length = 0
      hub.notify('S1', { rev: 2 }, { exceptConnId: 'a' })
      await sleep(80)
      ok(sent.length === 1 && sent[0].to === 'b', '发起这次变化的连接被排除（它已经从响应里拿到了合并结果）', sent)

      // 合并窗口
      sent.length = 0
      hub.notify('S1', { rev: 3 }, { exceptConnId: 'a' })
      hub.notify('S1', { rev: 4 }, { exceptConnId: 'a' })
      hub.notify('S1', { rev: 5 }, { exceptConnId: 'a' })
      await sleep(80)
      ok(sent.length === 1, '窗口内的 3 次变化合并成 1 条通知（否则订阅者会白拉三遍）', sent)
      ok(sent[0]?.rev === 5, '合并后取最大 rev（单调递增，取最大即最新）', sent[0]?.rev)

      // 合并时「排除集取交集」：两次变化来自不同连接 → 谁都不能排除
      sent.length = 0
      hub.notify('S1', { rev: 6 }, { exceptConnId: 'a' })
      hub.notify('S1', { rev: 7 }, { exceptConnId: 'b' })
      await sleep(80)
      ok(
        sent.length === 2 && sent.map((m) => m.to).sort().join(',') === 'a,b',
        '窗口内两次变化来自不同连接时，谁都收得到（a 需要知道 b 的那次，反之亦然）',
        sent
      )

      ok(hub.unsubscribe(b, 'S1') === true, '能退订')
      ok(hub.subscribe(b, 'S1').ok, '能重新订阅')
      // 权限变更：把非 owner 的订阅踢掉
      const kicked = hub.dropSubscribers('S1', (conn) => conn.id === 'a')
      ok(kicked === 1, '权限变更时能按条件踢掉订阅者', kicked)
      ok(sent.some((m) => m.t === 'unsubscribed' && m.reason === 'access-revoked'), '被踢的连接会收到明确的 unsubscribed 帧', sent.at(-1))

      sent.length = 0
      hub.notify('S1', { rev: 8 })
      await sleep(80)
      ok(sent.length === 1 && sent[0].to === 'a', '被踢掉的连接不再收到通知（授权变更后会话没有残留）', sent)

      // 订阅上限
      const small = createHub({ maxSubsPerConn: 2 })
      const c = mk('c')
      small.add(c)
      small.subscribe(c, 'X1')
      small.subscribe(c, 'X2')
      ok(small.subscribe(c, 'X3').reason === 'too-many-subscriptions', '超过单连接订阅上限会被拒', small.subscribe(c, 'X3'))
      small.closeAll()

      // 连接断开后空间表要清干净（否则「没人订阅的空间」会无限累积）
      hub.remove(a)
      hub.remove(b)
      ok(hub.stats().spaces === 0 && hub.stats().connections === 0, '连接注销后订阅索引被清空', hub.stats())
      hub.closeAll()
    }

    section('[18] 握手与鉴权')
    {
      const notWs = await rawUpgrade(hard.base, '/api/ws', { Upgrade: 'h2c' })
      ok(notWs.status === 400, 'Upgrade 头不是 websocket → 400', notWs.status)

      const badPath = await rawUpgrade(main.base, '/api/not-ws')
      ok(badPath.status === 404, '路径不对 → 404（不在这条路上暴露任何东西）', badPath.status)

      const badVer = await rawUpgrade(main.base, '/api/ws', { 'Sec-WebSocket-Version': '8' })
      ok(badVer.status === 426, 'WebSocket 版本不支持 → 426', badVer.status)

      const noKey = await rawUpgrade(main.base, '/api/ws', { 'Sec-WebSocket-Key': '' })
      ok(noKey.status === 400, '缺 Sec-WebSocket-Key → 400', noKey.status)

      const okHs = await rawUpgrade(main.base, '/api/ws')
      ok(okHs.upgraded && okHs.status === 101, '合法握手 → 101', okHs.status)
      ok(
        okHs.headers['sec-websocket-accept'] === acceptKey('dGhlIHNhbXBsZSBub25jZQ=='),
        'Accept 值算对了'
      )

      // 同源校验：浏览器必发 Origin，非浏览器不发 —— 有 Origin 就必须在白名单里
      const evil = await rawUpgrade(hard.base, '/api/ws', { Origin: 'https://evil.example' })
      ok(evil.status === 403 && !evil.upgraded, 'Origin 不在白名单 → 403（挡恶意网页借用用户身份）', evil.status)
      const good = await rawUpgrade(hard.base, '/api/ws', { Origin: 'https://ok.example' })
      ok(good.upgraded, 'Origin 在白名单内 → 放行')
    }

    // 实时实例上的会话身份（与 [17] 同一个实例、同一份 SESSION_SECRET）
    const rtLogin = (code) => req(rt.base, 'POST', '/api/auth/wx', { code }).then((r) => r.data)
    const RT_A = await rtLogin('rt-code-A')
    const RT_B = await rtLogin('rt-code-B')
    /**
     * 实时实例请求。第 4 个参数既可以是会话令牌字符串（自动转成头），
     * 也可以直接是完整的头对象 —— 需要额外带 `X-Conn-Id` 的用例用后者。
     */
    const R = (m, p, b, sess) =>
      req(
        rt.base,
        m,
        p,
        b,
        sess ? (typeof sess === 'string' ? { 'X-Session-Token': sess } : sess) : undefined
      )

    {
      section('[18] 鉴权：首帧 hello 与共享密钥')
      // 没发 hello 就订阅 → 被拒（连接还没开口，什么都不能做）
      const c = await wsConnect(rt.base)
      c.send({ t: 'sub', ids: ['whatever'] })
      const errFrame = await c.next((m) => m.t === 'error', 2000, 'hello first')
      ok(errFrame.message === 'hello first', 'hello 之前不能订阅', errFrame)
      c.close()
      await sleep(100)

      // 首帧超时：600ms 内不发 hello 就被关掉（4001）
      const idle = await wsConnect(rt.base)
      const closed = await idle.waitClose(2500)
      ok(closed?.code === CLOSE.NO_AUTH, '建连后不发 hello 会被服务端关掉（4001）', closed)

      // 无效令牌不会让连接失败，只是「以匿名身份继续」——
      // 与 REST 侧「校验失败一律当匿名」保持同一口径，否则过期令牌会让整个功能不可用
      const anon = await wsLogin(rt.base, 'wxs_bogus.9999999999999.deadbeef')
      ok(anon.ready.authed === false, '无效令牌 → 按匿名连接（不直接踢下线）', anon.ready.authReason)
      ok(!('openid' in anon.ready), 'ready 帧里不带 openid（身份标识不出响应体）', Object.keys(anon.ready))
      anon.conn.close()

      // 共享密钥错 → 服务端先回 error 再关连接，且**不重连**（客户端侧行为，此处只验服务端）
      const badKey = await wsConnect(hard.base)
      badKey.hello('', { key: 'wrong-key' })
      const keyErr = await badKey.next((m) => m.t === 'error', 2000, 'unauthorized')
      ok(keyErr.message === 'unauthorized', '共享密钥不对 → error: unauthorized', keyErr)
      const keyClosed = await badKey.waitClose(2000)
      ok(keyClosed?.code === CLOSE.POLICY_VIOLATION, '鉴权失败用 1008 关闭（而不是静默断开）', keyClosed)

      // 正确密钥 → 通过
      const goodKey = await wsConnect(hard.base)
      goodKey.hello('', { key: TOKEN })
      const gk = await goodKey.next((m) => m.t === 'ready', 2000, 'ready')
      ok(gk.authed === false, '只有共享密钥（没有会话令牌）→ 能连上，但身份是匿名')
      goodKey.close()
    }

    {
      section('[18] 订阅授权：与 REST 写权限同一份口径')
      const T = 'smoke_rt_owned'
      const t0 = Date.now()
      const doc = {
        trip: {
          id: T,
          title: '实时用例',
          destination: '成都',
          startDate: '2026-10-01',
          endDate: '2026-10-03',
          currency: '¥',
          budget: 0,
          memberIds: [],
          createdAt: t0,
          updatedAt: t0
        },
        members: [],
        days: [],
        items: [],
        expenses: []
      }
      const created = await R('POST', `/api/trips/${T}`, { author: 'A', deviceId: 'devA', doc }, RT_A.token)
      ok(created.status === 200, 'A 建了一个有主空间', created.status)

      const a = await wsLogin(rt.base, RT_A.token)
      a.conn.send({ t: 'sub', ids: [T, 'nonexistent_space_id'] })
      const subA = await a.conn.next((m) => m.t === 'subscribed', 2000, 'subscribed')
      const accA = subA.accepted.find((s) => s.id === T)
      ok(!!accA, 'owner 能订阅自己的空间', subA)
      ok(accA?.rev === created.data.serverRev, '订阅响应带上服务端当前 rev（断线补偿就靠它）', accA?.rev)
      const ghost = subA.accepted.find((s) => s.id === 'nonexistent_space_id')
      ok(ghost?.exists === false, '尚不存在的空间也能订阅（可能是本机刚建、还没推上来的行程）', ghost)

      // 匿名订阅有主空间 → 拒
      const anon = await wsLogin(rt.base, '')
      anon.conn.send({ t: 'sub', ids: [T] })
      const subAnon = await anon.conn.next((m) => m.t === 'subscribed', 2000, 'subscribed')
      ok(
        subAnon.denied.some((d) => d.id === T && d.reason === 'anonymous-on-owned'),
        '匿名订阅有主空间被拒',
        subAnon.denied
      )
      ok(subAnon.accepted.length === 0, '被拒的订阅不会进 accepted', subAnon.accepted)

      // 另一个身份订阅 → 拒；凭码加入后 → 通过
      const b = await wsLogin(rt.base, RT_B.token)
      b.conn.send({ t: 'sub', ids: [T] })
      const subB1 = await b.conn.next((m) => m.t === 'subscribed', 2000, 'subscribed')
      ok(subB1.denied.some((d) => d.id === T && d.reason === 'not-member'), '非成员订阅被拒', subB1.denied)

      const code = created.data.space.code
      ok((await R('POST', '/api/trips/join', { code }, RT_B.token)).status === 200, 'B 凭分享码加入')
      b.conn.send({ t: 'sub', ids: [T] })
      const subB2 = await b.conn.next((m) => m.t === 'subscribed', 2000, 'subscribed')
      ok(subB2.accepted.some((s) => s.id === T), '加入后重新订阅成功', subB2)

      section('[18] 跨连接推送（本步的核心价值）')
      // A 侧再开一条连接充当「A 的第二个标签页」，用来验证「排除的是连接不是设备」
      const a2 = await wsLogin(rt.base, RT_A.token)
      a2.conn.send({ t: 'sub', ids: [T] })
      await a2.conn.next((m) => m.t === 'subscribed', 2000)

      // 先取 A 那条连接的服务端连接 id（ready 帧给的）
      const aReady = a.ready.conn
      ok(typeof aReady === 'string' && aReady.startsWith('ws-'), 'ready 帧返回连接 id', aReady)

      const before = created.data.serverRev
      /**
       * ⚠️ 时间戳必须**固定**在一次调用里，重复推送要用**同一个对象**。
       * 早先写成 `makeDoc(title, dt)` 每次现算 `Date.now() + dt`，
       * 于是「重复推送同一份快照」实际推的是两份 updatedAt 不同的快照 ——
       * 服务端判定 changed=true 是对的，是断言写错了。
       */
      const makeDoc = (title, dt) => ({
        ...doc,
        trip: { ...doc.trip, title, updatedAt: Date.now() + dt }
      })

      // 第一次推送**不带** X-Conn-Id：所有人都该收到（说明「没有人被误排除」）
      const firstPush = await R(
        'POST',
        `/api/trips/${T}`,
        { author: 'A', deviceId: 'devA', baseRev: before, doc: makeDoc('第一次改', 1000), tombstones: [] },
        RT_A.token
      )
      ok(firstPush.status === 200, '推送成功', firstPush.status)

      const selfEcho = await a.conn.next((m) => m.t === 'update' && m.id === T, 3000, 'update')
      ok(selfEcho.rev === firstPush.data.serverRev, '不带 X-Conn-Id 时发起者也会收到（没有人被误排除）', selfEcho)
      const bGot = await b.conn.next((m) => m.t === 'update' && m.id === T, 3000, 'update')
      ok(bGot.rev === firstPush.data.serverRev, 'B 收到了别人的改动通知 ★', bGot)
      ok(bGot.updatedBy === 'A', '通知里带上是谁改的', bGot.updatedBy)
      // A 的第二个标签页也收到了这一条（先消费掉，免得干扰下一条断言）
      const a2First = await a2.conn.next((m) => m.t === 'update' && m.id === T, 3000, 'update')
      ok(a2First.rev === firstPush.data.serverRev, '同设备的另一条连接同样收到', a2First)

      // 第二次推送带上 X-Conn-Id = A 第一条连接 → 它不该再收到，但 A 的第二个标签页要收到
      const docSecond = makeDoc('第二次改', 2000)
      const secondPush = await R(
        'POST',
        `/api/trips/${T}`,
        { author: 'A2', deviceId: 'devA', baseRev: null, doc: docSecond, tombstones: [] },
        { 'X-Session-Token': RT_A.token, 'X-Conn-Id': aReady }
      )
      ok(secondPush.status === 200, '第二次推送成功')
      const a2Got = await a2.conn.next(
        (m) => m.t === 'update' && m.id === T && m.rev === secondPush.data.serverRev,
        3000,
        'update'
      )
      ok(a2Got.rev === secondPush.data.serverRev, '同设备的**另一条连接**仍然收到 ★（排除的是连接不是设备）', a2Got)

      // 发起者自己的那条连接：等一小会儿，确认没有第二条 update
      await sleep(400)
      const echoCount = a.conn.count((m) => m.t === 'update' && m.id === T)
      ok(echoCount === 1, '发起者自己的连接只收到早先那一条（带 X-Conn-Id 的被排除了）', echoCount)

      // 幂等重投不广播：changed=false 的推送不该让所有人白拉一遍
      const a2Base = a2.conn.count((m) => m.t === 'update')
      const repeat = await R(
        'POST',
        `/api/trips/${T}`,
        { author: 'A2', deviceId: 'devA', baseRev: null, doc: docSecond, tombstones: [] },
        RT_A.token
      )
      ok(repeat.data.changed === false, '重复推送同一份快照：服务端判定没变化', repeat.data.applied)
      await sleep(1600)
      ok(
        a2.conn.count((m) => m.t === 'update') === a2Base,
        '没有变化的推送**不广播**（否则所有人白拉一遍）',
        { before: a2Base, after: a2.conn.count((m) => m.t === 'update') }
      )

      section('[18] 合并窗口：连续改动只发一条')
      const cBase = a2.conn.count((m) => m.t === 'update')
      // 三次连续推送。窗口 1200ms（本实例特意调大），所以必然合并成一条 ——
      // 断言写成「严格少于 3 条」会更稳，但那样即使完全没有合并也有可能通过，
      // 所以这里用「正好 1 条」来保证测的是合并而不是运气。
      for (const [i, title] of ['批量1', '批量2', '批量3'].entries()) {
        await R(
          'POST',
          `/api/trips/${T}`,
          { author: 'A2', deviceId: 'devA', baseRev: null, doc: makeDoc(title, 3000 + i * 10), tombstones: [] },
          RT_A.token
        )
      }
      await sleep(1700)
      const afterCount = a2.conn.count((m) => m.t === 'update')
      ok(afterCount - cBase === 1, '窗口内 3 次推送合并成 1 条通知', { delta: afterCount - cBase })
      const lastRev = (await R('GET', `/api/trips/${T}`, undefined, RT_A.token)).data.space.rev
      const lastUpdate = [...a2.conn.frames].reverse().find((m) => m.t === 'update')
      ok(lastUpdate?.rev === lastRev, '合并后带的是最终 rev（客户端据此拉到的就是最新快照）', {
        sent: lastUpdate?.rev,
        actual: lastRev
      })

      section('[18] 删除与权限变更的通知')
      const delBase = b.conn.count((m) => m.t === 'update')
      const del = await R('DELETE', `/api/trips/${T}`, undefined, RT_A.token)
      ok(del.status === 200, 'A 删除空间')
      const delFrame = await b.conn.next((m) => m.t === 'update' && m.deleted === true, 3000, 'deleted update')
      ok(delFrame.id === T && delFrame.deleted === true, '删除也会广播（否则别人一直留着一份已删行程）★', delFrame)
      ok(b.conn.count((m) => m.t === 'update') === delBase + 1, '删除只发一条通知', b.conn.count((m) => m.t === 'update'))

      // 认领：无主 → 有主，非成员的订阅必须被撤销
      const T2 = 'smoke_rt_orphan'
      const t2 = Date.now()
      const doc2 = { ...doc, trip: { ...doc.trip, id: T2, title: '无主', createdAt: t2, updatedAt: t2 } }
      const orphanPush = await R('POST', `/api/trips/${T2}`, { author: '匿名', deviceId: 'devO', doc: doc2 })
      ok(orphanPush.status === 200, '匿名建了一个无主空间')
      const orphanCode = orphanPush.data.space.code

      // 未登录的第三方订阅无主空间 → 允许（兼容口径）
      const outsider = await wsLogin(rt.base, '')
      outsider.conn.send({ t: 'sub', ids: [T2] })
      const subOut = await outsider.conn.next((m) => m.t === 'subscribed', 2000)
      ok(subOut.accepted.some((s) => s.id === T2), '无主空间对匿名也开放订阅（存量数据不该突然收不到更新）')

      const claim = await R('POST', `/api/trips/${T2}/claim`, { code: orphanCode }, RT_B.token)
      ok(claim.status === 200, 'B 认领了它')
      ok(claim.data.revokedSubscriptions === 1, '认领时踢掉了非成员的订阅 ★', claim.data.revokedSubscriptions)
      const revoked = await outsider.conn.next((m) => m.t === 'unsubscribed', 2000, 'unsubscribed')
      ok(revoked.reason === 'access-revoked', '被踢的连接收到 access-revoked（它不是被断网，是没权限了）', revoked)

      // 认领之后再改， outsider 不该再收到
      const outBase = outsider.conn.count((m) => m.t === 'update' && m.id === T2)
      await R(
        'POST',
        `/api/trips/${T2}`,
        {
          author: 'B',
          deviceId: 'devB',
          baseRev: null,
          doc: { ...doc2, trip: { ...doc2.trip, title: '认领后改的', updatedAt: Date.now() + 5000 } },
          tombstones: []
        },
        RT_B.token
      )
      // 等超过一个合并窗口（本实例 1200ms），确认**一条都没有**
      await sleep(1600)
      ok(
        outsider.conn.count((m) => m.t === 'update' && m.id === T2) === outBase,
        '被撤销订阅之后不再收到该空间的任何通知',
        outsider.conn.count((m) => m.t === 'update' && m.id === T2)
      )

      a.conn.close()
      a2.conn.close()
      b.conn.close()
      anon.conn.close()
      outsider.conn.close()
      await sleep(150)
    }

    {
      section('[18] 心跳与空闲判死')
      // 自动回 pong → 连接能长期保持。判死阈值是 2 个心跳周期 = 2000ms，
      // 所以「活着」这件事必须**观察超过 2000ms** 才算证明（早先只等 1200ms，
      // 那时候就算完全不回 pong 也还没到判死点，断言恒真 —— 等于没测）。
      const aliveConn = await wsConnect(rt.base, { autoPong: true })
      aliveConn.hello(RT_A.token)
      await aliveConn.next((m) => m.t === 'ready', 2000, 'ready')
      const ping = await aliveConn.next((m) => m.t === 'ping', 2500, 'ping')
      ok(typeof ping.ts === 'number', '服务端会主动发应用层心跳 {t:"ping"}', ping)
      await sleep(2600)
      ok(aliveConn.closed === null, '回了 pong 的连接不会因为超出判死阈值被断开 ★', aliveConn.closed)
      aliveConn.close()
      await sleep(100)

      // 不回 pong → 两个周期后被判死（半开连接不会一直占着 fd）
      const deadConn = await wsConnect(rt.base, { autoPong: false })
      deadConn.hello(RT_A.token)
      await deadConn.next((m) => m.t === 'ready', 2000, 'ready')
      const deadClosed = await deadConn.waitClose(5000)
      ok(deadClosed !== null, '不回心跳的连接会被判死并关闭（半开连接不会一直占着 fd）★', deadClosed)
      ok(deadClosed?.code === CLOSE.GOING_AWAY, '心跳超时用 1001（可重连）而不是协议错误', deadClosed)
    }

    {
      section('[18] 健康检查暴露实时统计')
      const h = await req(rt.base, 'GET', '/api/health')
      ok(h.data.realtime?.enabled === true, 'health 里有 realtime 段', Object.keys(h.data.realtime || {}))
      ok(h.data.realtime.path === '/api/ws', 'health 报告端点路径', h.data.realtime.path)
      ok(typeof h.data.realtime.notified === 'number' && h.data.realtime.notified > 0, '统计到已扇出的通知数', h.data.realtime.notified)
      ok(typeof h.data.realtime.connections === 'number', '统计当前连接数', h.data.realtime.connections)
      ok(h.data.realtime.pingMs === 1000, 'health 反映实际生效的心跳间隔（本实例被调成 1000）', h.data.realtime.pingMs)
      ok(h.data.realtime.coalesceMs === 1200, 'health 反映生效的合并窗口', h.data.realtime.coalesceMs)
      ok(
        h.data.realtime.maxSendBufferBytes === 1024 * 1024,
        'health 反映生效的发送缓冲上限（慢消费者保护已接线）',
        h.data.realtime.maxSendBufferBytes
      )

      // 关掉实时通道的实例：接口照常，只是不发通知
      const hMain = await req(main.base, 'GET', '/api/health')
      ok(hMain.data.realtime?.enabled === true, '主实例也开着实时通道')
      ok((await req(main.base, 'GET', '/api/ws')).status === 404, '实时端点是 upgrade-only，普通 GET 不被它接管', '')
    }
  }
} finally {
  for (const inst of [main, hard, ident, cred, rt]) {
    if (inst.child) inst.child.kill()
  }
  for (const c of extraChildren) {
    try {
      c.kill()
    } catch {
      /* 已经退出的进程 kill 会返回 false，无需处理 */
    }
  }
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====\n`)
process.exit(fail ? 1 : 0)
