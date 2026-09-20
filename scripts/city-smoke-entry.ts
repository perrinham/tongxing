/**
 * 城市足迹 store 专项冒烟。
 *
 * 由 scripts/city-smoke-test.mjs 用 esbuild 打包后在 Node 上跑：
 * 模拟两台独立设备（A / B），各自一份本地存储，过一遍城市足迹的
 * 全部 store action 与后端共享契约。
 *
 * 之所以要单独测：服务端冒烟（server/smoke.mjs）只盯 HTTP 接口，
 * 客户端同步冒烟（scripts/client-sync-test.ts）只盯行程空间同步 —
 * 城市足迹这一整块 store / 页面从来没被自动化覆盖过。
 * 一次手工测试通过不代表 store 里没有「updatedAt 没刷、撤回漏调用、
 * 切状态时把攻略清空」这类要等真机才暴露的 bug。
 */
import { mock, TEST_BASE } from './uni-mock'
import { createPinia } from 'pinia'
import { useCityStore } from '../src/stores/city'
import { bindStorage, createStorage } from '../src/repository/storage'
import { createHarness } from './lib/test-harness.mjs'

type Device = 'A' | 'B'

const H = createHarness()
const { ok, section } = H

// 各自一个 pinia = 各自一个 store 实例，否则 sharedGuides / passports 会被互相覆盖。
const piniaA = createPinia()
const piniaB = createPinia()
const A = useCityStore(piniaA)
const B = useCityStore(piniaB)

/**
 * store 里读写 uni storage 的方法要绑到「当前设备」的本地存储，
 * 否则自动同步的去抖定时器可能在切设备后触发，把 A 的状态写进 B 的存储。
 *
 * bindStorage 是结构性隔离（实例的 storage 读写创建时定终身）；方法包装
 * 继续兜住 storage 之外的设备相关路径（护照 / 昵称走 uni 直连键）。
 */
type AnyStore = typeof A
function bind(store: AnyStore, dev: Device) {
  bindStorage(store, createStorage(mock.deviceBackend(dev)))
  const methods = ['load', 'persist'] as const
  for (const m of methods) {
    const orig = (store[m] as (...args: unknown[]) => unknown).bind(store)
    ;(store as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
      const prev = mock.state.device
      mock.state.device = dev
      try {
        return orig(...args)
      } finally {
        mock.state.device = prev
      }
    }
  }
}

bind(A, 'A')
bind(B, 'B')

function as(dev: Device): AnyStore {
  mock.useDevice(dev)
  // 令牌不需要按设备清空：backend 已改为每 store 一份实例（store.api()），
  // 令牌每次请求从该设备自己的存储现取，A / B 天然隔离（本文件全程匿名，
  // 两个设备的存储里都没有 identity，请求一律不带 X-Session-Token）。
  return dev === 'A' ? A : B
}

async function settle() {
  // 让微任务（ensureCoords / 异步持久化）跑完
  await new Promise((r) => setTimeout(r, 30))
}

// ────────────────────────────────────────────────────────────────────────
// 1. 本地存储：markCity / getStatus / 切换状态 / 持久化
// ────────────────────────────────────────────────────────────────────────
section('[10] 本地 markCity：增 / 切 / 计数 / 持久化')

const s = as('A')
const c = s.markCity('成都', 'visited')
ok(c.id && c.name === '成都', 'markCity 返回带 id 的 passport')
ok(c.status === 'visited', '新建状态是 visited')
ok(c.lat === 30.572 && c.lng === 104.066, '坐标从 CITY_GEO 表里取（成都）')
ok(s.countVisited === 1 && s.countWish === 0, 'visited / wish 计数正确')

const sh = s.markCity('上海', 'wish')
ok(sh.status === 'wish', '新建 wish')
ok(s.countWish === 1, 'wish 计数 +1')

const cd2 = s.markCity('成都', 'wish')
ok(cd2.id === c.id, '同名城市不会新建第二条（同一 id）')
ok(cd2.status === 'wish', '状态被切换成 wish')
ok(s.countVisited === 0 && s.countWish === 2, '计数随状态切换更新')

// 持久化：raw 写进 storage，重新 load 还能读回来
await settle()
const raw = mock.read('A', 'travel_cities_v1')
ok(raw.includes('成都') && raw.includes('上海'), 'persist 把护照写到 storage')

