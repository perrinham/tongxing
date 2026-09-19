/**
 * 生成一份演示数据，注入 localStorage，用于 UI 视觉走查。
 * 输出一段可直接交给浏览器 eval 的 JS。
 */
const now = Date.now()
const T = 'trip-cd-001'
const hlc = (t, c) => ({ t, c, n: 'a1b2c3d4' })

const members = [
  { id: 'm1', tripId: T, name: '我', colorIndex: 0, weight: 1, isSelf: true },
  { id: 'm2', tripId: T, name: '小林', colorIndex: 1, weight: 1 },
  { id: 'm3', tripId: T, name: '阿哲', colorIndex: 2, weight: 1 },
  { id: 'm4', tripId: T, name: '圆圆', colorIndex: 3, weight: 1 }
].map((m) => ({ ...m, updatedAt: now, hlc: hlc(now, 1) }))

const trip = {
  id: T,
  title: '成都三日 · 吃与走',
  destination: '成都',
  startDate: '2026-10-01',
  endDate: '2026-10-03',
  currency: 'CNY',
  budget: 2400,
  memberIds: members.map((m) => m.id),
  createdAt: now - 86400000 * 3,
  updatedAt: now,
  hlc: hlc(now, 1)
}

const days = [
  { id: 'd1', tripId: T, date: '2026-10-01', index: 0, title: '到达 · 老城区', note: '落地先放行李，下午慢慢逛' },
  { id: 'd2', tripId: T, date: '2026-10-02', index: 1, title: '熊猫 · 城南', note: '' },
  { id: 'd3', tripId: T, date: '2026-10-03', index: 2, title: '收尾 · 返程', note: '下午的飞机' }
].map((d) => ({ ...d, updatedAt: now, hlc: hlc(now, 1) }))

const items = [
  ['d1', '09:40', 'transport', '双流机场 T2 → 春熙路', '地铁 10 号线转 3 号线', 8, 60, '机场大巴也行', false],
  ['d1', '12:30', 'food', '陈麻婆豆腐（骡马市店）', '青羊区西玉龙街', 65, 75, '排队大概 20 分钟', true],
  ['d1', '14:30', 'spot', '宽窄巷子', '青羊区金河路', 0, 120, '井巷子人少', true],
  ['d1', '19:00', 'food', '玉林串串香', '武侯区玉林南路', 88, 90, '', false],
  ['d2', '08:00', 'spot', '成都大熊猫繁育研究基地', '成华区熊猫大道 1375 号', 55, 210, '开园就进，先看月亮产房', false],
  ['d2', '13:00', 'food', '明婷饭店', '成华区双林路', 72, 60, '脑花豆腐必点', false],
  ['d2', '15:30', 'spot', '东郊记忆', '成华区建设南支路', 0, 120, '', false],
  ['d2', '20:00', 'spot', '九眼桥 · 锦江夜游', '锦江区滨江东路', 100, 90, '船票提前买', false],
  ['d3', '10:00', 'spot', '武侯祠 · 锦里', '武侯区武侯祠大街 231 号', 50, 150, '', false],
  ['d3', '13:30', 'food', '钟水饺（总府路店）', '锦江区总府路', 45, 45, '带点兔头回去', false],
  ['d3', '16:00', 'transport', '春熙路 → 双流机场 T2', '打车约 45 分钟', 95, 60, '', false]
].map((r, i) => ({
  id: 'i' + (i + 1),
  dayId: r[0],
  tripId: T,
  order: i,
  time: r[1],
  type: r[2],
  title: r[3],
  address: r[4],
  lat: 30.65 + i * 0.004,
  lng: 104.06 + i * 0.005,
  cost: r[5],
  duration: r[6],
  note: r[7],
  done: r[8],
  updatedAt: now,
  hlc: hlc(now, 1)
}))

const expenses = [
  ['机票（4 人）', 3280, 'transport', '2026-10-01', 'm1', 4, '双流往返'],
  ['民宿两晚', 1560, 'stay', '2026-10-01', 'm2', 4, '春熙路附近'],
  ['陈麻婆豆腐', 268, 'food', '2026-10-01', 'm1', 4, ''],
  ['串串香', 352, 'food', '2026-10-01', 'm3', 4, '含酒水'],
  ['熊猫基地门票', 220, 'ticket', '2026-10-02', 'm2', 4, '55 × 4'],
  ['打车（两天）', 386, 'transport', '2026-10-02', 'm1', 4, ''],
  ['锦江夜游船票', 400, 'entertain', '2026-10-02', 'm4', 4, '100 × 4'],
  ['明婷饭店', 288, 'food', '2026-10-02', 'm3', 4, ''],
  ['武侯祠门票', 200, 'ticket', '2026-10-03', 'm1', 4, '50 × 4'],
  ['伴手礼', 634, 'shopping', '2026-10-03', 'm4', 3, '兔头 + 茶叶']
].map((r, i) => ({
  id: 'e' + (i + 1),
  tripId: T,
  title: r[0],
  amount: r[1],
  category: r[2],
  date: r[3],
  payerId: r[4],
  participants: members.slice(0, r[5]).map((m) => ({ memberId: m.id, share: 0 })),
  splitMode: 'even',
  note: r[6],
  createdAt: now - i * 3600000,
  updatedAt: now,
  hlc: hlc(now, 1)
}))

const state = {
  version: 1,
  trips: [trip],
  members,
  days,
  items,
  expenses,
  activeTripId: T
}

const meta = {
  deviceId: 'seed-device',
  author: '我',
  lastSyncAt: now,
  lastStatus: 'idle',
  lastError: '',
  revOf: {},
  localAtOf: {},
  syncedAtOf: {},
  codes: { [T]: 'CD2026' },
  tombstones: [],
  hlc: hlc(now, 1),
  identity: null
}

// 关键：store 的 write() 存的是 JSON 字符串，所以这里也必须存字符串。
console.log(
  `localStorage.setItem('travel_h5_state_v1', ${JSON.stringify(JSON.stringify(state))});` +
    `localStorage.setItem('travel_sync_v1', ${JSON.stringify(JSON.stringify(meta))});` +
    `console.log('seeded', document.title)`
)