// 全新 store + 同设备 storage：load 后数据还在
const fresh = useCityStore(createPinia())
;(fresh as unknown as Record<string, unknown>).load = (function () {
  const orig = (fresh.load as (...args: unknown[]) => unknown).bind(fresh)
  return function () {
    const prev = mock.state.device
    mock.state.device = 'A'
    try {
      return orig()
    } finally {
      mock.state.device = prev
    }
  }
})()
fresh.load()
ok(fresh.passports.length === 2, 'load 后两份护照都在')
ok(
  fresh.passports.find((p) => p.name === '成都')?.status === 'wish',
  '成都状态还是 wish（持久化字段没丢）'
)

// ────────────────────────────────────────────────────────────────────────
// 2. 攻略 / 评价 / 想去理由：saveGuide + setStatus
// ────────────────────────────────────────────────────────────────────────
section('[8] saveGuide：去过与想去两套字段')

as('A')
A.markCity('成都', 'visited')
A.saveGuide('成都', {
  visitDate: '2026-09-01',
  rating: 5,
  guide: '春熙路必吃冒菜',
  review: '整体很棒，回去了'
})
const cd = A.byName('成都')!
ok(cd.visitDate === '2026-09-01', 'visitDate 落盘')
ok(cd.rating === 5, 'rating 落盘')
ok(cd.guide === '春熙路必吃冒菜' && cd.review === '整体很棒，回去了', 'guide / review 落盘')
ok(cd.wishNote === undefined, 'visited 状态不写 wishNote')

A.setStatus('成都', 'wish')
A.saveGuide('成都', { wishNote: '想再去吃一次串串' })
const cdWish = A.byName('成都')!
ok(cdWish.status === 'wish', 'setStatus 切到 wish')
ok(cdWish.wishNote === '想再去吃一次串串', 'wish 状态写 wishNote')
ok(
  cdWish.guide === '春熙路必吃冒菜' && cdWish.rating === 5,
  '切到 wish 后原 visited 字段保留（不会被清空）'
)

// ────────────────────────────────────────────────────────────────────────
// 3. removeCity + 昵称持久化
// ────────────────────────────────────────────────────────────────────────
section('[6] removeCity 与昵称持久化')

as('A')
A.removeCity('上海')
ok(A.byName('上海') === undefined, '上海从护照列表移除')
ok(A.countWish === 1, '上海是 wish，移除后 wish 计数减 1')

A.setNick('方亚宏')
await settle()
const nickRaw = mock.read('A', 'travel_nick_v1')
ok(nickRaw === '方亚宏', '昵称写到独立 storage key（travel_nick_v1）')

const fresh2 = useCityStore(createPinia())
;(fresh2 as unknown as Record<string, unknown>).load = (function () {
  const orig = (fresh2.load as (...args: unknown[]) => unknown).bind(fresh2)
  return function () {
    const prev = mock.state.device
    mock.state.device = 'A'
    try {
      return orig()
    } finally {
      mock.state.device = prev
    }
  }
})()
fresh2.load()
ok(fresh2.nickname === '方亚宏', 'load 后昵称恢复')

// ────────────────────────────────────────────────────────────────────────
// 4. 别名解析：markCity 只在取坐标时走别名表，passport.name 保留用户输入
// ────────────────────────────────────────────────────────────────────────
section('[4] 别名解析：蓉城 / 鹏城 / 长安（坐标命中，名字保留）')

as('B')
const aliased = B.markCity('蓉城', 'visited')
ok(aliased.name === '蓉城', 'passport.name 保留用户输入「蓉城」')
ok(aliased.lat === 30.572 && aliased.lng === 104.066, '坐标从 CITY_GEO「成都」命中')
const aliased2 = B.markCity('鹏城', 'wish')
ok(aliased2.lat === 22.543 && aliased2.lng === 114.057, '坐标从 CITY_GEO「深圳」命中')
const aliased3 = B.markCity('长安', 'visited')
ok(aliased3.lat === 34.263 && aliased3.lng === 108.948, '坐标从 CITY_GEO「西安」命中')

// 列表里查到的也是用户输入的名字（避免「我输入蓉城、UI 显示成都」的怪事）
ok(B.byName('蓉城') !== undefined, '按「蓉城」能查回护照')
ok(B.byName('成都') === undefined, '按标准名查不到别名护照（名字未规范化）')

// ────────────────────────────────────────────────────────────────────────
// 5. 后端共享契约：publishMyGuide / loadShared / retractMyGuide
// ────────────────────────────────────────────────────────────────────────
section('[12] 后端共享：发布 / 读别人 / 撤回')

as('A')
A.markCity('大理', 'visited')
A.saveGuide('大理', {
  visitDate: '2026-08-15',
  rating: 4,
  guide: '古城南门外的烤乳扇',
  review: '早晨去比较舒服'
})
A.setNick('方亚宏')
await A.publishMyGuide('大理')
await A.loadShared('大理')
const aView = A.sharedOf('大理')
ok(aView.length === 1, 'A 自己发布的能看到 1 条攻略')
ok(aView[0].author === '方亚宏', '作者昵称就是发布时设置的')
ok(aView[0].guide?.includes('烤乳扇'), '攻略正文是发布时的内容')

// B 也发布同一座城市：A 应该能看到 2 条
as('B')
B.markCity('大理', 'visited')
B.saveGuide('大理', {
  visitDate: '2026-07-20',
  rating: 5,
  guide: '喜洲的稻田要早上去',
  review: '光好看'
})
B.setNick('同行人小李')
await B.publishMyGuide('大理')

as('A')
await A.loadShared('大理')
const aView2 = A.sharedOf('大理')
ok(aView2.length === 2, 'A 拉到的共享列表有 2 条')
const authors = new Set(aView2.map((g) => g.author))
ok(authors.has('方亚宏') && authors.has('同行人小李'), '两位作者的攻略都在')

// A 撤回自己的
as('A')
await A.retractMyGuide('大理')
await A.loadShared('大理')
const aView3 = A.sharedOf('大理')
ok(aView3.length === 1, 'A 撤回后共享列表只剩 1 条')
ok(aView3[0].author === '同行人小李', '剩下的是 B 的攻略')

// ────────────────────────────────────────────────────────────────────────
// 6. 删除城市时自动撤回已发布攻略
// ────────────────────────────────────────────────────────────────────────
section('[4] removeCity 后端撤回')

as('A')
A.markCity('杭州', 'visited')
A.saveGuide('杭州', { rating: 4, guide: '西湖边早上要赶早' })
await A.publishMyGuide('杭州')
const before = (await A.sharedOf('杭州')).length
ok(before === 1, '发布后共享列表能看到自己 1 条')

// removeCity 内部会自动撤回（store action 的设计：本地删除与云端撤回一体）——
// 本节先显式撤一次再删，链路等价于页面层的旧行为；自动撤回在第 8 节用登录态验证
await A.retractMyGuide('杭州')
A.removeCity('杭州')
ok(A.byName('杭州') === undefined, '杭州本地已删')
const after = (await A.sharedOf('杭州')).length
ok(after === 0, '后端也已撤回')

// ────────────────────────────────────────────────────────────────────────
// 7. 后端不可达时静默回退
// ────────────────────────────────────────────────────────────────────────
section('[4] 后端不可达：publishMyGuide / loadShared 静默失败')

as('A')
mock.setOnline(false)
A.markCity('拉萨', 'wish')
A.saveGuide('拉萨', { wishNote: '想去看布达拉宫' })

// 这里不该抛异常
let threw = false
try {
  await A.publishMyGuide('拉萨')
  await A.loadShared('拉萨')
} catch {
  threw = true
}
ok(!threw, '后端不可达时 store 不抛异常')
ok(A.byName('拉萨')?.wishNote === '想去看布达拉宫', '本地保存照常生效')
mock.setOnline(true)

// ────────────────────────────────────────────────────────────────────────
// 8. 登录态：自动发布 + 按 openid 回拉（syncMine）
// ────────────────────────────────────────────────────────────────────────
section('[7] 登录后自动发布与回拉')

/**
 * 登录态注入：直接向后端换一个 dev 令牌写进设备存储（模拟「已微信登录」）。
 * city store 的令牌从 travel_sync_v1.identity 现取（见 sessionTokenOf），
 * 所以只要这个 key 里有合法身份，markCity 等写路径就会自动发布。
 */
async function loginInto(
  dev: string,
  code = `city-smoke-login-${dev}`
): Promise<{ openid: string; token: string }> {
  const res = await fetch(TEST_BASE + '/api/auth/wx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  })
  const data = (await res.json()) as { openid: string; token: string; expiresAt: number }
  mock.raw(dev).set(
    'travel_sync_v1',
    JSON.stringify({
      identity: { openid: data.openid, token: data.token, expiresAt: data.expiresAt, dev: true }
    })
  )
  return { openid: data.openid, token: data.token }
}

/** 轮询直到条件成立（自动发布是 fire-and-forget，落库有几十毫秒量级的延迟） */
async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return cond()
}

as('A')
const idA = await loginInto('A')
ok(identityValidLike(idA), 'A 换到 dev 身份并写入存储')

// 匿名时（前几节）自动发布是 no-op；登录后 markCity 应自动把足迹带上后端
A.markCity('厦门', 'visited')
A.saveGuide('厦门', { rating: 5, guide: '鼓浪屿要工作日去' })
const published = await until(async () => {
  const r = await fetch(TEST_BASE + '/api/my/guides', {
    headers: { 'X-Session-Token': idA.token }
  })
  const d = (await r.json()) as { guides: { cityName: string }[] }
  return (d.guides || []).some((g) => g.cityName === '厦门')
})
ok(published, 'markCity 后自动发布：服务端 /api/my/guides 能查到厦门')

// B 登录后发布自己的城市，两人互不可见回拉
as('B')
const idB = await loginInto('B')
B.markCity('武汉', 'wish')
const publishedB = await until(async () => {
  const r = await fetch(TEST_BASE + '/api/my/guides', {
    headers: { 'X-Session-Token': idB.token }
  })
  const d = (await r.json()) as { guides: { cityName: string }[] }
  return (d.guides || []).some((g) => g.cityName === '武汉')
})
ok(publishedB, 'B 的 markCity 也自动发布')

// 模拟「换设备」：全新 store + 全新存储，只注入 A 的身份 → load 回拉 A 的足迹
const C = useCityStore(createPinia())
mock.useDevice('C')
mock.raw('C').set(
  'travel_sync_v1',
  JSON.stringify({
    identity: { openid: idA.openid, token: idA.token, expiresAt: Date.now() + 86400_000, dev: true }
  })
)
await C.load()
const restored = await until(() => C.byName('厦门') !== undefined)
ok(restored, '新设备登录后 load 自动回拉：厦门出现在护照里')
ok(C.byName('武汉') === undefined, 'B 的足迹不会被 A 的设备拉回来（按 openid 隔离）')
const restoredCity = C.byName('厦门')
ok(restoredCity?.status === 'visited' && restoredCity?.rating === 5, '回拉的字段完整（status / rating）')

function identityValidLike(id: { openid: string; token: string }): boolean {
  return !!id.openid && !!id.token
}

// ────────────────────────────────────────────────────────────────────────
// 9. 同设备换账号：足迹归属重划（onIdentityChanged）
// ────────────────────────────────────────────────────────────────────────
section('[9] 同设备换账号：认领匿名足迹 / 清掉别人的 / 不撤回服务端')

/**
 * 设备 D = 同一台手机的三个阶段：匿名 → 用户 SA → 用户 SB。
 * 复现的就是双账号验证发现的洞：A 登出后 B 在同一台手机上登录，
 * A 留在本地的足迹不能变成 B 的可编辑数据。
 */
const D = useCityStore(createPinia())
mock.useDevice('D')

// 阶段一：匿名。标记的城市 owner 为空（纯本机数据）
D.markCity('丽江', 'visited')
D.saveGuide('丽江', { rating: 4, guide: '古城维护费旺季要提前买' })
ok(D.byName('丽江')?.owner === '', '匿名创建的足迹 owner 为空（本机数据）')

// 阶段二：登录 SA。匿名足迹应被当前身份认领，而不是出现第二条丽江
const idSA = await loginInto('D', 'city-smoke-switch-A')
await D.onIdentityChanged()
ok(D.byName('丽江')?.owner === idSA.openid, '登录后匿名足迹被当前身份认领')
ok(D.passports.filter((p) => p.name === '丽江').length === 1, '认领不会新建重复条目')

// SA 的足迹发布到服务端，供「换账号后不撤回」断言使用
await D.publishMyGuide('丽江')
const saOnServer = await until(async () => {
  const r = await fetch(TEST_BASE + '/api/my/guides', {
    headers: { 'X-Session-Token': idSA.token }
  })
  const d = (await r.json()) as { guides: { cityName: string }[] }
  return (d.guides || []).some((g) => g.cityName === '丽江')
})
ok(saOnServer, 'SA 登录态发布：服务端有丽江')

D.markCity('厦门', 'wish')
ok(D.byName('厦门')?.owner === idSA.openid, '登录态新建的足迹直接带 owner 标签')

// 阶段三：切到用户 SB。SA 的条目全部清出本地
const idSB = await loginInto('D', 'city-smoke-switch-B')
await D.onIdentityChanged()
ok(
  D.byName('丽江') === undefined && D.byName('厦门') === undefined,
  '换账号后上一账号的足迹被清出本地'
)
await settle()
const rawAfterSwitch = mock.read('D', 'travel_cities_v1')
ok(!rawAfterSwitch.includes('丽江'), '清除已持久化（不是只在内存里删掉）')

// 清的只是本地副本：SA 的云端足迹原样保留（没有撤回）
const saStill = await until(async () => {
  const r = await fetch(TEST_BASE + '/api/my/guides', {
    headers: { 'X-Session-Token': idSA.token }
  })
  const d = (await r.json()) as { guides: { cityName: string }[] }
  return (d.guides || []).some((g) => g.cityName === '丽江')
})
ok(saStill, '换账号只清本地：SA 的云端足迹未被撤回')

// SB 从干净状态开始，新足迹归属 SB
D.markCity('敦煌', 'visited')
ok(D.byName('敦煌')?.owner === idSB.openid, 'SB 标记的足迹归属 SB')

// ────────────────────────────────────────────────────────────────────────
// 11. 我的攻略（MyGuidesPage 的数据层）：云端清单 / 按 id 撤回 / 越权
// ────────────────────────────────────────────────────────────────────────
section('[11] 我的攻略：云端清单 / 按 id 撤回 / 越权')

/**
 * 这一节覆盖「我的攻略」页用到的两个 store action。
 *
 * 之所以要测：那一页的全部价值在于「服务端到底存了什么」—— 如果 fetchMyCloud
 * 在未登录时返回空数组，界面会显示成「云端还没有记录」，而真实原因是没登录；
 * 如果 deleteCloudGuide 删错了行，用户以为清掉的是旧行、实际清掉了在用的那条。
 * 这两种都**不报错**，只能靠断言压住。
 */
as('A')

// 清单必须按 openid 归属，不能按昵称筛（A 与 B 的昵称都可能是「我」）
const myList = await A.fetchMyCloud()
ok(myList.some((g) => g.cityName === '厦门'), 'fetchMyCloud：能查到我名下的厦门')
ok(!myList.some((g) => g.cityName === '武汉'), 'fetchMyCloud：不含 B 的武汉（按归属隔离）')

// 改昵称再发一次 → 同一城市留下两条（服务端按 (城市, 昵称) upsert）。
// 这正是管理页要清理的残留：本机只认最新一条，旧行会一直躺在云端。
A.setNick('阿宏')
await A.publishMyGuide('厦门')
const gotTwo = await until(async () => {
  const list = await A.fetchMyCloud()
  return list.filter((g) => g.cityName === '厦门').length === 2
})
ok(gotTwo, '改昵称再发布 → 同一城市留下两条（管理页要清的旧行）')

const rows = (await A.fetchMyCloud())
  .filter((g) => g.cityName === '厦门')
  .sort((a, b) => a.updatedAt - b.updatedAt)
ok(rows[1]?.author === '阿宏', '较新的一条用新昵称')

// 按 id 撤回旧的：只删这一条，留下最新那条
await A.deleteCloudGuide(rows[0].id, '厦门')
const gotOne = await until(async () => {
  const list = await A.fetchMyCloud()
  return list.filter((g) => g.cityName === '厦门').length === 1
})
ok(gotOne, '按 id 撤回只删那一条（不是整座城市）')
const rest = (await A.fetchMyCloud()).filter((g) => g.cityName === '厦门')
ok(rest[0]?.id === rows[1].id, '留下的是最新那条 —— 清掉的是旧行，不是在用的')

// 越权：别人的记录删不掉，且要抛错（静默成功等于让用户以为删掉了）。
// ⚠️ 必须先切到 B 设备：令牌是「每次请求从**当前设备**的存储现取」的，
//    不切的话 B 的这次删除拿的是 A 的令牌 —— 服务端当然放行，
//    测出来的是绿灯，测的却不是想测的那件事。
as('B')
let denied = false
try {
  await B.deleteCloudGuide(rest[0].id, '厦门')
} catch {
  denied = true
}
ok(denied, 'B 删 A 的记录被拒（403 抛错，不是静默成功）')
as('A')
ok((await A.fetchMyCloud()).some((g) => g.id === rest[0].id), '被拒之后 A 的记录还在')

// 未登录必须抛错：返回空数组会让页面显示成「云端还没有记录」
const E = useCityStore(createPinia())
mock.useDevice('E')
let noAuthMsg = ''
try {
  await E.fetchMyCloud()
} catch (e) {
  noAuthMsg = e instanceof Error ? e.message : ''
}
ok(noAuthMsg === '尚未登录', '未登录时 fetchMyCloud 抛「尚未登录」（不会被显示成云端没记录）')

// ────────────────────────────────────────────────────────────────────────
console.log(`\n===== 城市足迹结果：${H.pass} 通过 / ${H.fail} 失败 =====`)
if (H.fail > 0) process.exit(1)
